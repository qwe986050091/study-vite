// ============================================================================
// 依赖预构建的「运行时调度器」。
// 分工：./index.ts 负责「怎么打包、缓存与 hash 长什么样」；
// 本文件负责「什么时候打包、发现新依赖怎么办、结果何时提交给浏览器、
// 要不要整页刷新」。两者通过 DepsOptimizer 对象与 DepOptimizationResult 交互。
// 一次 dev 启动的状态流转：
//   createDepsOptimizer()  初始化空 metadata（idle）
//     -> init()            loadCachedDepOptimizationMetadata()
//         命中：firstRunCalled=true，直接进入「已初始化」；
//         未命中：把 optimizeDeps.include 写入 discovered，启动后台扫描，
//                 扫描完成后 runOptimizeDeps 并把结果「扣住」等爬取结束。
//     -> onCrawlEnd()      首屏静态导入爬完，决定提交、丢弃重跑、还是等待。
//     -> registerMissingImport()  运行期发现新依赖 -> 去重 -> debounce -> runOptimizer 全量重打包。
// 两个最容易读错的不变量：
//   1. 打包结果是延迟提交的：runOptimizeDeps 只写临时目录，commit 才会覆盖正式目录；
//      若期间又发现新依赖，就先 cancel 掉这轮，避免「刚刷新又立刻刷新」。
//   2. 「是否需要整页刷新」只看 metadata.hash 与各依赖 fileHash 是否变化，
//      不变时会刻意复用旧 browserHash，让浏览器继续用已缓存的 URL。
// Vite 8 说明：这里的打包器是 rolldown（./index.ts 内），本文件不再有
// esbuild 专有逻辑；registerMissingImport 的职责与旧版一致，没有 esbuild/rolldown 分叉。
// ============================================================================
import colors from 'picocolors'
import {
  type PromiseWithResolvers,
  promiseWithResolvers,
} from '../../shared/utils'
import type { DevEnvironment } from '../server/environment'
import { createDebugger, getHash } from '../utils'
import { devToScanEnvironment } from './scan'
import {
  addManuallyIncludedOptimizeDeps,
  addOptimizedDepInfo,
  createIsOptimizedDepFile,
  createIsOptimizedDepUrl,
  depsFromOptimizedDepInfo,
  depsLogString,
  discoverProjectDependencies,
  extractExportsData,
  getOptimizedDepPath,
  initDepsOptimizerMetadata,
  loadCachedDepOptimizationMetadata,
  optimizeExplicitEnvironmentDeps,
  runOptimizeDeps,
  toDiscoveredDependencies,
} from './index'
import type {
  DepOptimizationMetadata,
  DepOptimizationResult,
  DepsOptimizer,
  OptimizedDepInfo,
} from './index'

const debug = createDebugger('vite:deps')

/**
 * The amount to wait for requests to register newly found dependencies before triggering
 * a re-bundle + page reload
 */
// 100ms 是「合并同一批发现」的窗口：浏览器并发请求多个模块时，
// 往往会连续暴露出多个未预构建的依赖，合并成一次重打包可避免多次全量构建。
const debounceMs = 100

// 作用：为某个 DevEnvironment 创建 DepsOptimizer，并闭包持有本次 dev 会话的全部调度状态。
// 调用点：server/environment.ts Environment 构造函数（!noDiscovery 时选择本工厂）。
// 关键参数：environment 决定配置、缓存目录、logger、moduleGraph 与 hot 通道。
// 返回：实现了 init / registerMissingImport / run / close 等方法的对象，
//   会被挂到 environment.depsOptimizer 上供 resolve/importAnalysis 等插件使用。
// 失败模式：工厂本身不抛错；真正的 IO 与打包错误发生在 init() 与后续 re-run 中，
//   前者冒泡到 server.listen()，后者只记录日志并清空 discovered（见 runOptimizer 的 catch）。
export function createDepsOptimizer(
  environment: DevEnvironment,
): DepsOptimizer {
  const { logger } = environment
  // 每个 dev 进程一个时间戳，混入 browserHash：即使磁盘缓存完全命中，
  // 新进程也会得到新的 ?v= 值，浏览器不会复用上一个进程的旧响应。
  const sessionTimestamp = Date.now().toString()

  let debounceProcessingHandle: NodeJS.Timeout | undefined

  // 关闭标记：close() 之后所有延迟回调、扫描结果、打包结果都必须短路，
  // 否则 server 关闭后仍可能触发 commit，写出脏缓存或抛未捕获错误。
  let closed = false

  const options = environment.config.optimizeDeps

  // 这两个开关决定 init/onCrawlEnd 走哪条策略，闭包内多处读取，因此提前解构。
  // noDiscovery：不扫描、不等待爬取，只打包 include；
  // holdUntilCrawlEnd：扫描结果先扣住，等首屏静态导入爬完再决定是否交给浏览器。
  const { noDiscovery, holdUntilCrawlEnd } = options

  // 注意这里先构造一份「空 metadata」：在 init() 之前就可能有模块被转换并调用
  // registerMissingImport（见该方法里的 initState 守卫），此时需要一张可用的表。
  let metadata: DepOptimizationMetadata = initDepsOptimizerMetadata(
    environment,
    sessionTimestamp,
  )

  // 对外暴露的接口对象。注意 getOptimizedDepId 把 ?v=browserHash 拼在 file 后，
  // 这是浏览器 URL 失效机制的源头（optimizedDeps.ts 会解析这个 v 值）。
  const depsOptimizer: DepsOptimizer = {
    init,
    initState: 'idle',
    metadata,
    registerMissingImport,
    run: () => debouncedProcessing(0),
    isOptimizedDepFile: createIsOptimizedDepFile(environment),
    isOptimizedDepUrl: createIsOptimizedDepUrl(environment),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,
    close,
    options,
  }

  // 「自上次 startNextDiscoveredBatch 以来是否发现过新依赖」。
  // 它决定重打包结果到达时：是直接提交并刷新（false），还是先 cancel 等下一轮（true）。
  let newDepsDiscovered = false

  // 新发现依赖的日志聚合：多个依赖可能在 200ms 内陆续发现，
  // 用 newDepsToLog + 定时器合并成一行输出，避免刷屏。
  let newDepsToLog: string[] = []
  let newDepsToLogHandle: NodeJS.Timeout | undefined
  const logNewlyDiscoveredDeps = () => {
    if (newDepsToLog.length) {
      const dependencyLabel =
        newDepsToLog.length === 1 ? 'dependency' : 'dependencies'
      logger.info(
        colors.green(
          `${dependencyLabel} optimized: ${depsLogString(newDepsToLog)}`,
        ),
        {
          timestamp: true,
        },
      )
      newDepsToLog = []
    }
  }

  // 扫描器没找到、但 optimizeDeps.include 里有的依赖；仅用于在合适时机
  // 提示用户「把这些写进 include 可以加快冷启动」。
  let discoveredDepsWhileScanning: string[] = []
  const logOptimizeDepsIncludeSuggestion = (reason: string) => {
    if (discoveredDepsWhileScanning.length) {
      logger.info(
        colors.magenta(
          `tip: consider adding ${depsLogString(
            discoveredDepsWhileScanning,
          )} to optimizeDeps.include to ${reason}`,
        ) +
          colors.dim(
            `\n  See https://vite.dev/guide/dep-pre-bundling.html#customizing-the-behavior`,
          ),
        {
          timestamp: true,
        },
      )
      discoveredDepsWhileScanning = []
    }
  }

  // processing 队列：每个 discovered 依赖都持有一个 promise，
  // 浏览器请求该依赖时要 await 它。队列的存在是为了「延迟决议」——
  // 只有一轮重打包真正 commit 后才 resolve 对应批次，cancel 的批次永远不 resolve，
  // 因此旧请求会一直等到整页刷新把它丢弃（表现为 504）。
  let depOptimizationProcessing = promiseWithResolvers<void>()
  let depOptimizationProcessingQueue: PromiseWithResolvers<void>[] = []
  const resolveEnqueuedProcessingPromises = () => {
    // Resolve all the processings (including the ones which were delayed)
    // 注意这里一次性 resolve 全部历史批次，而不是只 resolve 当前批次：
    // commit 后所有等待者都应被放行去读文件，文件此时已就位。
    for (const processing of depOptimizationProcessingQueue) {
      processing.resolve()
    }
    depOptimizationProcessingQueue = []
  }

  // 当前正在执行的 rerun 函数；它在 runOptimizer 结束时被取出调用，
  // 保证「打包期间新排队的 rerun」不会并发执行，而是串行接上。
  let enqueuedRerun: (() => void) | undefined
  // 是否有一次 runOptimizer 正在 await 打包结果；debounce 定时器据此决定
  // 是立刻执行还是等这一轮结束（见 debouncedProcessing）。
  let currentlyProcessing = false

  // 是否已经完成过至少一次 optimize（含从缓存恢复）。rerun 时用它决定日志措辞，
  // 更关键的是：第一次 run 的结果要参与 onCrawlEnd 的合并判断。
  let firstRunCalled = false
  // 首屏爬取阶段漏掉了依赖，onCrawlEnd 时给出 include 建议。
  let warnAboutMissedDependencies = false

  // If this is a cold run, we wait for static imports discovered
  // from the first request before resolving to minimize full page reloads.
  // On warm start or after the first optimization is run, we use a simpler
  // debounce strategy each time a new dep is discovered.
  // 为 true 时 registerMissingImport 不会触发重打包：此时首屏请求还在爬，
  // 提前打包只会得到不完整依赖集，反而导致后续整页刷新。
  let waitingForCrawlEnd = false

  // 正在进行的「扫描后打包」结果（handOff）。onCrawlEnd 与 scan 完成回调
  // 都会争夺它：谁先取到并置 undefined，谁就负责决定提交还是取消。
  let optimizationResult:
    | {
        cancel: () => Promise<void>
        result: Promise<DepOptimizationResult>
      }
    | undefined

  // 正在进行的依赖扫描句柄，close() 需要 cancel 它，避免关闭后扫描仍在跑。
  let discover:
    | {
        cancel: () => Promise<void>
        result: Promise<Record<string, string>>
      }
    | undefined

  // 作用：关闭本环境的优化器，取消所有在途任务并放行挂起的请求。
  // 调用点：DevEnvironment.close()（server 关闭 / 环境重建时）。
  // 关键参数：无。
  // 顺序敏感：先置 closed 再 clearTimeout，最后才等待取消；
  //   否则取消过程中触发的回调可能又排入新的 rerun。
  // 失败模式：使用 allSettled，任一取消失败都不会阻碍关闭；
  //   最后无条件 resolve processing，避免浏览器请求永久挂起。
  async function close() {
    closed = true

    // Ensure that a rerun will not be issued
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)
    debounceProcessingHandle = undefined

    await Promise.allSettled([
      discover?.cancel(),
      depsOptimizer.scanProcessing,
      optimizationResult?.cancel(),
    ])

    depOptimizationProcessing.resolve()
    resolveEnqueuedProcessingPromises()
  }

  // 作用：初始化优化器——读缓存（命中即结束），否则收集 include、启动扫描并触发首轮打包。
  // 调用点：DevEnvironment.listen()（server/environment.ts 中 `depsOptimizer?.init()`）。
  // 关键参数：无；依赖闭包里的 environment/sessionTimestamp/options。
  // 状态：进入时 idle -> initializing -> initialized；initializing 期间 registerMissingImport
  //   不会触发打包，避免与这里的 metadata 重置竞争。
  // 失败模式：loadCachedDepOptimizationMetadata 的 IO 异常会 reject 并中断 server 启动；
  //   扫描失败只记日志（跳过预构建）；扫描/打包期间抛出的异常在 IIFE 的 catch 里记日志，
  //   不会让 listen() 失败。
  async function init() {
    if (depsOptimizer.initState !== 'idle') return
    depsOptimizer.initState = 'initializing'

    const cachedMetadata = await loadCachedDepOptimizationMetadata(environment)

    // 命中缓存等价于「已经跑过首轮」：之后发现新依赖可以直接 debounce 重打包，
    // 不需要再等首屏爬取结束。
    firstRunCalled = !!cachedMetadata

    metadata = depsOptimizer.metadata =
      cachedMetadata || initDepsOptimizerMetadata(environment, sessionTimestamp)

    if (!cachedMetadata) {
      // 冷启动：先进入 waitingForCrawlEnd + currentlyProcessing，
      // 这两个状态共同抑制 registerMissingImport 触发重打包。
      waitingForCrawlEnd = true

      // Enter processing state until crawl of static imports ends
      currentlyProcessing = true

      // Initialize discovered deps with manually added optimizeDeps.include info

      // 手动 include 先写入 discovered，保证即使扫描器漏掉它们也会被首轮打包。
      const manuallyIncludedDeps: Record<string, string> = {}
      await addManuallyIncludedOptimizeDeps(environment, manuallyIncludedDeps)

      const manuallyIncludedDepsInfo = toDiscoveredDependencies(
        environment,
        manuallyIncludedDeps,
        sessionTimestamp,
      )

      for (const depInfo of Object.values(manuallyIncludedDepsInfo)) {
        // 挂上当前批次的 processing promise：在这些依赖打包完成前，
        // 浏览器对它们的请求会停在这里等待。
        addOptimizedDepInfo(metadata, 'discovered', {
          ...depInfo,
          processing: depOptimizationProcessing.promise,
        })
        newDepsDiscovered = true
      }

      // waitForRequestsIdle 在「首屏请求触发的一轮模块转换结束」后 resolve，
      // 也就是静态导入爬完；onCrawlEnd 必须在扫描结果与爬取结果之间做仲裁。
      environment.waitForRequestsIdle().then(onCrawlEnd)

      if (noDiscovery) {
        // We don't need to scan for dependencies or wait for the static crawl to end
        // Run the first optimization run immediately
        // noDiscovery 下没有扫描结果可等，直接打包 include（可能为空）。
        runOptimizer()
      } else {
        // Important, the scanner is dev only
        // scanProcessing 是对外可见的「扫描是否结束」信号，
        // resolve.ts 的 tryOptimizedResolve 与 importAnalysis 都会 await 它。
        depsOptimizer.scanProcessing = new Promise((resolve) => {
          // Runs in the background in case blocking high priority tasks
          ;(async () => {
            try {
              debug?.(colors.green(`scanning for dependencies...`))

              // 扫描超过 1s 才提示，避免小项目日志噪音。
              const scanTimer = setTimeout(() => {
                logger.info('[optimizer] scanning dependencies...', {
                  timestamp: true,
                })
              }, 1000)

              let deps: Record<string, string>
              try {
                // devToScanEnvironment 把 DevEnvironment 降级成只读 ScanEnvironment，
                // 防止扫描阶段的插件访问 moduleGraph/热更新状态造成死锁。
                discover = discoverProjectDependencies(
                  devToScanEnvironment(environment),
                )
                deps = await discover.result
                discover = undefined
              } catch (e) {
                // 扫描失败是可降级的：不预构建，让浏览器直接加载源码。
                environment.logger.error(
                  colors.red(
                    '(!) Failed to run dependency scan. ' +
                      'Skipping dependency pre-bundling. ' +
                      e.stack,
                  ),
                )
                return
              } finally {
                clearTimeout(scanTimer)
              }

              // 记录「已发现但扫描器没找到」的依赖，供后续提示加入 include。
              const manuallyIncluded = Object.keys(manuallyIncludedDepsInfo)
              discoveredDepsWhileScanning.push(
                ...Object.keys(metadata.discovered).filter(
                  (dep) => !deps[dep] && !manuallyIncluded.includes(dep),
                ),
              )

              // Add these dependencies to the discovered list, as these are currently
              // used by the preAliasPlugin to support aliased and optimized deps.
              // This is also used by the CJS externalization heuristics in legacy mode
              // 新增的依赖走 addMissingDep：会分配 browserHash、processing promise
              // 并立即开始解析导出信息。
              for (const id of Object.keys(deps)) {
                if (!metadata.discovered[id]) {
                  addMissingDep(id, deps[id])
                }
              }

              // knownDeps = 旧 optimized + 全部 discovered 的快照（去掉 processing）。
              // 必须先拍快照再 startNextDiscoveredBatch，否则本轮新发现的依赖
              // 会被算进下一批，导致首次打包漏依赖。
              const knownDeps = prepareKnownDeps()
              startNextDiscoveredBatch()

              // For dev, we run the scanner and the first optimization
              // run on the background
              optimizationResult = runOptimizeDeps(environment, knownDeps)

              // If the holdUntilCrawlEnd strategy is used, we wait until crawling has
              // ended to decide if we send this result to the browser or we need to
              // do another optimize step
              if (!holdUntilCrawlEnd) {
                // If not, we release the result to the browser as soon as the scanner
                // is done. If the scanner missed any dependency, and a new dependency
                // is discovered while crawling static imports, then there will be a
                // full-page reload if new common chunks are generated between the old
                // and new optimized deps.
                // 注意这是「扫描一结束就放行」的激进策略：
                // 若爬取阶段又发现依赖，就只能靠 fullReload 兜底，而不是先合并。
                optimizationResult.result.then((result) => {
                  // Check if the crawling of static imports has already finished. In that
                  // case, the result is handled by the onCrawlEnd callback
                  if (!waitingForCrawlEnd) return

                  optimizationResult = undefined // signal that we'll be using the result

                  runOptimizer(result)
                })
              }
            } catch (e) {
              logger.error(e.stack || e.message)
            } finally {
              // 无论成功失败都要 resolve scanProcessing，否则 resolve 侧会永久等待。
              resolve()
              depsOptimizer.scanProcessing = undefined
            }
          })()
        })
      }
    }
    depsOptimizer.initState = 'initialized'
  }

  // 作用：结束当前 discovered 批次，为下一批新依赖换一个新的 processing promise。
  // 调用点：init() 扫描成功后、runOptimizer() 的现场打包分支（未传 preRunResult 时）、
  //   onCrawlEnd() 交接扫描结果前。
  // 关键参数：无。
  // 为什么必须成对：旧批次 promise 只有在该批次结果被 commit 时才 resolve；
  //   若继续复用同一个 promise，新依赖会被错误地绑定到「上一轮」的决议上。
  //   newDepsDiscovered 同时清零，表示「从现在起的新发现才算下一批」。
  function startNextDiscoveredBatch() {
    newDepsDiscovered = false

    // Add the current depOptimizationProcessing to the queue, these
    // promises are going to be resolved once a rerun is committed
    depOptimizationProcessingQueue.push(depOptimizationProcessing)

    // Create a new promise for the next rerun, discovered missing
    // dependencies will be assigned this promise from this point
    depOptimizationProcessing = promiseWithResolvers()
  }

  // 作用：把「已优化 + 已发现」的依赖合并成下一次打包的输入快照。
  // 调用点：init() 扫描后、runOptimizer() 的 rerun 分支。
  // 关键参数：无；读取 depsOptimizer.metadata。
  // 关键细节：
  //   - optimized 条目整个浅拷贝：打包过程中会改写其 fileHash/browserHash，
  //     不能直接引用旧对象，否则失败回滚时会污染当前 metadata；
  //   - discovered 条目丢掉 processing，只保留 id/file/src/browserHash/exportsData，
  //     避免把上一批的 promise 带进新一批。
  // 失败模式：metadata 为 undefined 时非空断言会抛错（正常流程不会发生）。
  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {}
    // Clone optimized info objects, fileHash, browserHash may be changed for them
    const metadata = depsOptimizer.metadata!
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] }
    }
    for (const dep of Object.keys(metadata.discovered)) {
      // Clone the discovered info discarding its processing promise
      const { processing, ...info } = metadata.discovered[dep]
      knownDeps[dep] = info
    }
    return knownDeps
  }

  // 作用：执行一次（首次或 re-run）预打包并决定如何处置结果：提交、延迟、取消、刷新。
  // 调用点：init() 的 noDiscovery 分支与扫描完成回调、onCrawlEnd()、rerun()（经 debouncedProcessing）。
  // 关键参数：preRunResult 是「已经打好的结果」（onCrawlEnd 把扫描结果交接过来），
  //   传入时直接复用，避免重复构建；不传则现场 prepareKnownDeps + runOptimizeDeps。
  // 失败模式：打包异常被外层 catch 捕获，仅记录日志并清空 metadata.discovered，
  //   让后续请求重新触发发现，不会让 server 崩溃。
  // 并发保证：入口先清 enqueuedRerun 并置 currentlyProcessing，
  //   打包期间新的 rerun 只会缓存到 enqueuedRerun，结束后再串行执行。
  async function runOptimizer(preRunResult?: DepOptimizationResult) {
    // a successful completion of the optimizeDeps rerun will end up
    // creating new bundled version of all current and discovered deps
    // in the cache dir and a new metadata info object assigned
    // to _metadata. A fullReload is only issued if the previous bundled
    // dependencies have changed.

    // if the rerun fails, _metadata remains untouched, current discovered
    // deps are cleaned, and a fullReload is issued

    // All deps, previous known and newly discovered are rebundled,
    // respect insertion order to keep the metadata file stable

    // isRerun 只用于日志与 newDepsToLog 统计：首次运行不需要报「新增依赖」。
    const isRerun = firstRunCalled
    firstRunCalled = true

    // Ensure that rerun is called sequentially
    enqueuedRerun = undefined

    // Ensure that a rerun will not be issued for current discovered deps
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)

    if (closed) {
      currentlyProcessing = false
      return
    }
    currentlyProcessing = true

    try {
      let processingResult: DepOptimizationResult
      if (preRunResult) {
        // 复用已完成的打包结果（onCrawlEnd 路径）：这里不能再 prepareKnownDeps，
        // 否则会用当前 metadata 重新打包，丢掉扫描阶段已经算好的产物。
        processingResult = preRunResult
      } else {
        const knownDeps = prepareKnownDeps()
        startNextDiscoveredBatch()

        optimizationResult = runOptimizeDeps(environment, knownDeps)
        processingResult = await optimizationResult.result
        optimizationResult = undefined
      }

      if (closed) {
        // 打包期间 server 被关闭：产物不能提交，直接 cancel 临时目录。
        currentlyProcessing = false
        processingResult.cancel()
        return
      }

      const newData = processingResult.metadata

      // interop 判定不一致说明某个依赖的导出形状在两次打包间变了
      // （典型是混合 ESM/CJS 的包），浏览器已缓存的具名导入会失效。
      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        newData.optimized,
      )

      // After a re-optimization, if the internal bundled chunks change a full page reload
      // is required. If the files are stable, we can avoid the reload that is expensive
      // for large applications. Comparing their fileHash we can find out if it is safe to
      // keep the current browser state.
      // 三个条件任一成立就要刷新：interop 变化、整体 hash 变化、任一依赖的 fileHash 变化。
      // 只看 fileHash 不够：hash 变化意味着所有产物的内容/路径版本都变了。
      const needsReload =
        needsInteropMismatch.length > 0 ||
        metadata.hash !== newData.hash ||
        Object.keys(metadata.optimized).some((dep) => {
          return (
            metadata.optimized[dep].fileHash !== newData.optimized[dep].fileHash
          )
        })

      // 提取成函数是因为「不刷新」和「刷新」两条路径都要调用，且必须 await 完
      // 才更新 depsOptimizer.metadata（见函数末尾）。
      const commitProcessing = async () => {
        await processingResult.commit()

        // While optimizeDeps is running, new missing deps may be discovered,
        // in which case they will keep being added to metadata.discovered
        // 打包期间新发现的依赖不能丢：它们不在 newData.optimized 里，
        // 需要从旧 metadata.discovered 搬进 newData，供下一轮处理。
        for (const id in metadata.discovered) {
          if (!newData.optimized[id]) {
            addOptimizedDepInfo(newData, 'discovered', metadata.discovered[id])
          }
        }

        // If we don't reload the page, we need to keep browserHash stable
        // 这是「避免整页刷新」的核心：即使重新打包产生了新的 metadata，
        // 也把 browserHash 改回旧值，让浏览器 URL 与已缓存响应继续有效。
        if (!needsReload) {
          newData.browserHash = metadata.browserHash
          for (const dep in newData.chunks) {
            newData.chunks[dep].browserHash = metadata.browserHash
          }
          for (const dep in newData.optimized) {
            newData.optimized[dep].browserHash = (
              metadata.optimized[dep] || metadata.discovered[dep]
            ).browserHash
          }
        }

        // Commit hash and needsInterop changes to the discovered deps info
        // object. Allow for code to await for the discovered processing promise
        // and use the information in the same object
        // 回填到 discovered 对象上：等待 processing 的请求拿到的是同一个对象引用，
        // resolve 之后必须能读到最新的 browserHash/fileHash/needsInterop。
        for (const o in newData.optimized) {
          const discovered = metadata.discovered[o]
          if (discovered) {
            const optimized = newData.optimized[o]
            discovered.browserHash = optimized.browserHash
            discovered.fileHash = optimized.fileHash
            discovered.needsInterop = optimized.needsInterop
            discovered.processing = undefined
          }
        }

        if (isRerun) {
          // 只有 re-run 才统计「这次新增了哪些依赖」，用于日志展示。
          newDepsToLog.push(
            ...Object.keys(newData.optimized).filter(
              (dep) => !metadata.optimized[dep],
            ),
          )
        }

        // 顺序敏感：必须先 commit 成功、再切换 metadata 引用、最后 resolve 等待者。
        // 若先切换引用，等待者可能在文件尚未落盘时就读取，命中 ENOENT。
        metadata = depsOptimizer.metadata = newData
        resolveEnqueuedProcessingPromises()
      }

      if (!needsReload) {
        // 产物没变：提交（仍会更新 _metadata.json 但不换 URL），不发 full-reload。
        await commitProcessing()

        if (!debug) {
          // 日志延迟到 2*debounceMs 再打，把紧接着发生的下一轮发现合并进同一行。
          if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
          newDepsToLogHandle = setTimeout(() => {
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
            if (warnAboutMissedDependencies) {
              logOptimizeDepsIncludeSuggestion('speed up cold start')
              warnAboutMissedDependencies = false
            }
          }, 2 * debounceMs)
        } else {
          debug(
            colors.green(
              !isRerun
                ? `dependencies optimized`
                : `optimized dependencies unchanged`,
            ),
          )
        }
      } else {
        if (newDepsDiscovered) {
          // There are newly discovered deps, and another rerun is about to be
          // executed. Avoid the current full reload discarding this rerun result
          // We don't resolve the processing promise, as they will be resolved
          // once a rerun is committed
          // 关键权衡：宁可推迟本轮结果（cancel 临时目录），也不要在下一轮马上开始时
          // 先刷新一次——否则用户会看到「刷新 -> 又刷新」。
          // 注意这里不 resolve processing：等待中的请求会继续挂起，直到下一轮 commit。
          processingResult.cancel()

          debug?.(
            colors.green(
              `delaying reload as new dependencies have been found...`,
            ),
          )
        } else {
          // 产物真的变了且没有新依赖在途：提交并整页刷新，旧 URL 全部失效。
          await commitProcessing()

          if (!debug) {
            if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
            if (warnAboutMissedDependencies) {
              logOptimizeDepsIncludeSuggestion(
                'avoid a full page reload during cold start',
              )
              warnAboutMissedDependencies = false
            }
          }

          logger.info(
            colors.green(`optimized dependencies changed. reloading`),
            {
              timestamp: true,
            },
          )
          // interop 不一致时额外提示：把依赖写进 needsInterop 可以让下次冷启动跳过这轮探测。
          if (needsInteropMismatch.length > 0) {
            logger.warn(
              `Mixed ESM and CJS detected in ${colors.yellow(
                needsInteropMismatch.join(', '),
              )}, add ${
                needsInteropMismatch.length === 1 ? 'it' : 'them'
              } to optimizeDeps.needsInterop to speed up cold start`,
              {
                timestamp: true,
              },
            )
          }

          fullReload()
        }
      }
    } catch (e) {
      // 失败兜底：保持旧 metadata 不变（不能把半成品写进 depsOptimizer.metadata），
      // 但必须 resolve 等待者，否则浏览器请求会一直挂到超时。
      logger.error(
        colors.red(`error while updating dependencies:\n${e.stack}`),
        { timestamp: true, error: e },
      )
      resolveEnqueuedProcessingPromises()

      // Reset missing deps, let the server rediscover the dependencies
      // 清空 discovered 让下一次请求重新走 registerMissingImport，
      // 而不是永远停留在失败批次上。
      metadata.discovered = {}
    }

    currentlyProcessing = false
    // 打包期间可能又排了新的 rerun：这里取出并执行，形成串行链。
    // @ts-expect-error `enqueuedRerun` could exist because `debouncedProcessing` may run while awaited
    enqueuedRerun?.()
  }

  // 作用：整页刷新——先失效模块图，再通过 hot 通道通知浏览器。
  // 调用点：仅 runOptimizer() 中「needsReload 且没有新依赖在途」的分支。
  // 关键参数：无。
  // 顺序敏感：必须先 invalidateAll 再 send。缓存过的 transform 结果里保存的是
  //   旧的依赖 URL（旧 ?v=），不失效的话浏览器刷新后仍会请求旧文件并拿到 504。
  // 失败模式：hot.send 在无客户端连接时是 no-op。
  function fullReload() {
    // Cached transform results have stale imports (resolved to
    // old locations) so they need to be invalidated before the page is
    // reloaded.
    environment.moduleGraph.invalidateAll()

    environment.hot.send({
      type: 'full-reload',
      path: '*',
    })
  }

  // 作用：真正发起一次全量重打包（已知 + 新发现）。
  // 调用点：debouncedProcessing() 的定时器回调（经 enqueuedRerun）。
  //   本仓库内未检索到 DepsOptimizer.run 的其它调用点。
  // 关键参数：无；依赖闭包状态。
  // 失败模式：内部只调用 runOptimizer，异常在其内部处理。
  // 注意：这里不再判断 discovered 是否为空；空集合也会重跑一次，用于把结果写回缓存。
  function rerun() {
    // debounce time to wait for new missing deps finished, issue a new
    // optimization of deps (both old and newly found) once the previous
    // optimizeDeps processing is finished
    const deps = Object.keys(metadata.discovered)
    const depsString = depsLogString(deps)
    debug?.(colors.green(`new dependencies found: ${depsString}`))
    runOptimizer()
  }

  // 作用：为「运行时新发现的单个依赖」计算一个临时 browserHash。
  // 调用点：仅 addMissingDep()。
  // 与 index.ts getOptimizedBrowserHash 的差别：这里额外混入 discovered 集合
  // 和 sessionTimestamp，保证每发现一个新依赖，URL 都会变，新旧状态不会混淆。
  // 关键不变量：若后续打包没有改变已知依赖的 fileHash，这个 hash 会被保留（见 commitProcessing），
  // 因此它必须是对「已知 + 缺失」完整状态的有序快照。
  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>,
  ) {
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp,
    )
  }

  // 作用：运行时兜底——发现一个既没 optimized、也没在 discovered 里的依赖时登记它，
  //   并在合适时机触发去抖重打包。
  // 调用点：plugins/resolve.ts（两处「依赖未预构建」分支）、
  //   plugins/preAlias.ts（别名依赖尚未优化时）。
  // 关键参数：id 是源码里的裸导入（可能是 deep import），resolved 是解析后的绝对路径。
  // 返回：OptimizedDepInfo——即使产物还没生成也返回，调用方会立刻
  //   getOptimizedDepId() 拼出 ?v= 并返回给浏览器，请求随后在 optimizedDeps 里 await processing。
  // 去重顺序（optimized -> chunks -> discovered）保证同一 id 不会被重复登记；
  //   顺序不能变，optimized 是最高优先级的事实来源。
  // 失败模式：
  //   - initState 不是 initialized（init 尚未跑或正在跑）时不触发重打包，只登记，
  //     避免与 init() 重置 metadata 竞争（见下方注释描述的真实崩溃场景）；
  //   - waitingForCrawlEnd 为 true 时同样不触发，等 onCrawlEnd 统一处理。
  function registerMissingImport(
    id: string,
    resolved: string,
  ): OptimizedDepInfo {
    const optimized = metadata.optimized[id]
    if (optimized) {
      return optimized
    }
    const chunk = metadata.chunks[id]
    if (chunk) {
      return chunk
    }
    let missing = metadata.discovered[id]
    if (missing) {
      // We are already discover this dependency
      // It will be processed in the next rerun call
      return missing
    }

    missing = addMissingDep(id, resolved)

    // Until the first optimize run is called, avoid triggering processing
    // We'll wait until the user codebase is eagerly processed by Vite so
    // we can get a list of every missing dependency before giving to the
    // browser a dependency that may be outdated, thus avoiding full page reloads

    // A module can be transformed between `createServer()` and `server.listen()`,
    // which discovers a dep before `init()` runs. Starting a run here would race
    // with `init()` resetting the metadata and crash in `commitProcessing`.
    if (depsOptimizer.initState === 'initialized' && !waitingForCrawlEnd) {
      // Debounced rerun, let other missing dependencies be discovered before
      // the running next optimizeDeps
      debouncedProcessing()
    }

    // Return the path for the optimized bundle, this path is known before
    // esbuild is run to generate the pre-bundle
    // 注释里的 esbuild 是历史措辞；Vite 8 中是 rolldown，但「路径先行、产物后到」的
    // 约定不变——所以返回的 depInfo 里 file 有效、processing 未决议。
    return missing
  }

  // 作用：把新依赖写入 metadata.discovered 并立刻开始解析其导出信息。
  // 调用点：registerMissingImport()、init() 扫描结果处理、onCrawlEnd() 合并扫描依赖。
  // 关键参数：resolved 必须是可读的绝对路径，否则 exportsData 的 Promise 会 reject。
  // 副作用：置 newDepsDiscovered=true，这会让当前这轮打包结果在到达时被 cancel 而不是提交。
  // 失败模式：extractExportsData 的错误不会在这里抛出，而是延迟到 await exportsData 时。
  function addMissingDep(id: string, resolved: string) {
    newDepsDiscovered = true

    return addOptimizedDepInfo(metadata, 'discovered', {
      id,
      file: getOptimizedDepPath(environment, id),
      src: resolved,
      // Adding a browserHash to this missing dependency that is unique to
      // the current state of known + missing deps. If its optimizeDeps run
      // doesn't alter the bundled files of previous known dependencies,
      // we don't need a full reload and this browserHash will be kept
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered),
      ),
      // loading of this pre-bundled dep needs to await for its processing
      // promise to be resolved
      // 绑定当前批次 promise：本轮 commit 后才会 resolve，浏览器请求在此等待。
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(environment, resolved),
    })
  }

  // 作用：去抖地安排一次 rerun；若已有打包在跑，则只登记 enqueuedRerun。
  // 调用点：registerMissingImport()、onCrawlEnd()；另通过 DepsOptimizer.run 对外暴露
  //   （本仓库内未检索到 run 的其它调用点）。
  // 关键参数：timeout 默认 100ms；传 0 表示「尽快但不同步执行」。
  // 为什么先清 enqueuedRerun：新的发现会重置去抖窗口，旧的待执行 rerun 必须作废，
  //   否则会在新窗口内提前执行一次只包含旧依赖的打包。
  // 失败模式：无；定时器回调里 currentlyProcessing 为 true 时只登记不执行，
  //   由 runOptimizer 结束时取出执行。
  function debouncedProcessing(timeout = debounceMs) {
    // Debounced rerun, let other missing dependencies be discovered before
    // the next optimizeDeps run
    enqueuedRerun = undefined
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)
    if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
    newDepsToLogHandle = undefined
    debounceProcessingHandle = setTimeout(() => {
      debounceProcessingHandle = undefined
      enqueuedRerun = rerun
      if (!currentlyProcessing) {
        enqueuedRerun()
      }
    }, timeout)
  }

  // onCrawlEnd is called once when the server starts and all static
  // imports after the first request have been crawled (dynamic imports may also
  // be crawled if the browser requests them right away).
  // 作用：首屏静态导入爬取结束时的仲裁点——决定扫描结果能否直接交给浏览器。
  // 调用点：init() 里的 environment.waitForRequestsIdle().then(onCrawlEnd)，只在冷启动触发一次。
  // 关键参数：无。
  // 三条路径（顺序即优先级）：
  //   1. 有扫描结果且非 noDiscovery：比较扫描依赖集与爬取依赖集，不一致就丢弃扫描结果重跑；
  //   2. 没有扫描结果（已提前放行）但爬取期间发现新依赖：普通 rerun，尽量不刷新；
  //   3. 其余（holdUntilCrawlEnd 且扫描尚未完成 / noDiscovery）：排队首轮打包。
  // 失败模式：无显式 catch；内部 await 的 Promise 若 reject 会形成未处理拒绝，
  //   实际使用中 scanProcessing 与 optimizationResult.result 都在各自上游被捕获。
  async function onCrawlEnd() {
    // switch after this point to a simple debounce strategy
    // 从这里开始 registerMissingImport 可以自由触发 rerun，不再等爬取。
    waitingForCrawlEnd = false

    debug?.(colors.green(`static imports crawl ended`))
    if (closed) {
      return
    }

    // Await for the scan+optimize step running in the background
    // It normally should be over by the time crawling of user code ended
    await depsOptimizer.scanProcessing

    if (optimizationResult && !options.noDiscovery) {
      // In the holdUntilCrawlEnd strategy, we don't release the result of the
      // post-scanner optimize step to the browser until we reach this point
      // If there are new dependencies, we do another optimize run, if not, we
      // use the post-scanner optimize result
      // If holdUntilCrawlEnd is false and we reach here, it means that the
      // scan+optimize step finished after crawl end. We follow the same
      // process as in the holdUntilCrawlEnd in this case.
      // 取出并清空 optimizationResult：这一步之后，scan 完成回调不会再处理它，
      // 避免同一份结果被提交或取消两次。
      const afterScanResult = optimizationResult.result
      optimizationResult = undefined // signal that we'll be using the result

      const result = await afterScanResult
      // 扫描+打包已结束，当前不再处于「打包中」；后面要么提交该结果，要么排队重跑。
      currentlyProcessing = false

      const crawlDeps = Object.keys(metadata.discovered)
      const scanDeps = Object.keys(result.metadata.optimized)

      if (scanDeps.length === 0 && crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `no dependencies found by the scanner or crawling static imports`,
          ),
        )
        // We still commit the result so the scanner isn't run on the next cold start
        // for projects without dependencies
        // 即使没有依赖也要提交一次空结果，写入 _metadata.json，
        // 这样下次启动 hash 命中、跳过扫描器。
        startNextDiscoveredBatch()
        runOptimizer(result)
        return
      }

      // interop 变化 或 「爬取到但扫描器没覆盖」都视为扫描结果过期。
      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        result.metadata.optimized,
      )
      const scannerMissedDeps = crawlDeps.some((dep) => !scanDeps.includes(dep))
      const outdatedResult =
        needsInteropMismatch.length > 0 || scannerMissedDeps

      if (outdatedResult) {
        // Drop this scan result, and perform a new optimization to avoid a full reload
        // 丢弃而非提交：如果提交这份不完整结果，浏览器会先加载旧依赖集，
        // 随后新依赖触发公共 chunk 变化，最终还是整页刷新——不如现在直接重跑。
        result.cancel()

        // Add deps found by the scanner to the discovered deps while crawling
        // 扫描器找到、但爬取阶段没触发的依赖也要补进 discovered，
        // 保证重跑时不会漏掉「只被扫描器发现」的依赖。
        for (const dep of scanDeps) {
          if (!crawlDeps.includes(dep)) {
            addMissingDep(dep, result.metadata.optimized[dep].src!)
          }
        }
        if (scannerMissedDeps) {
          debug?.(
            colors.yellow(
              `new dependencies were found while crawling that weren't detected by the scanner`,
            ),
          )
        }
        debug?.(colors.green(`re-running optimizer`))
        // timeout=0：尽快重跑，但仍走一次事件循环让其它发现合并进来。
        debouncedProcessing(0)
      } else {
        debug?.(
          colors.green(
            `using post-scan optimizer result, the scanner found every used dependency`,
          ),
        )
        // 扫描结果与爬取结果完全一致：直接交接给 runOptimizer 提交，
        // 这是最理想路径，不需要二次打包。
        startNextDiscoveredBatch()
        runOptimizer(result)
      }
    } else if (!holdUntilCrawlEnd) {
      // The post-scanner optimize result has been released to the browser
      // If new deps have been discovered, issue a regular rerun of the
      // optimizer. A full page reload may still be avoided if the new
      // optimize result is compatible in this case
      // 扫描结果已经提前交给浏览器了；这里只能补救式重跑。
      if (newDepsDiscovered) {
        debug?.(
          colors.green(
            `new dependencies were found while crawling static imports, re-running optimizer`,
          ),
        )
        warnAboutMissedDependencies = true
        debouncedProcessing(0)
      }
    } else {
      // holdUntilCrawlEnd 且扫描还没结束（optimizationResult 为空）：
      // 没有现成结果可交接，直接排一次首轮打包（noDiscovery 也走这里）。
      const crawlDeps = Object.keys(metadata.discovered)
      currentlyProcessing = false

      if (crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `no dependencies found while crawling the static imports`,
          ),
        )
        // 标记首轮已完成，避免后续把「首次打包」当成 rerun 统计新增依赖。
        firstRunCalled = true
      }

      // queue the first optimizer run, even without deps so the result is cached
      debouncedProcessing(0)
    }
  }

  return depsOptimizer
}

// 作用：noDiscovery 模式使用的极简优化器——只打包 optimizeDeps.include，不做运行时发现。
// 调用点：server/environment.ts Environment 构造函数（optimizeDeps.noDiscovery 为真时选择本工厂）。
// 关键参数：environment 通常是 ssr 这类显式环境。
// 与 createDepsOptimizer 的差别：
//   - registerMissingImport 直接抛错：noDiscovery 下不允许运行时补依赖，
//     调用它说明内部逻辑走错了分支；
//   - run 是 noop：没有扫描/去抖策略，init() 同步阻塞到打包完成；
//   - close 是 noop：没有在途的扫描或延迟提交。
// 失败模式：init() 里 optimizeExplicitEnvironmentDeps 的失败会直接 reject 到 server 启动流程。
export function createExplicitDepsOptimizer(
  environment: DevEnvironment,
): DepsOptimizer {
  const depsOptimizer: DepsOptimizer = {
    metadata: initDepsOptimizerMetadata(environment),
    initState: 'idle',
    isOptimizedDepFile: createIsOptimizedDepFile(environment),
    isOptimizedDepUrl: createIsOptimizedDepUrl(environment),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,

    registerMissingImport: () => {
      // 故意抛错而不是静默返回：noDiscovery 的含义就是「依赖集合固定」，
      // 运行时再出现新依赖是配置/内部逻辑错误，必须暴露出来。
      throw new Error(
        `Vite Internal Error: registerMissingImport is not supported in dev ${environment.name}`,
      )
    },
    init,
    // noop, there is no scanning during dev SSR
    // the optimizer blocks the server start
    run: () => {},

    close: async () => {},
    options: environment.config.optimizeDeps,
  }

  // 作用：一次性完成 include 的打包并阻塞到完成（无延迟提交）。
  // 调用点：DevEnvironment.listen()（与 createDepsOptimizer 的 init 同一调用点）。
  // 失败模式：打包失败会 reject，导致 server 启动失败。
  async function init() {
    if (depsOptimizer.initState !== 'idle') return
    depsOptimizer.initState = 'initializing'

    depsOptimizer.metadata = await optimizeExplicitEnvironmentDeps(environment)
    depsOptimizer.initState = 'initialized'
  }

  return depsOptimizer
}

// 作用：比对「运行时发现的依赖」与「新打包结果」的 needsInterop 是否一致。
// 调用点：runOptimizer()（判断 needsReload）、onCrawlEnd()（判断扫描结果是否过期）。
// 关键参数：discovered 是当前 metadata 里待处理批次，optimized 是新一轮打包产物。
// 只比较两边都存在的 dep，且 discovered 侧 needsInterop 必须是已判定值（非 undefined）。
// 失败模式：无；返回空数组表示一致。
function findInteropMismatches(
  discovered: Record<string, OptimizedDepInfo>,
  optimized: Record<string, OptimizedDepInfo>,
) {
  const needsInteropMismatch = []
  for (const dep in discovered) {
    const discoveredDepInfo = discovered[dep]
    // undefined 表示「尚未判定」，不是不一致，直接跳过。
    if (discoveredDepInfo.needsInterop === undefined) continue

    const depInfo = optimized[dep]
    // 新结果里没有这个依赖（本轮未打包它），没有可比对象。
    if (!depInfo) continue

    if (depInfo.needsInterop !== discoveredDepInfo.needsInterop) {
      // This only happens when a discovered dependency has mixed ESM and CJS syntax
      // and it hasn't been manually added to optimizeDeps.needsInterop
      needsInteropMismatch.push(dep)
      debug?.(colors.cyan(`needsInterop mismatch detected for ${dep}`))
    }
  }
  return needsInteropMismatch
}
