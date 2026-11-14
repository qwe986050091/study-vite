// ============================================================================
// 依赖预构建（dep pre-bundling）主干实现。
// 本文件负责回答四个问题：要不要打包、打包到哪个目录、hash 由什么组成、
// 打包结果以什么形态（DepOptimizationResult）交给运行时。运行时的调度、
// 新依赖发现与整页刷新语义在 ./optimizer.ts。
// 在整条链路中的位置：
//   server/environment.ts 构造 DepsOptimizer（createDepsOptimizer / createExplicitDepsOptimizer）
//     -> optimizer.ts init()
//       -> 本文件 loadCachedDepOptimizationMetadata()  判断缓存能否直接复用
//       -> 本文件 discoverProjectDependencies()        扫描入口、收集裸导入
//       -> 本文件 runOptimizeDeps()                    生成一次「尚未提交」的打包结果
//         -> 本文件 prepareRolldownOptimizerRun()      组装 rolldown 配置与插件
//           -> rolldown().build() / bundle.write()     真正产出 node_modules/.vite/deps/*.js
// Vite 8 的关键变化（最容易按旧版本读错的地方）：
//   1. 预打包器已从 esbuild 换成 rolldown，产物布局、取消语义、错误对象都随之改变；
//      本文件里不再有 esbuild 的 metafile 与 nested output。
//   2. 依赖扫描（./scan.ts）改为 rolldown/experimental 的 scan()，不再是 esbuild。
//   3. 入口来源仍是 HTML / build.rolldownOptions.input / optimizeDeps.entries 三类，
//      产出的 deps 仍是「裸导入 id -> 解析后绝对路径」，下游结构未变。
// 关键不变量：
//   - depsInfo 的 key 是源码里写的裸导入 id，value 必须带 src 与最终 file。
//   - 打包永远先写 processingCacheDir（带 _temp_ 后缀的唯一目录），只有 commit
//     才把它换成正式目录，所以「打包完成」不代表「浏览器可见」。
//   - metadata 的 optimized / chunks / discovered 三张表分别是「已可用」「内部 chunk」
//     「已发现但未打包完成」，按 id 查表必须依次回退（见 optimizedDepInfoFromId）。
// ============================================================================
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { ignoreInput, ignoreOutput } from '@voidzero-dev/vite-task-client'
import { init, parse } from 'es-module-lexer'
import colors from 'picocolors'
import {
  type RolldownOptions,
  type RolldownOutput,
  type OutputOptions as RolldownOutputOptions,
  rolldown,
} from 'rolldown'
import { isDynamicPattern } from 'tinyglobby'
import type { DepsOptimizerEsbuildOptions } from '#types/internal/esbuildOptions'
import { isWindows, withTrailingSlash } from '../../shared/utils'
import type { ResolvedConfig } from '../config'
import {
  ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET,
  METADATA_FILENAME,
} from '../constants'
import type { Environment } from '../environment'
import { transformWithOxc } from '../plugins/oxc'
import { fileToModuleUrl } from '../server/moduleUrl'
import {
  arraify,
  asyncFlatten,
  createDebugger,
  flattenId,
  getHash,
  isOptimizable,
  lookupFile,
  normalizeId,
  normalizePath,
  tryStatSync,
  unique,
} from '../utils'
import { createOptimizeDepsIncludeResolver, expandGlobIds } from './resolve'
import {
  rolldownCjsExternalPlugin,
  rolldownDepPlugin,
} from './rolldownDepPlugin'
import { ScanEnvironment, scanImports } from './scan'

// 与 optimizer.ts 共用 'vite:deps' 命名空间，DEBUG=vite:deps 时两边日志会交错输出。
const debug = createDebugger('vite:deps')

// rolldown 产出的非入口 chunk 以 .js 结尾，这里用于把 fileName 还原成 dep id。
const jsExtensionRE = /\.js$/i

// 单个依赖入口的「静态导出信息」，由 es-module-lexer 解析得到。
// 三个字段各有明确消费者：
//   hasModuleSyntax：needsInterop() 用它判定「入口是否是 CJS/UMD」，为 false 时必须做 interop。
//   exports：needsInterop() 比对「源码导出」与「打包产物导出」是否退化成了单个 default。
//   jsxLoader：prepareRolldownOptimizerRun 用它把 .js 的 moduleType 切成 jsx。
export type ExportsData = {
  hasModuleSyntax: boolean
  // exported names (for `export { a as b }`, `b` is exported name)
  exports: readonly string[]
  // hint if the dep requires loading as jsx
  jsxLoader?: boolean
}

// DepsOptimizer 是「每个 Environment 一份」的运行时对象：client / ssr 各有独立实例，
// 因此缓存目录、metadata、browserHash 全部互不共享（目录后缀见 getDepsCacheSuffix）。
// initState 是本文件与 optimizer.ts 之间最重要的握手位：
//   idle -> initializing -> initialized；registerMissingImport 只有在 initialized
//   且不在冷启动爬取阶段时才允许触发重打包，否则会与 init() 重置 metadata 竞争。
export interface DepsOptimizer {
  init: () => Promise<void>
  initState: 'idle' | 'initializing' | 'initialized'

  metadata: DepOptimizationMetadata
  // scanImports 的后台 Promise；resolve 侧（resolve.ts tryOptimizedResolve）会 await 它，
  // 以保证「别名依赖是否已被预构建」的判断发生在扫描结束之后。
  scanProcessing?: Promise<void>
  // 运行时发现未预构建的裸导入时调用：先占位返回一个 file 路径，真正产物稍后才落盘。
  registerMissingImport: (id: string, resolved: string) => OptimizedDepInfo
  run: () => void

  isOptimizedDepFile: (id: string) => boolean
  isOptimizedDepUrl: (url: string) => boolean
  getOptimizedDepId: (depInfo: OptimizedDepInfo) => string

  close: () => Promise<void>

  options: DepOptimizationOptions
}

export interface DepOptimizationConfig {
  /**
   * Force optimize listed dependencies (must be resolvable import paths).
   * Supports experimental glob patterns for deep imports.
   */
  // include 里的项会被 addManuallyIncludedOptimizeDeps 解析并直接写进 deps，
  // 与扫描结果合并；glob 会先展开成具体 id（见该函数内的 isDynamicPattern 分支）。
  include?: string[]
  /**
   * Do not optimize these dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  // exclude 的语义不是「不打包」，而是「不打包且原样交给浏览器/SSR 运行时」，
  // 同时会作为 rolldown 的 external 传给 rolldownCjsExternalPlugin。
  exclude?: string[]
  /**
   * Forces ESM interop when importing these dependencies. Some legacy
   * packages advertise themselves as ESM but use `require` internally
   * @experimental
   */
  needsInterop?: string[]
  /**
   * Options to pass to esbuild during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `external` is also omitted, use Vite's `optimizeDeps.exclude` option
   * - `plugins` are merged with Vite's dep plugin
   *
   * https://esbuild.github.io/api
   *
   * @deprecated Use `rolldownOptions` instead.
   */
  esbuildOptions?: DepsOptimizerEsbuildOptions
  /**
   * Options to pass to rolldown during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `plugins` are merged with Vite's dep plugin
   */
  // 注意被 Omit 掉的字段：input / logLevel / output.format|sourcemap|dir|banner
  // 都由 prepareRolldownOptimizerRun 强制决定（单一 ESM 入口 + 固定输出目录），
  // 用户只能改其余部分；改到这些字段会被覆盖而不报错。
  rolldownOptions?: Omit<RolldownOptions, 'input' | 'logLevel' | 'output'> & {
    output?: Omit<
      RolldownOutputOptions,
      'format' | 'sourcemap' | 'dir' | 'banner'
    >
  }
  /**
   * List of file extensions that can be optimized. A corresponding esbuild
   * plugin must exist to handle the specific extension.
   *
   * By default, Vite can optimize `.mjs`, `.js`, `.ts`, and `.mts` files. This option
   * allows specifying additional extensions.
   *
   * @experimental
   */
  extensions?: string[]
  /**
   * Deps optimization during build was removed in Vite 5.1. This option is
   * now redundant and will be removed in a future version. Switch to using
   * `optimizeDeps.noDiscovery` and an empty or undefined `optimizeDeps.include`.
   * true or 'dev' disables the optimizer, false or 'build' leaves it enabled.
   * @default 'build'
   * @deprecated
   * @experimental
   */
  disabled?: boolean | 'build' | 'dev'
  /**
   * Automatic dependency discovery. When `noDiscovery` is true, only dependencies
   * listed in `include` will be optimized. The scanner isn't run for cold start
   * in this case. CJS-only dependencies must be present in `include` during dev.
   * @default false
   */
  noDiscovery?: boolean
  /**
   * When enabled, it will hold the first optimized deps results until all static
   * imports are crawled on cold start. This avoids the need for full-page reloads
   * when new dependencies are discovered and they trigger the generation of new
   * common chunks. If all dependencies are found by the scanner plus the explicitly
   * defined ones in `include`, it is better to disable this option to let the
   * browser process more requests in parallel.
   * @default true
   * @experimental
   */
  // 实际消费点在 optimizer.ts 的 onCrawlEnd()：为 true 时 scanner 的结果先扣住，
  // 等 environment.waitForRequestsIdle() 回调后再决定直接提交还是丢弃重跑。
  holdUntilCrawlEnd?: boolean
  /**
   * When enabled, Vite will not throw an error when an outdated optimized
   * dependency is requested. Enabling this option may cause a single module
   * to have a multiple reference.
   * @default false
   * @experimental
   */
  // 关掉（默认）时，旧的 ?v=browserHash 请求会被 plugins/optimizedDeps.ts 判为过期，
  // 抛 ERR_OUTDATED_OPTIMIZED_DEP，由 transform 中间件回 504，等整页刷新重取。
  ignoreOutdatedRequests?: boolean
}

export type DepOptimizationOptions = DepOptimizationConfig & {
  /**
   * By default, Vite will crawl your `index.html` to detect dependencies that
   * need to be pre-bundled. If `build.rolldownOptions.input` is specified, Vite
   * will crawl those entry points instead.
   *
   * If neither of these fit your needs, you can specify custom entries using
   * this option - the value should be a tinyglobby pattern or array of patterns
   * (https://github.com/SuperchupuDev/tinyglobby) that are relative from
   * vite project root. This will overwrite default entries inference.
   */
  entries?: string | string[]
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   * @experimental
   */
  force?: boolean
}

// 作用：判定某个 Environment 是否整体关闭依赖预构建。
// 调用点：server/environment.ts Environment 构造函数（决定是否创建 DepsOptimizer）、
//   plugins/resolve.ts（optimizerResolvePlugin / resolvePlugin 的 applyToEnvironment）、
//   plugins/preAlias.ts、plugins/optimizedDeps.ts（决定插件是否启用）。
// 关键参数：optimizeDeps.disabled 为 true/'dev'，或「noDiscovery 且 include 为空」。
// 失败模式：这里只做开关判断；把 noDiscovery 且无 include 视为禁用，是为了避免
//   启动后必跑一次空打包、白写一个空缓存目录。
export function isDepOptimizationDisabled(
  optimizeDeps: DepOptimizationOptions,
): boolean {
  return (
    optimizeDeps.disabled === true ||
    optimizeDeps.disabled === 'dev' ||
    (!!optimizeDeps.noDiscovery && !optimizeDeps.include?.length)
  )
}

// 一次预构建的「可延迟提交」结果，是 runOptimizeDeps 的返回值。
// 之所以要拆成 commit/cancel 而不是直接落盘：一次 re-run 期间可能又发现新依赖，
// 此时若立刻把结果提交并整页刷新，会丢掉马上开始的下一轮打包结果，
// 所以 optimizer.ts 可以先 cancel() 掉这轮产物，等下一轮合并后再提交。
// commit：把临时目录换成正式 deps 目录并写 _metadata.json；只能成功一次，
//   已被 cancel 后再 commit 会抛错（见 runOptimizeDeps 内的 cleaned 检查）。
// cancel：删除临时目录，且幂等；已 commit 后调用会被忽略，避免删掉刚生效的缓存。
export interface DepOptimizationResult {
  metadata: DepOptimizationMetadata
  /**
   * When doing a re-run, if there are newly discovered dependencies
   * the page reload will be delayed until the next rerun so we need
   * to be able to discard the result
   */
  commit: () => Promise<void>
  cancel: () => void
}

// 一个依赖在 manifest 里的全部运行时信息。
// id 是「源码里的裸导入 id」（含 deep import 与嵌套写法 my-lib > foo），
// file 是它在 deps 缓存目录里的绝对路径（不含 ?v= 查询串）。
export interface OptimizedDepInfo {
  id: string
  file: string
  src?: string
  needsInterop?: boolean
  // 拼在 URL 上的 ?v= 值；全量重打包时若产物未变会刻意保持稳定，见 optimizer.ts commitProcessing。
  browserHash?: string
  // 由「metadata.hash + file + chunk.imports」算出，用于判断 re-run 后产物是否真的变了。
  fileHash?: string
  /**
   * During optimization, ids can still be resolved to their final location
   * but the bundles may not yet be saved to disk
   */
  // 关键：有 processing 就代表「路径已知但文件可能还不存在」。
  // plugins/optimizedDeps.ts 的 load 会 await 它；若永远不 resolve，
  // 请求会以 ERR_OPTIMIZE_DEPS_PROCESSING_ERROR 超时结束。
  processing?: Promise<void>
  /**
   * ExportData cache, discovered deps will parse the src entry to get exports
   * data used both to define if interop is needed and when pre-bundling
   */
  exportsData?: Promise<ExportsData>
  isDynamicEntry?: boolean
}

// deps 缓存目录里 _metadata.json 的内存镜像。
// 三个 hash 的分工（务必区分，否则会误判缓存命中条件）：
//   configHash   = getConfigHash()，只看影响预构建的那部分用户配置；
//   lockfileHash = getLockfileHash()，只看 lockfile（+ patch 目录 mtime）；
//   hash         = getHash(lockfileHash + configHash)，是上面两者之和，
//                  同时参与 fileHash / browserHash 的计算。
// 启动时的命中判定很严格：lockfileHash 或 configHash 任一不同都会重建（见
// loadCachedDepOptimizationMetadata），因此 hash 本身只在写入时用于派生其它 hash。
// browserHash 额外混入「运行时发现的依赖集合 + sessionTimestamp」，
// 只用于让浏览器 URL 失效，不参与「是否重建」的决策。
export interface DepOptimizationMetadata {
  /**
   * The main hash is determined by user config and dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  hash: string
  /**
   * This hash is determined by dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  lockfileHash: string
  /**
   * This hash is determined by user config.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  configHash: string
  /**
   * The browser hash is determined by the main hash plus additional dependencies
   * discovered at runtime. This is used to invalidate browser requests to
   * optimized deps.
   */
  browserHash: string
  /**
   * Metadata for each already optimized dependency
   */
  optimized: Record<string, OptimizedDepInfo>
  /**
   * Metadata for non-entry optimized chunks and dynamic imports
   */
  chunks: Record<string, OptimizedDepInfo>
  /**
   * Metadata for each newly discovered dependency after processing
   */
  discovered: Record<string, OptimizedDepInfo>
  /**
   * OptimizedDepInfo list
   */
  depInfoList: OptimizedDepInfo[]
}

// 作用：一次性跑完「读缓存 -> 扫描 -> 合并 include -> 打包 -> 提交」，返回 metadata。
// 调用点：本文件导出，供 `vite optimize` CLI 使用；同时被 packages/vite/src/node/cli.ts
//   的 optimize 命令间接引用（该命令已 deprecated，正常 dev/build 不再走这里）。
// 关键参数：force 默认取 config.optimizeDeps.force；asCommand 只影响日志走 logger 还是 debug。
// 失败模式：发现无法解析的依赖时 discoverProjectDependencies 直接抛错；
//   打包失败时 runOptimizeDeps 的 result 会 reject，此处没有 try/catch，错误直接冒泡给 CLI。
// 与 dev 路径的差别：这里用 ScanEnvironment（只读、无 moduleGraph），
//   且无条件 await result.commit()——没有「延迟提交」的需求。
/**
 * Scan and optimize dependencies within a project.
 * Used by Vite CLI when running `vite optimize`.
 *
 * @deprecated the optimization process runs automatically and does not need to be called
 */

export async function optimizeDeps(
  config: ResolvedConfig,
  force: boolean | undefined = config.optimizeDeps.force,
  asCommand = false,
): Promise<DepOptimizationMetadata> {
  const log = asCommand ? config.logger.info : debug

  config.logger.warn(
    colors.yellow(
      'manually calling optimizeDeps is deprecated. This is done automatically and does not need to be called manually.',
    ),
  )

  const environment = new ScanEnvironment('client', config)
  await environment.init()

  const cachedMetadata = await loadCachedDepOptimizationMetadata(
    environment,
    force,
    asCommand,
  )
  if (cachedMetadata) {
    return cachedMetadata
  }

  const deps = await discoverProjectDependencies(environment).result

  await addManuallyIncludedOptimizeDeps(environment, deps)

  const depsString = depsLogString(Object.keys(deps))
  log?.(colors.green(`Optimizing dependencies:\n  ${depsString}`))

  const depsInfo = toDiscoveredDependencies(environment, deps)

  const result = await runOptimizeDeps(environment, depsInfo).result

  await result.commit()

  return result.metadata
}

// 作用：noDiscovery 模式下的一次性预构建——只打包 optimizeDeps.include 里的依赖，
//   不跑扫描器，也不做运行时发现新依赖后的增量重打包。
// 调用点：optimizer.ts 的 createExplicitDepsOptimizer().init()。
// 关键参数：environment（通常是 ssr 这类 explicit 环境）；force 来自配置。
// 失败模式：缓存命中则直接返回；否则 include 解析失败只会 warn（addManuallyIncludedOptimizeDeps），
//   打包失败则 result reject，由调用方 init() 冒泡到 server 启动流程。
export async function optimizeExplicitEnvironmentDeps(
  environment: Environment,
): Promise<DepOptimizationMetadata> {
  const cachedMetadata = await loadCachedDepOptimizationMetadata(
    environment,
    environment.config.optimizeDeps.force ?? false,
    false,
  )
  if (cachedMetadata) {
    return cachedMetadata
  }

  const deps: Record<string, string> = {}

  await addManuallyIncludedOptimizeDeps(environment, deps)

  const depsInfo = toDiscoveredDependencies(environment, deps)

  const result = await runOptimizeDeps(environment, depsInfo).result

  await result.commit()

  return result.metadata
}

// 作用：构造一份空的 metadata，并立刻算好三个启动期 hash。
// 调用点：optimizer.ts createDepsOptimizer 初始化与 init() 未命中缓存时、
//   createExplicitDepsOptimizer 初始化时；本文件 runOptimizeDeps 每次打包也会新建一份。
// 关键参数：timestamp 只有 dev 侧传 sessionTimestamp，用于让 browserHash 在冷启动时变化；
//   不传时 browserHash 只由 hash + 空 deps 决定（打包结果与缓存写入用）。
// 失败模式：getDepHash 会同步读取 lockfile（fs.readFileSync），文件被占用等异常会直接抛出。
export function initDepsOptimizerMetadata(
  environment: Environment,
  timestamp?: string,
): DepOptimizationMetadata {
  const { lockfileHash, configHash, hash } = getDepHash(environment)
  return {
    hash,
    lockfileHash,
    configHash,
    browserHash: getOptimizedBrowserHash(hash, {}, timestamp),
    optimized: {},
    chunks: {},
    discovered: {},
    depInfoList: [],
  }
}

// 作用：把 depInfo 同时写进三类表之一与统一的 depInfoList。
// 调用点：本文件 runOptimizeDeps 的产物遍历、parseDepsOptimizerMetadata 恢复缓存；
//   optimizer.ts init() 写手动 include、addMissingDep 写 discovered、commitProcessing 合并 discovered。
// 关键参数：type 必须与 depInfo 当前语义一致（optimized/chunks/discovered）。
// 失败模式：同 id 重复添加会覆盖表项，但 depInfoList 会同时变长——
//   optimizedDepInfoFromFile 依赖 depInfoList 反查，重复项会让「按文件找信息」拿到旧对象。
export function addOptimizedDepInfo(
  metadata: DepOptimizationMetadata,
  type: 'optimized' | 'discovered' | 'chunks',
  depInfo: OptimizedDepInfo,
): OptimizedDepInfo {
  metadata[type][depInfo.id] = depInfo
  metadata.depInfoList.push(depInfo)
  return depInfo
}

// 冷启动时「只加载一次」的一次性清理标记：同进程里 client/ssr 两个环境都会调用本函数，
// 但旧临时目录只需扫一遍 cacheDir。
let firstLoadCachedDepOptimizationMetadata = true

// 作用：决定本次启动能否直接复用磁盘上的 _metadata.json；不能复用就删掉整个 deps 目录，
//   返回 undefined 让调用方进入「重新扫描 + 打包」路径。
// 调用点：optimizer.ts init()（dev 主路径）、本文件 optimizeDeps / optimizeExplicitEnvironmentDeps。
// 关键参数：
//   force：true 时跳过读取，直接删目录（CLI 的 --force、optimizeDeps.force）。
//   asCommand：只影响日志级别，命令模式用 logger.info，dev 用 debug。
// 命中条件（三者同时满足）：_metadata.json 可解析且版本够新、lockfileHash 相同、configHash 相同。
// 失败模式：
//   - 文件不存在 / JSON 损坏 / 缺少 fileHash：被 catch 或 parse 内部的版本检查吞掉，走重建。
//   - 只有 lockfile 或 config 变化时也走重建，而不是「增量补包」。
//   - 返回 undefined 前已把 depsCacheDir 删除，因此调用方必须准备好重新打包，
//     不能把 undefined 当成「没缓存但可以继续用旧文件」。
/**
 * Creates the initial dep optimization metadata, loading it from the deps cache
 * if it exists and pre-bundling isn't forced
 */
export async function loadCachedDepOptimizationMetadata(
  environment: Environment,
  force: boolean = environment.config.optimizeDeps.force ?? false,
  asCommand = false,
): Promise<DepOptimizationMetadata | undefined> {
  const log = asCommand ? environment.logger.info : debug

  if (firstLoadCachedDepOptimizationMetadata) {
    firstLoadCachedDepOptimizationMetadata = false
    // Fire up a clean up of stale processing deps dirs if older process exited early
    // 用 setTimeout(0)+unref 推迟到本轮初始化之后，且不阻止进程退出；
    // 清理对象是上次进程被 kill 时残留的 deps_temp_* 目录。
    setTimeout(
      () => cleanupDepsCacheStaleDirs(environment.getTopLevelConfig()),
      0,
    ).unref()
  }

  const depsCacheDir = getDepsCacheDir(environment)

  // When run inside Vite Task, the dep optimizer cache is both read and
  // written under this directory (metadata + pre-bundled deps). Tell Vite
  // Task to treat it as neither a build input nor a build output: the
  // lockfile hash stored in the metadata already drives re-optimization,
  // and the cache is process-local scratch space, not a build artifact.
  // 这一步只对 Vite Task 生效，用于避免把 deps 缓存误记为构建产物/输入。
  ignoreInput(depsCacheDir)
  ignoreOutput(depsCacheDir)

  if (!force) {
    let cachedMetadata: DepOptimizationMetadata | undefined
    try {
      const cachedMetadataPath = path.join(depsCacheDir, METADATA_FILENAME)
      cachedMetadata = parseDepsOptimizerMetadata(
        await fsp.readFile(cachedMetadataPath, 'utf-8'),
        depsCacheDir,
      )
    } catch {}
    // hash is consistent, no need to re-bundle
    // 注意这里是「分别比对」而不是比对 hash 总和：
    // 分两次比对才能给出精确原因（lockfile 变了 / config 变了）的日志。
    // 任一不等都意味着必须整目录重建——预构建不保证跨 lockfile 的产物兼容。
    if (cachedMetadata) {
      if (
        cachedMetadata.lockfileHash !== getLockfileHash(environment.config.root)
      ) {
        environment.logger.info(
          'Re-optimizing dependencies because lockfile has changed',
          {
            timestamp: true,
          },
        )
      } else if (cachedMetadata.configHash !== getConfigHash(environment)) {
        environment.logger.info(
          'Re-optimizing dependencies because vite config has changed',
          {
            timestamp: true,
          },
        )
      } else {
        log?.(
          `(${environment.name}) Hash is consistent. Skipping. Use --force to override.`,
        )
        // Nothing to commit or cancel as we are using the cache, we only
        // need to resolve the processing promise so requests can move on
        // 命中缓存时返回到期对象即可，调用方（optimizer.ts init）会把
        // firstRunCalled 置为 true，后续发现新依赖直接走增量 re-run。
        return cachedMetadata
      }
    }
  } else {
    environment.logger.info('Forced re-optimization of dependencies', {
      timestamp: true,
    })
  }

  // Start with a fresh cache
  // 走到这里一定是「要重建」：先删正式目录，随后 runOptimizeDeps 会在临时目录里重建，
  // 因此重建期间正式目录并不存在，浏览器请求会落到 processing promise 上等待。
  debug?.(
    `(${environment.name}) ${colors.green(`removing old cache dir ${depsCacheDir}`)}`,
  )
  await fsp.rm(depsCacheDir, { recursive: true, force: true })
}

// 作用：扫描项目入口，得到「需要预构建的裸导入 id -> 解析后绝对路径」。
// 调用点：optimizer.ts init() 的扫描分支、本文件 optimizeDeps()。
// 关键参数：environment 必须是 ScanEnvironment（mode='scan'），
//   它把 pluginContainer 限定为只读、不等待 moduleGraph，避免扫描阶段死锁。
// 输入：./scan.ts scanImports(environment) 返回 { deps, missing }。
// 输出：只把 deps 的 Promise 暴露出去；missing 在这里被转成用户可读错误。
// 失败模式：任一导入解析不到就整体 reject（这会让 dev 启动时报「Are they installed?」）；
//   scan 被 cancel 或服务已关闭时 scanImports 返回空对象，不会 reject。
// 与旧实现的差异：注释中的 "esbuild" 是历史措辞；Vite 8 的扫描由 rolldown 的 scan() 完成。
/**
 * Initial optimizeDeps at server start. Perform a fast scan using esbuild to
 * find deps to pre-bundle and include user hard-coded dependencies
 */
export function discoverProjectDependencies(environment: ScanEnvironment): {
  cancel: () => Promise<void>
  result: Promise<Record<string, string>>
} {
  const { cancel, result } = scanImports(environment)

  return {
    cancel,
    // 注意：这里不做任何过滤或排序，deps 的顺序由 scanImports 内部的
    // orderedDependencies 按 id 字典序固定，保证同一依赖集合得到相同 browserHash。
    result: result.then(({ deps, missing }) => {
      const missingIds = Object.keys(missing)
      if (missingIds.length) {
        throw new Error(
          `The following dependencies are imported but could not be resolved:\n\n  ${missingIds
            .map(
              (id) =>
                `${colors.cyan(id)} ${colors.white(
                  colors.dim(`(imported by ${missing[id]})`),
                )}`,
            )
            .join(`\n  `)}\n\nAre they installed?`,
        )
      }

      return deps
    }),
  }
}

// 作用：把「id -> src」映射转成 OptimizedDepInfo 表，并一次性算好共享的 browserHash。
// 调用点：optimizer.ts init() 处理手动 include、本文件 optimizeDeps /
//   optimizeExplicitEnvironmentDeps 在扫描之后构造打包输入。
// 关键参数：deps 的 key 必须是最终裸导入 id；timestamp 仅 dev 冷启动传入。
// 输出：每个条目带 file（预期产物路径）、browserHash、exportsData（懒解析的 Promise）。
// 失败模式：extractExportsData 是异步且不 await，解析失败会以 rejected Promise 的形式
//   留在 exportsData 上，直到 prepareRolldownOptimizerRun 或 optimizedDepNeedsInterop await 时才暴露。
export function toDiscoveredDependencies(
  environment: Environment,
  deps: Record<string, string>,
  timestamp?: string,
): Record<string, OptimizedDepInfo> {
  const browserHash = getOptimizedBrowserHash(
    getDepHash(environment).hash,
    deps,
    timestamp,
  )
  const discovered: Record<string, OptimizedDepInfo> = {}
  for (const id in deps) {
    const src = deps[id]
    discovered[id] = {
      id,
      file: getOptimizedDepPath(environment, id),
      src,
      browserHash: browserHash,
      exportsData: extractExportsData(environment, src),
    }
  }
  return discovered
}

// 作用：把依赖 id 列表格式化成日志里高亮的一行。
// 调用点：optimizer.ts 的 logNewlyDiscoveredDeps / logOptimizeDepsIncludeSuggestion / rerun，
//   本文件 optimizeDeps 打印待优化列表。
// 失败模式：无；只是字符串拼接，不做转义。
export function depsLogString(qualifiedIds: string[]): string {
  return colors.yellow(qualifiedIds.join(`, `))
}

// 作用：启动一次预打包，同步返回 { cancel, result }；调用方不必等待打包完成即可继续启动。
// 调用点：optimizer.ts init()（扫描完成后）、optimizer.ts runOptimizer()（re-run）、
//   本文件 optimizeDeps / optimizeExplicitEnvironmentDeps。
// 关键参数：
//   depsInfo：本次要打的全部依赖（已知 + 新发现，由 prepareKnownDeps 合并而来）。
//   environment：决定缓存目录、platform、define 等。
// 输出：result 解析为 DepOptimizationResult（携带 metadata 与 commit/cancel），
//   但产物已写入 processingCacheDir，尚未对浏览器可见。
// 失败模式：
//   - 打包异常会 reject，且 runResult.catch 会顺手 cleanUp 临时目录；
//   - 取消后 rolldown 抛「The build was canceled」被吞掉，返回 cancelledResult；
//   - 空依赖时直接返回已提交空目录的结果。
// 为什么可以「不等」：每个依赖的 OptimizedDepInfo.processing 会挂到打包 Promise 上，
//   真正需要文件的请求在 optimizedDeps.ts load 里 await 它。
/**
 * Internally, Vite uses this function to prepare a optimizeDeps run. When Vite starts, we can get
 * the metadata and start the server without waiting for the optimizeDeps processing to be completed
 */
export function runOptimizeDeps(
  environment: Environment,
  depsInfo: Record<string, OptimizedDepInfo>,
): {
  cancel: () => Promise<void>
  result: Promise<DepOptimizationResult>
} {
  // 取消标记挂在闭包里，而不是 AbortSignal：prepareRolldownOptimizerRun 的
  // rolldown 调用本身不可中断，只能在「构建前后」检查并 close。
  const optimizerContext = { cancelled: false }

  const depsCacheDir = getDepsCacheDir(environment)
  const processingCacheDir = getProcessingDepsCacheDir(environment)

  // Create a temporary directory so we don't need to delete optimized deps
  // until they have been processed. This also avoids leaving the deps cache
  // directory in a corrupted state if there is an error
  // 临时目录名 = 正式目录名 + _temp_ + 随机 hash，因此并发的多次 re-run 互不覆盖；
  // 正式目录只在 commit 时被整体替换。
  fs.mkdirSync(processingCacheDir, { recursive: true })

  // a hint for Node.js
  // all files in the cache directory should be recognized as ES modules
  // 预打包产物是 ESM，但文件名是 .js；写 {"type":"module"} 让 Node 侧 import 时按 ESM 解析。
  debug?.(colors.green(`creating package.json in ${processingCacheDir}`))
  fs.writeFileSync(
    path.resolve(processingCacheDir, 'package.json'),
    `{\n  "type": "module"\n}\n`,
  )

  const metadata = initDepsOptimizerMetadata(environment)

  // 打包期 metadata 的 browserHash 只由 hash + 本次依赖集合决定（不含 sessionTimestamp），
  // 这样「同样输入得到同样 hash」，commit 时才能与旧 metadata 比对并保持浏览器缓存稳定。
  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo),
  )

  // We prebundle dependencies with esbuild and cache them, but there is no need
  // to wait here. Code that needs to access the cached deps needs to await
  // the optimizedDepInfo.processing promise for each dep

  const qualifiedIds = Object.keys(depsInfo)
  // cleaned / committed 是这对互斥状态位，保证「临时目录只会被删一次」且
  // 「已提交的目录永远不会再被 cancel 删掉」；这两个判断顺序不能交换。
  let cleaned = false
  let committed = false
  const cleanUp = () => {
    // If commit was already called, ignore the clean up even if a cancel was requested
    // This minimizes the chances of leaving the deps cache in a corrupted state
    if (!cleaned && !committed) {
      cleaned = true
      // No need to wait, we can clean up in the background because temp folders
      // are unique per run
      debug?.(colors.green(`removing cache dir ${processingCacheDir}`))
      try {
        // When exiting the process, `fsp.rm` may not take effect, so we use `fs.rmSync`
        // 用同步版本是因为 cancel 常发生在进程退出路径上，异步删除可能来不及执行。
        fs.rmSync(processingCacheDir, { recursive: true, force: true })
      } catch {
        // Ignore errors
      }
    }
  }

  const successfulResult: DepOptimizationResult = {
    metadata,
    cancel: cleanUp,
    commit: async () => {
      // 先检查 cleaned 再置 committed：若这轮已被 cancel（临时目录已删），
      // 提交就会指向不存在的目录，必须显式报错而不是静默成功。
      if (cleaned) {
        throw new Error(
          'Can not commit a Deps Optimization run as it was cancelled',
        )
      }
      // Ignore clean up requests after this point so the temp folder isn't deleted before
      // we finish committing the new deps cache files to the deps folder
      committed = true

      // Write metadata file, then commit the processing folder to the global deps cache
      // Rewire the file paths from the temporary processing dir to the final deps cache dir
      // 写盘时把 file/src 转成相对 depsCacheDir 的路径（见 stringifyDepsOptimizerMetadata），
      // 这样整个 cacheDir 可以随项目一起移动/复制而仍然可用。
      const dataPath = path.join(processingCacheDir, METADATA_FILENAME)
      debug?.(
        colors.green(`creating ${METADATA_FILENAME} in ${processingCacheDir}`),
      )
      fs.writeFileSync(
        dataPath,
        stringifyDepsOptimizerMetadata(metadata, depsCacheDir),
      )

      // In order to minimize the time where the deps folder isn't in a consistent state,
      // we first rename the old depsCacheDir to a temporary path, then we rename the
      // new processing cache dir to the depsCacheDir. In systems where doing so in sync
      // is safe, we do an atomic operation (at least for this thread). For Windows, we
      // found there are cases where the rename operation may finish before it's done
      // so we do a graceful rename checking that the folder has been properly renamed.
      // We found that the rename-rename (then delete the old folder in the background)
      // is safer than a delete-rename operation.
      // 顺序敏感：两次 rename 之间正式目录短暂不存在，但旧目录已被改名到 temporaryPath，
      // 不会丢文件；随后后台删除旧目录。若改成「先删再 rename」，中途崩溃会让缓存彻底丢失。
      const temporaryPath = depsCacheDir + getTempSuffix()
      const depsCacheDirPresent = fs.existsSync(depsCacheDir)
      if (isWindows) {
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`))
          await safeRename(depsCacheDir, temporaryPath)
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`),
        )
        await safeRename(processingCacheDir, depsCacheDir)
      } else {
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`))
          fs.renameSync(depsCacheDir, temporaryPath)
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`),
        )
        fs.renameSync(processingCacheDir, depsCacheDir)
      }

      // Delete temporary path in the background
      if (depsCacheDirPresent) {
        debug?.(colors.green(`removing cache temp dir ${temporaryPath}`))
        fsp.rm(temporaryPath, { recursive: true, force: true })
      }
    },
  }

  if (!qualifiedIds.length) {
    // No deps to optimize, we still commit the processing cache dir to remove
    // the previous optimized deps if they exist, and let the next server start
    // skip the scanner step if the lockfile hasn't changed
    // 注意这里返回的是 successfulResult 但 result 已 resolve，且没有执行 commit：
    // 由 optimizer.ts/runOptimizer 负责调用 commit，把「空目录」写进缓存，
    // 这样下次启动能命中 hash 而跳过扫描。
    return {
      cancel: async () => cleanUp(),
      result: Promise.resolve(successfulResult),
    }
  }

  // 打包被取消时使用：commit 只做清理，绝不能让半成品进入正式缓存。
  const cancelledResult: DepOptimizationResult = {
    metadata,
    commit: async () => cleanUp(),
    cancel: cleanUp,
  }

  const start = performance.now()

  // 1s 后才提示「正在打包」，避免小项目每次启动都刷出无意义的日志。
  const bundleTimer = setTimeout(() => {
    environment.logger.info('[optimizer] bundling dependencies...', {
      timestamp: true,
    })
  }, 1000)

  const preparedRun = prepareRolldownOptimizerRun(
    environment,
    depsInfo,
    processingCacheDir,
    optimizerContext,
  )

  // preparedRun 阶段做的是「读入口、解析导出、组插件」，真正 build 在这里才开始。
  // 因此 cancel() 可以 await preparedRun 后再 context.cancel()，避免 build 已经启动。
  const runResult = preparedRun.then(({ context, idToExports }) => {
    if (!context || optimizerContext.cancelled) {
      clearTimeout(bundleTimer)
      return cancelledResult
    }

    return context
      .build()
      .then((result) => {
        // rolldown 的 output 以 fileName 为键组织，但 metadata 以 dep id 为键；
        // 这里用「flattenId(id) + '.js'」反查，与 prepareRolldownOptimizerRun 里
        // 把 input 的 key 设成 flatId 的做法严格对应，改一处必须改另一处。
        const depForEntryFileName: Record<string, OptimizedDepInfo> = {}
        for (const dep of Object.values(depsInfo)) {
          const entryFileName = flattenId(dep.id) + '.js'
          depForEntryFileName[entryFileName] = dep
        }

        for (const chunk of result.output) {
          if (chunk.type !== 'chunk') continue

          if (chunk.isEntry) {
            // 入口 chunk：把 depsInfo 里的信息（src/exportsData）与产物信息合并。
            // file 沿用 depsInfo 里「预期路径」，因为 commit 后目录才正式生效。
            const { exportsData, file, id, ...info } =
              depForEntryFileName[chunk.fileName]
            addOptimizedDepInfo(metadata, 'optimized', {
              id,
              file,
              ...info,
              // We only need to hash the chunk.imports in to check for stability, but adding the hash
              // and file path gives us a unique hash that may be useful for other things in the future
              // fileHash 只关心「入口 chunk 依赖了哪些 chunk」是否变化；
              // optimizer.ts 用它判断 re-run 后能否跳过整页刷新。
              fileHash: getHash(
                metadata.hash + file + JSON.stringify(chunk.imports),
              ),
              browserHash: metadata.browserHash,
              // After bundling we have more information and can warn the user about legacy packages
              // that require manual configuration
              // 只有拿到打包后的 chunk 导出列表，才能识别「CJS 互操作导致导出退化」的情况。
              needsInterop: needsInterop(
                environment,
                id,
                idToExports[id],
                chunk,
              ),
            })
          } else {
            // 非入口 chunk（被多个依赖共享的公共 chunk / 动态导入产物）：
            // 它们不对应裸导入 id，统一放进 chunks 表，id 用去掉 .js 的文件名。
            const id = chunk.fileName.replace(jsExtensionRE, '')
            const file = normalizePath(
              path.resolve(getDepsCacheDir(environment), chunk.fileName),
            )
            // 去重：同一个公共 chunk 可能在多个入口的 imports 里出现，
            // 但 rolldown output 只输出一次；这里的判断是防御性的。
            if (
              !findOptimizedDepInfoInRecord(
                metadata.optimized,
                (depInfo) => depInfo.file === file,
              )
            ) {
              addOptimizedDepInfo(metadata, 'chunks', {
                id,
                file,
                // 内部 chunk 不参与 ESM interop 改写（见 importAnalysis 的 optimizedDepChunkRE 判断）。
                needsInterop: false,
                browserHash: metadata.browserHash,
                isDynamicEntry: chunk.isDynamicEntry,
              })
            }
          }
        }

        clearTimeout(bundleTimer)

        debug?.(
          `Dependencies bundled in ${(performance.now() - start).toFixed(2)}ms`,
        )

        return successfulResult
      })

      .catch((e) => {
        clearTimeout(bundleTimer)
        // rolldown 取消构建时抛出的错误信息固定包含 'The build was canceled'；
        // 这是预期路径，不应作为打包失败上报。
        if (e.errors && e.message.includes('The build was canceled')) {
          // an error happens when cancelling, but this is expected so
          // return an empty result instead
          return cancelledResult
        }
        const prependMessage = colors.red(
          'Error during dependency optimization:\n\n',
        )
        e.message = prependMessage + e.message
        throw e
      })
  })

  // 打包失败时没人会调用 commit/cancel，这里兜底删掉临时目录，避免残留。
  runResult.catch(() => {
    cleanUp()
  })

  return {
    async cancel() {
      // 先置取消标记，再等 preparedRun：若 build 尚未开始，build() 会看到标记直接取消；
      // 若已经开始，context.cancel() 会在 write 前后检查并 close。
      optimizerContext.cancelled = true
      const { context } = await preparedRun
      context?.cancel()
      cleanUp()
    },
    result: runResult,
  }
}

// 作用：把 depsInfo 变成一份可执行的 rolldown 构建上下文（读取入口、解析导出、
//   合并用户 rolldownOptions、拼插件），返回 { context: { build, cancel }, idToExports }。
// 调用点：仅本文件 runOptimizeDeps()。
// 关键参数：
//   processingCacheDir：产物输出目录（临时目录），不是最终 deps 目录。
//   optimizerContext：runOptimizeDeps 的取消标记，读入口阶段被取消时直接返回空 context。
// 输出：context.build() 执行 rolldown().write()，返回 RolldownOutput；
//   idToExports 供构建完成后判定 needsInterop。
// 失败模式：
//   - depsInfo[id].src 缺失会因非空断言直接抛 TypeError；
//   - rolldown 配置非法或入口不可读时 build() reject；
//   - 取消后 build() 会 close 并抛 'The build was canceled'，由上层转成 cancelledResult。
async function prepareRolldownOptimizerRun(
  environment: Environment,
  depsInfo: Record<string, OptimizedDepInfo>,
  processingCacheDir: string,
  optimizerContext: { cancelled: boolean },
): Promise<{
  context?: { build: () => Promise<RolldownOutput>; cancel: () => void }
  idToExports: Record<string, ExportsData>
}> {
  // esbuild generates nested directory output with lowest common ancestor base
  // this is unpredictable and makes it difficult to analyze entry / output
  // mapping. So what we do here is:
  // 1. flatten all ids to eliminate slash
  // 2. in the plugin, read the entry ourselves as virtual files to retain the
  //    path.
  // 这段注释是 esbuild 时代的动机，至今仍成立：
  // 若直接把 `id -> src` 作为 input，多入口产物会被 rolldown 按公共祖先嵌套输出，
  // 无法从 fileName 反推 dep id；所以 input 的 key 用 flattenId(id)（斜杠替换成 ~），
  // 再由 rolldownDepPlugin 以虚拟文件读回真实路径。
  // 这也是 runOptimizeDeps 里 depForEntryFileName 用 flattenId 反查的原因。
  const flatIdDeps: Record<string, string> = {}
  const idToExports: Record<string, ExportsData> = {}

  const { optimizeDeps } = environment.config

  // 用户的 plugins 单独抽出来，其余选项原样透传给 rolldown；
  // 注意这里的 output 后续还会被 build() 覆盖 format/sourcemap/dir/entryFileNames。
  const { plugins: pluginsFromConfig = [], ...rolldownOptions } =
    optimizeDeps.rolldownOptions ?? {}

  let jsxLoader = false
  // 并发解析所有入口的导出信息。exportsData 可能已在 toDiscoveredDependencies/addMissingDep
  // 阶段创建好（未 await），这里复用同一个 Promise，避免重复解析。
  await Promise.all(
    Object.keys(depsInfo).map(async (id) => {
      const src = depsInfo[id].src!
      const exportsData = await (depsInfo[id].exportsData ??
        extractExportsData(environment, src))
      if (exportsData.jsxLoader) {
        // Ensure that optimization won't fail by defaulting '.js' to the JSX parser.
        // This is useful for packages such as Gatsby.
        // 只要有一个依赖需要 JSX 解析，就把整批 .js 都按 jsx 处理（见下方 moduleTypes），
        // 这是 rolldown 的全局开关，无法按文件区分。
        jsxLoader = true
      }
      const flatId = flattenId(id)
      // Windows 下 rolldown 的 input 需要反斜杠路径，否则虚拟入口解析会失败；
      // 非 Windows 保持正斜杠。
      flatIdDeps[flatId] = isWindows ? src.replaceAll('/', '\\') : src
      idToExports[id] = exportsData
    }),
  )

  // 解析入口期间可能已经被 cancel（例如用户在扫描未结束时就关闭了 server），
  // 此时不要再启动 rolldown。
  if (optimizerContext.cancelled) return { context: undefined, idToExports }

  // define 必须放在 transform 里：预打包产物要直接把 process.env.NODE_ENV 静态替换掉，
  // 否则会把 Node 的 env 判断带进浏览器。
  // keepProcessEnv 为 true 时保留表达式不替换（用户自己负责），但仍显式声明这个 key，
  // 防止平台默认值把它改掉。
  const define = {
    'process.env.NODE_ENV': environment.config.keepProcessEnv
      ? // define process.env.NODE_ENV even for keepProcessEnv === true
        // as esbuild will replace it automatically when `platform` is `'browser'`
        'process.env.NODE_ENV'
      : JSON.stringify(process.env.NODE_ENV || environment.config.mode),
    ...rolldownOptions.transform?.define,
  }

  // platform 决定 rolldown 的默认 resolve 条件（browser/node 的 mainFields 与 exports 条件）。
  // client 与 webworker 目标必须用 'browser'，否则会误选 node 条件导出。
  const platform =
    optimizeDeps.rolldownOptions?.platform ??
    // We generally don't want to use platform 'neutral', as esbuild has custom handling
    // when the platform is 'node' or 'browser' that can't be emulated by using mainFields
    // and conditions
    (environment.config.consumer === 'client' ||
    environment.config.ssr.target === 'webworker'
      ? 'browser'
      : 'node')

  // exclude 的依赖不打包，但仍可能以 CJS 形式被 require；外部化插件负责把
  // require 转成 ESM import 或包一层 facade（见 rolldownDepPlugin）。
  const external = [...(optimizeDeps.exclude ?? [])]

  // 用户插件先展平，CJS external 插件必须排在内置 dep 插件之前，
  // 这样 require('excluded-pkg') 会先被外部化，而不是被内置解析器处理。
  const plugins = await asyncFlatten(arraify(pluginsFromConfig))
  if (external.length) {
    plugins.push(rolldownCjsExternalPlugin(external, platform, environment))
  }
  plugins.push(...rolldownDepPlugin(environment, flatIdDeps, external))

  let canceled = false
  async function build() {
    const bundle = await rolldown({
      ...rolldownOptions,
      // key 是 flattenId，value 是真实入口路径；两者缺一不可（见上方注释）。
      input: flatIdDeps,
      // 预构建期间的告警统一静默，避免依赖内部的 warning 刷屏。
      logLevel: 'silent',
      plugins,
      platform,
      transform: {
        // 用「广泛可用」的浏览器基线，避免把依赖降级到过老的语法上。
        target: ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET,
        ...rolldownOptions.transform,
        define,
      },
      resolve: {
        // 顺序敏感：越靠前优先级越高，tsx/ts 必须先于 js，否则 .tsx 会被当成 .js。
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'],
        ...rolldownOptions.resolve,
      },
      // TODO: remove this and enable rolldown's CSS support later
      // 目前把 css 当 js 处理（仅为了不报错），jsxLoader 为真时把 .js 也按 jsx 解析。
      moduleTypes: {
        '.css': 'js',
        ...rolldownOptions.moduleTypes,
        ...(jsxLoader ? { '.js': 'jsx' } : {}),
      },
    })
    if (canceled) {
      // 取消发生在 rolldown() 返回之后、write 之前：必须 close 释放资源再抛，
      // 否则 watcher/worker 会泄漏。
      await bundle.close()
      throw new Error('The build was canceled')
    }
    try {
      // format/sourcemap/dir/entryFileNames 在这里强制指定，覆盖用户 output 配置。
      // sourcemap: 'hidden' 表示生成 .map 文件但不写 sourceMappingURL 注释，
      // 由 optimizedDeps 插件在 load 时手动配对 .map 返回。
      return await bundle.write({
        ...rolldownOptions.output,
        format: 'esm',
        sourcemap: 'hidden',
        dir: processingCacheDir,
        entryFileNames: '[name].js',
      })
    } finally {
      await bundle.close()
    }
  }

  function cancel() {
    // 只置标记，不做任何 IO：真正的 close 由 build() 自己负责。
    canceled = true
  }

  return { context: { build, cancel }, idToExports }
}

// 作用：把 optimizeDeps.include 展开、解析并合并进 deps（原地修改）。
// 调用点：optimizer.ts init() 冷启动分支、本文件 optimizeDeps / optimizeExplicitEnvironmentDeps。
// 关键参数：deps 是「id -> src」映射，已存在的 id 不会被覆盖（扫描结果优先）。
// 处理顺序：先展开 glob（会被 splice 回原数组，i 同步跳过新元素），
//   再逐项 normalizeId 并解析，最后用 isOptimizable 过滤非 JS 入口。
// 失败模式：解析不到或不可优化时只 warn 不抛错，因此用户写错 include 不会中断启动，
//   但该依赖会退化为「浏览器直接请求源码」，CJS 包可能因此报错。
export async function addManuallyIncludedOptimizeDeps(
  environment: Environment,
  deps: Record<string, string>,
): Promise<void> {
  const { logger } = environment
  const { optimizeDeps } = environment.config
  const optimizeDepsInclude = optimizeDeps.include ?? []
  if (optimizeDepsInclude.length) {
    // 只有「用户显式写在 include 里的原始 id」才提示，glob 展开出的子项不提示，
    // 避免一次通配符产生大量噪音。
    const unableToOptimize = (id: string, msg: string) => {
      if (optimizeDepsInclude.includes(id)) {
        logger.warn(
          `${msg}: ${colors.cyan(id)}, present in ${environment.name} 'optimizeDeps.include'`,
        )
      }
    }

    // 复制一份再展开，避免修改用户配置数组；splice 后就地替换成展开结果，
    // i += globIds.length - 1 让循环跳过刚插入的项（它们已是具体 id）。
    const includes = [...optimizeDepsInclude]
    for (let i = 0; i < includes.length; i++) {
      const id = includes[i]
      if (isDynamicPattern(id)) {
        const globIds = expandGlobIds(id, environment.getTopLevelConfig())
        includes.splice(i, 1, ...globIds)
        i += globIds.length - 1
      }
    }

    const resolve = createOptimizeDepsIncludeResolver(environment)
    for (const id of includes) {
      // normalize 'foo   >bar` as 'foo > bar' to prevent same id being added
      // and for pretty printing
      // 归一化的另一个作用：让 `a>b` 与 `a > b` 命中同一个 key，
      // 否则会被当成两个依赖各打一份包。
      const normalizedId = normalizeId(id)
      if (!deps[normalizedId]) {
        const entry = await resolve(id)
        if (entry) {
          if (isOptimizable(entry, optimizeDeps)) {
            deps[normalizedId] = entry
          } else {
            unableToOptimize(id, 'Cannot optimize dependency')
          }
        } else {
          unableToOptimize(id, 'Failed to resolve dependency')
        }
      }
    }
  }
}

// 作用：从 OptimizedDepInfo 表还原出「id -> src」，用于计算 browserHash。
// 调用点：本文件 runOptimizeDeps（算 metadata.browserHash）、
//   optimizer.ts addMissingDep（算 discovered 的 browserHash）。
// 失败模式：chunks 表里的条目没有 src，若误传 chunks 会写入 undefined（! 断言不做运行时检查）。
// Convert to { id: src }
export function depsFromOptimizedDepInfo(
  depsInfo: Record<string, OptimizedDepInfo>,
): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const key in depsInfo) {
    obj[key] = depsInfo[key].src!
  }
  return obj
}

// 作用：给出某个依赖 id 在正式 deps 缓存目录中的预期产物路径。
// 调用点：本文件 toDiscoveredDependencies；optimizer.ts addMissingDep。
// 命名规则：flattenId(id) + '.js'，与 rolldown 的 entryFileNames: '[name].js' 严格一致；
//   改任一处都会让 metadata 里的 file 指向不存在的文件。
// 注意：这里返回的是「正式目录」路径，而打包时产物先落在临时目录，
//   commit 后两者内容一致，因此可以提前把路径写进 metadata。
export function getOptimizedDepPath(
  environment: Environment,
  id: string,
): string {
  return normalizePath(
    path.resolve(getDepsCacheDir(environment), flattenId(id) + '.js'),
  )
}

// 缓存目录命名规则（debug 时最常需要核对的地方）：
//   <config.cacheDir>/deps             client 环境（默认 node_modules/.vite/deps）
//   <config.cacheDir>/deps_<envName>   其它环境，如 deps_ssr
//   <同上> + _temp_<hash>              每轮打包的临时目录，commit 后改名成上面的正式目录
// 后缀里不含 hash：是否重建由 metadata 的 configHash/lockfileHash 判断，
// 而不是换目录，这样命中缓存时浏览器 URL 里的 ?v= 才能长期稳定。
function getDepsCacheSuffix(environment: Environment): string {
  return environment.name === 'client' ? '' : `_${environment.name}`
}

export function getDepsCacheDir(environment: Environment): string {
  return getDepsCacheDirPrefix(environment) + getDepsCacheSuffix(environment)
}

function getProcessingDepsCacheDir(environment: Environment) {
  return (
    getDepsCacheDirPrefix(environment) +
    getDepsCacheSuffix(environment) +
    getTempSuffix()
  )
}

// 临时后缀同时用于「打包中的目录」和「commit 时旧目录的暂存名」，
// 由 pid + 时间 + 随机数保证同机多进程/多次 re-run 不会撞名。
function getTempSuffix() {
  return (
    '_temp_' +
    getHash(
      `${process.pid}:${Date.now().toString()}:${Math.random()
        .toString(16)
        .slice(2)}`,
    )
  )
}

function getDepsCacheDirPrefix(environment: Environment): string {
  return normalizePath(path.resolve(environment.config.cacheDir, 'deps'))
}

// 作用：生成「判断某个模块 id 是否位于 deps 缓存目录」的谓词。
// 调用点：optimizer.ts 把它挂到 DepsOptimizer.isOptimizedDepFile，
//   消费者为 plugins/optimizedDeps.ts（resolveId/load）、plugins/importAnalysis.ts、
//   plugins/preAlias.ts、server/moduleUrl.ts、server/environment.ts。
// 关键参数：id 必须是文件系统绝对路径（带不带 query 都能匹配，因为按前缀判断）。
// 失败模式：只做字符串前缀比较，不做 realpath；符号链接指向缓存外时仍会被判为真。
export function createIsOptimizedDepFile(
  environment: Environment,
): (id: string) => boolean {
  // 末尾补分隔符，避免 /deps 与 /deps_ssr 这类同前缀目录互相误判。
  const depsCacheDirPrefix = withTrailingSlash(getDepsCacheDir(environment))
  return (id) => id.startsWith(depsCacheDirPrefix)
}

// 作用：生成「判断浏览器请求 URL 是否指向 deps 缓存」的谓词。
// 调用点：optimizer.ts 挂到 DepsOptimizer.isOptimizedDepUrl，
//   由 server/middlewares/transform.ts 用来决定 cache-control:
//   命中时返回 max-age=31536000,immutable，让预构建产物可被浏览器长期缓存。
// 关键参数：url 是模块 URL（/@fs/... 或 /node_modules/.vite/deps/...），不是文件路径。
// 失败模式：依赖 fileToModuleUrl 的结果；root 配置变化会让前缀不匹配，退化为 no-cache（仅影响性能）。
export function createIsOptimizedDepUrl(
  environment: Environment,
): (url: string) => boolean {
  const { root } = environment.config
  const depsCacheDir = getDepsCacheDir(environment)
  const depsCacheDirPrefix = withTrailingSlash(
    fileToModuleUrl(depsCacheDir, root),
  )
  return function isOptimizedDepUrl(url: string): boolean {
    return url.startsWith(depsCacheDirPrefix)
  }
}

// 作用：读取并校验 _metadata.json，恢复成内存 metadata 对象。
// 调用点：仅本文件 loadCachedDepOptimizationMetadata()。
// 关键参数：depsCacheDir 用于把相对路径还原成绝对路径（与 stringify 时的 path.relative 对称）。
// 版本校验：必须存在 chunks 字段，且每个 optimized 条目都有 fileHash；
//   缺任意一项就返回 undefined（视为旧版本缓存），从而触发整目录重建。
// 失败模式：JSON 语法错误会向上抛，由调用方的 try/catch 吞掉；语义损坏则返回 undefined。
//   恢复时 optimized/chunks 的 browserHash 统一使用顶层 browserHash，
//   因为磁盘上没有保存逐条 hash，这也是「长期缓存」依赖全局 hash 的原因。
function parseDepsOptimizerMetadata(
  jsonMetadata: string,
  depsCacheDir: string,
): DepOptimizationMetadata | undefined {
  const { hash, lockfileHash, configHash, browserHash, optimized, chunks } =
    JSON.parse(jsonMetadata, (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === 'file' || key === 'src') {
        return normalizePath(path.resolve(depsCacheDir, value))
      }
      return value
    })
  if (
    !chunks ||
    Object.values(optimized).some((depInfo: any) => !depInfo.fileHash)
  ) {
    // outdated _metadata.json version, ignore
    return
  }
  const metadata = {
    hash,
    lockfileHash,
    configHash,
    browserHash,
    optimized: {},
    discovered: {},
    chunks: {},
    depInfoList: [],
  }
  for (const id of Object.keys(optimized)) {
    addOptimizedDepInfo(metadata, 'optimized', {
      ...optimized[id],
      id,
      browserHash,
    })
  }
  for (const id of Object.keys(chunks)) {
    addOptimizedDepInfo(metadata, 'chunks', {
      ...chunks[id],
      id,
      browserHash,
      // 内部 chunk 不需要 interop，磁盘上也不保存该字段，这里补默认值。
      needsInterop: false,
    })
  }
  return metadata
}

// 作用：把内存 metadata 序列化成 _metadata.json 的字符串（写入临时目录，commit 时随目录一起生效）。
// 调用点：仅本文件 runOptimizeDeps 的 successfulResult.commit()。
// 关键参数：depsCacheDir 是「正式目录」，所有 file/src 都转成相对它的路径。
// 与 parse 的对称约束：这里丢弃 processing / exportsData / 逐条 browserHash，
//   所以下次启动恢复出来的对象没有这些字段——调用方不能假设缓存命中后它们存在。
// 失败模式：JSON.stringify 的 replacer 只处理 file/src；若 src 为 undefined 会直接省略该键。
/**
 * Stringify metadata for deps cache. Remove processing promises
 * and individual dep info browserHash. Once the cache is reload
 * the next time the server start we need to use the global
 * browserHash to allow long term caching
 */
function stringifyDepsOptimizerMetadata(
  metadata: DepOptimizationMetadata,
  depsCacheDir: string,
) {
  const { hash, configHash, lockfileHash, browserHash, optimized, chunks } =
    metadata
  return JSON.stringify(
    {
      hash,
      configHash,
      lockfileHash,
      browserHash,
      optimized: Object.fromEntries(
        Object.values(optimized).map(
          ({ id, src, file, fileHash, needsInterop, isDynamicEntry }) => [
            id,
            {
              src,
              file,
              fileHash,
              needsInterop,
              isDynamicEntry,
            },
          ],
        ),
      ),
      chunks: Object.fromEntries(
        Object.values(chunks).map(({ id, file, isDynamicEntry }) => [
          id,
          { file, isDynamicEntry },
        ]),
      ),
    },
    (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === 'file' || key === 'src') {
        return normalizePath(path.relative(depsCacheDir, value))
      }
      return value
    },
    2,
  )
}

// 作用：解析依赖入口源码，得到 { hasModuleSyntax, exports, jsxLoader }，
//   既用于判断是否需要 CJS interop，也用于决定是否启用 jsx loader。
// 调用点：toDiscoveredDependencies / prepareRolldownOptimizerRun / addMissingDep（optimizer.ts）
//   / optimizedDepNeedsInterop。
// 关键参数：filePath 是入口的绝对路径（通常是 node_modules 里的 src）。
// 两条路径：
//   1. 命中 optimizeDeps.extensions 自定义扩展名：先用 rolldown 把入口转译成 JS（外部化所有依赖），
//      再交给 es-module-lexer 解析——因为 lexer 只认 JS。
//   2. 普通 JS/TS：直接读文件解析；解析失败说明含 JSX/TS 语法，按 moduleTypes 指定的 lang
//      用 oxc 转译后再解析（transformWithOxc）。
// 失败模式：自定义扩展名路径下 rolldown 出错会 reject；普通路径下若 lang 不支持则抛
//   `Unable to parse`；所有异常都会沿 Promise 冒泡到打包流程。
// 与旧实现的差异：转译器已是 oxc（plugins/oxc.ts transformWithOxc），不再是 esbuild transform。
export async function extractExportsData(
  environment: Environment,
  filePath: string,
): Promise<ExportsData> {
  // es-module-lexer 的 WASM 初始化，多次调用是幂等的。
  await init()

  const { optimizeDeps } = environment.config

  const rolldownOptions = optimizeDeps.rolldownOptions ?? {}
  if (optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
    // For custom supported extensions, build the entry file to transform it into JS,
    // and then parse with es-module-lexer. Note that the `bundle` option is not `true`,
    // so only the entry file is being transformed.
    // 注意这里没有设置 bundle:true，因此只转译入口本身，不会把依赖树打进来；
    // externalize 插件把「有 importer 的导入」全部标记成 external 以保证这一点。
    const { plugins: pluginsFromConfig = [], ...remainingRolldownOptions } =
      rolldownOptions
    const plugins = await asyncFlatten(arraify(pluginsFromConfig))
    plugins.unshift({
      name: 'externalize',
      // importer === undefined 表示入口本身，返回 undefined 让它被正常加载；
      // 其余导入一律 external，避免解析到 node_modules 里的其它文件。
      resolveId(id, importer) {
        if (importer !== undefined) {
          return { id, external: true }
        }
      },
    })
    const build = await rolldown({
      ...remainingRolldownOptions,
      plugins,
      input: [filePath],
      // TODO: remove this and enable rolldown's CSS support later
      moduleTypes: {
        '.css': 'js',
        ...remainingRolldownOptions.moduleTypes,
      },
    })
    try {
      const result = await build.generate({
        ...rolldownOptions.output,
        format: 'esm',
        sourcemap: false,
      })
      const [, exports, , hasModuleSyntax] = parse(result.output[0].code)
      // reexport-all（export * from）与仅类型导出无法给出确定名字，直接丢弃；
      // 这与 importAnalysis.ts 里 exportNames 的过滤规则保持一致。
      return {
        hasModuleSyntax,
        exports: exports.flatMap((e) =>
          e.type === 'reexport-all' || e.typeOnly ? [] : [e.name],
        ),
      }
    } finally {
      // 无论解析是否成功都要 close，否则 rolldown 的 native 资源不会释放。
      await build.close()
    }
  }

  let parseResult: ReturnType<typeof parse>
  let usedJsxLoader = false

  const entryContent = fs.readFileSync(filePath, 'utf-8')
  try {
    // 快路径：纯 JS/ESM 直接解析，无任何转译开销（绝大多数 CJS 包走这里）。
    parseResult = parse(entryContent)
  } catch {
    // 解析失败通常是因为文件里有 JSX/TS 语法；lang 默认回退 'jsx'，
    // 因为 rolldown 的 jsx loader 同时能处理绝大部分 TS 之外的新语法。
    const lang = rolldownOptions.moduleTypes?.[path.extname(filePath)] || 'jsx'
    debug?.(
      `Unable to parse: ${filePath}.\n Trying again with a ${lang} transform.`,
    )
    if (lang !== 'jsx' && lang !== 'tsx' && lang !== 'ts') {
      throw new Error(`Unable to parse: ${filePath}.`)
    }
    // 用 oxc 转译（不是 esbuild）；transformed.code 已是 ESM，lexer 可解析。
    const transformed = await transformWithOxc(
      entryContent,
      filePath,
      { lang },
      undefined,
      environment.config,
    )
    parseResult = parse(transformed.code)
    // 标记曾经用过 jsx 转译，prepareRolldownOptimizerRun 会据此把 .js 全局按 jsx 解析。
    usedJsxLoader = true
  }

  const [, exports, , hasModuleSyntax] = parseResult
  const exportsData: ExportsData = {
    hasModuleSyntax,
    exports: exports.flatMap((e) =>
      e.type === 'reexport-all' || e.typeOnly ? [] : [e.name],
    ),
    jsxLoader: usedJsxLoader,
  }
  return exportsData
}

// 作用：判定某个依赖是否需要 ESM interop（即浏览器侧要把 `import { x } from 'dep'`
//   改写成 `const { x } = dep` 来兼容 CJS 产物）。
// 调用点：本文件 runOptimizeDeps（带 output，打包后判定）、optimizedDepNeedsInterop
//   （不带 output，缓存命中或懒判定时使用）。
// 判定顺序（顺序会影响结果，不能随意调换）：
//   1. 用户在 optimizeDeps.needsInterop 里显式点名 -> 必须 interop（最高优先级）。
//   2. 源码没有 ESM 语法（hasModuleSyntax=false）-> 基本可判定为 CJS/UMD -> interop。
//   3. 传入打包产物 output 时，若「产物只剩 default 导出」而「源码本来有具名导出」，
//      说明 ESM 包被 CJS 的 require() 使用后退化了，也必须 interop。
// 失败模式：exportsData 若来自失败解析会 reject；needsInterop 为 true 只影响 importAnalysis
//   的重写逻辑，不会让请求失败。
function needsInterop(
  environment: Environment,
  id: string,
  exportsData: ExportsData,
  output?: { exports: string[] },
): boolean {
  if (environment.config.optimizeDeps.needsInterop?.includes(id)) {
    return true
  }
  const { hasModuleSyntax, exports } = exportsData
  // entry has no ESM syntax - likely CJS or UMD
  if (!hasModuleSyntax) {
    return true
  }

  if (output) {
    // if a peer dependency used require() on an ESM dependency, esbuild turns the
    // ESM dependency's entry chunk into a single default export... detect
    // such cases by checking exports mismatch, and force interop.
    // 这段注释描述的是 esbuild 时代的行为；rolldown 下等价场景仍然存在
    // （CJS 的 require 语义只认 module.exports），所以判定逻辑保留。
    // 单默认导出的特例必须单独判：`export default` 的包在浏览器侧本来就该按 default 用，
    // 若源码也只有 default，就不该误判成 CJS 而强行 interop。
    const generatedExports: string[] = output.exports

    if (
      isSingleDefaultExport(generatedExports) &&
      !isSingleDefaultExport(exports)
    ) {
      return true
    }
  }
  return false
}

// 只认「恰好一个 default」这一种形态；`default` + 具名导出不算，
// 因为那种产物在浏览器侧仍可正常按 ESM 使用。
function isSingleDefaultExport(exports: readonly string[]) {
  return exports.length === 1 && exports[0] === 'default'
}

// 支持的 lockfile 列表。
// 末尾的 sort 依据 npm_config_user_agent 把「当前包管理器」的项排到末尾，
// 但实际命中由 getLockfileHash 里的 lookupFile 自前向后查找决定，顺序只影响
// 多种 lockfile 并存时选哪一个（选中的文件内容进 hash）。
// checkPatchesDir 表示补丁目录的 mtime 也要计入 hash（patch-package / pnpm patch 会改源码
// 但不一定改 lockfile 内容，只看 lockfile 会漏掉变更）。
// 调用点：本文件 getLockfileHash。
const lockfileFormats = [
  {
    path: 'node_modules/.pnpm/lock.yaml',
    // Included in lockfile
    checkPatchesDir: false,
    manager: 'pnpm',
  },
  {
    path: 'node_modules/.package-lock.json',
    checkPatchesDir: 'patches',
    manager: 'npm',
  },
  {
    // Yarn non-PnP
    path: 'node_modules/.yarn-state.yml',
    checkPatchesDir: false,
    manager: 'yarn',
  },
  {
    path: 'bun.lock',
    checkPatchesDir: 'patches',
    manager: 'bun',
  },
  {
    path: '.rush/temp/shrinkwrap-deps.json',
    // Included in lockfile
    checkPatchesDir: false,
    manager: 'pnpm',
  },
  {
    path: 'aube-lock.yaml',
    checkPatchesDir: false,
    manager: 'aube',
  },
  {
    path: 'nub.lock',
    // Included in lockfile (`patchedDependencies` has patch hashes)
    checkPatchesDir: false,
    manager: 'nub',
  },

  // discouraged package manager lockfiles
  // or deprecated lockfiles
  {
    // Yarn v3+ PnP
    path: '.pnp.cjs',
    checkPatchesDir: '.yarn/patches',
    manager: 'yarn',
  },
  {
    // Yarn v2 PnP
    path: '.pnp.js',
    checkPatchesDir: '.yarn/patches',
    manager: 'yarn',
  },
  {
    // yarn 1
    path: 'node_modules/.yarn-integrity',
    checkPatchesDir: 'patches',
    manager: 'yarn',
  },
  {
    path: 'bun.lockb',
    checkPatchesDir: 'patches',
    manager: 'bun',
  },
].sort((_, { manager }) => {
  return process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1
})
const lockfilePaths = lockfileFormats.map((l) => l.path)

// Only used when none of the formats above is found, so it never changes which
// lockfile is hashed for projects that already have one of them.
// e.g. Yarn with `nodeLinker: pnpm` writes neither `.yarn-state.yml` nor `.pnp.cjs`.
const fallbackLockfileFormats = [
  {
    path: 'yarn.lock',
    // Included in lockfile
    checkPatchesDir: false,
    manager: 'yarn',
  },
]
const fallbackLockfilePaths = fallbackLockfileFormats.map((l) => l.path)

// 作用：计算「只受用户配置影响」的 hash，用于跨启动判断是否需要重建。
// 调用点：本文件 loadCachedDepOptimizationMetadata（与缓存比对）、getDepHash。
// 关键参数：只挑选会影响预构建结果的字段，而不是整个 config——
//   避免无关配置（如 server.port）变动导致无谓重建。
// 稳定性处理（顺序敏感，删掉就会频繁重建）：
//   - include/exclude 先 unique 再 sort，抵消书写顺序差异；
//   - plugins 只取 name，函数体变化无法感知；
//   - rolldownOptions 里剔除 plugins/onLog/onwarn/checks，插件改由
//     config.optimizeDepsPluginNames 统一表示；
//   - JSON.stringify 的 replacer 把函数与正则转成字符串，避免被序列化成 {}。
// 失败模式：循环引用或不可序列化的值会让 JSON.stringify 抛错；函数/正则被 toString 后
//   闭包内容不同但源码相同的情况会误判为「未变化」。
function getConfigHash(environment: Environment): string {
  // Take config into account
  // only a subset of config options that can affect dep optimization
  const { config } = environment
  const { optimizeDeps } = config
  const content = JSON.stringify(
    {
      define: !config.keepProcessEnv
        ? process.env.NODE_ENV || config.mode
        : null,
      root: config.root,
      resolve: config.resolve,
      assetsInclude: config.assetsInclude,
      plugins: config.plugins.map((p) => p.name),
      optimizeDeps: {
        include: optimizeDeps.include
          ? unique(optimizeDeps.include).sort()
          : undefined,
        exclude: optimizeDeps.exclude
          ? unique(optimizeDeps.exclude).sort()
          : undefined,
        rolldownOptions: {
          ...optimizeDeps.rolldownOptions,
          plugins: undefined, // included in optimizeDepsPluginNames
          onLog: undefined,
          onwarn: undefined,
          checks: undefined,
          output: {
            ...optimizeDeps.rolldownOptions?.output,
            plugins: undefined, // included in optimizeDepsPluginNames
          },
        },
      },
      optimizeDepsPluginNames: config.optimizeDepsPluginNames,
    },
    (_, value) => {
      if (typeof value === 'function' || value instanceof RegExp) {
        return value.toString()
      }
      return value
    },
  )
  return getHash(content)
}

// 作用：把「lockfile 内容 + 补丁目录 mtime」压成一个 hash。
// 调用点：本文件 loadCachedDepOptimizationMetadata（与缓存比对）、getDepHash；
//   测试 src/node/__tests__/optimizer/lockfileHash.spec.ts 直接断言其等价于 getHash(内容)。
// 关键参数：root 是项目根，向上查找 lockfilePaths（找不到再试 fallbackLockfilePaths）。
// 找不到任何 lockfile 时用空字符串参与 hash——这保证「没有 lockfile 的项目」也能稳定命中缓存。
// 失败模式：fs.readFileSync 在文件被锁定时会抛错（未捕获，会冒泡到启动流程）；
//   补丁目录用 tryStatSync，不存在则静默跳过。
export function getLockfileHash(root: string): string {
  const lockfilePath =
    lookupFile(root, lockfilePaths) ?? lookupFile(root, fallbackLockfilePaths)
  let content = lockfilePath ? fs.readFileSync(lockfilePath, 'utf-8') : ''
  if (lockfilePath) {
    const normalizedLockfilePath = lockfilePath.replaceAll('\\', '/')
    const lockfileFormat = [
      ...lockfileFormats,
      ...fallbackLockfileFormats,
    ].find((f) => normalizedLockfilePath.endsWith(f.path))!
    if (lockfileFormat.checkPatchesDir) {
      // Default of https://github.com/ds300/patch-package
      const baseDir = lockfilePath.slice(0, -lockfileFormat.path.length)
      const fullPath = path.join(
        baseDir,
        lockfileFormat.checkPatchesDir as string,
      )
      const stat = tryStatSync(fullPath)
      if (stat?.isDirectory()) {
        content += stat.mtimeMs.toString()
      }
    }
  }
  return getHash(content)
}

// 作用：一次算出并返回三个启动期 hash（lockfileHash / configHash / 二者合成的 hash）。
// 调用点：本文件 initDepsOptimizerMetadata、toDiscoveredDependencies。
// 关键参数：没有缓存参数，每次调用都会同步读 lockfile，因此不要在高频路径里反复调用。
// 失败模式：同 getConfigHash / getLockfileHash。
function getDepHash(environment: Environment): {
  lockfileHash: string
  configHash: string
  hash: string
} {
  const lockfileHash = getLockfileHash(environment.config.root)
  const configHash = getConfigHash(environment)
  // 注意 hash 不是对「config 对象 + lockfile」重新序列化，而是两级 hash 的拼接再 hash，
  // 因此 hash 变化不一定能区分是 config 还是 lockfile 变了（两者各自有独立 hash 用于诊断）。
  const hash = getHash(lockfileHash + configHash)
  return {
    hash,
    lockfileHash,
    configHash,
  }
}

// 作用：计算浏览器 URL 上的 ?v= 值。
// 调用点：本文件 initDepsOptimizerMetadata / toDiscoveredDependencies / runOptimizeDeps，
//   optimizer.ts getDiscoveredBrowserHash。
// 关键参数：deps 的「键顺序」会影响 JSON.stringify 结果，因此调用方必须保证顺序稳定
//   （scanImports 的 orderedDependencies 与 prepareKnownDeps 的插入顺序都依赖这一点）。
// timestamp 在 dev 冷启动传 sessionTimestamp，让同一份缓存在新进程里换一个 URL，
//   避免浏览器沿用上一进程的旧响应；写入缓存时（runOptimizeDeps）不传，保持稳定。
function getOptimizedBrowserHash(
  hash: string,
  deps: Record<string, string>,
  timestamp = '',
) {
  return getHash(hash + JSON.stringify(deps) + timestamp)
}

// 作用：按 dep id 依次在 optimized / discovered / chunks 三张表里查找。
// 调用点：plugins/resolve.ts tryOptimizedResolve（判断别名依赖是否已优化）。
// 失败模式：返回 undefined 表示「未预构建」，调用方需回退到普通解析。
// 查找顺序解释了为什么 discovered 能工作：新依赖先进入 discovered，
// 在打包完成前也能拿到 file 与 browserHash。
export function optimizedDepInfoFromId(
  metadata: DepOptimizationMetadata,
  id: string,
): OptimizedDepInfo | undefined {
  return (
    metadata.optimized[id] || metadata.discovered[id] || metadata.chunks[id]
  )
}

// 作用：按产物文件绝对路径反查 depInfo（URL 到 metadata 的唯一桥梁）。
// 调用点：plugins/optimizedDeps.ts load（判断 ?v= 是否过期）、
//   plugins/importAnalysis.ts（找 needsInterop）、plugins/resolve.ts（取 browserHash）。
// 关键参数：file 必须已 cleanUrl（去掉 ?v=），否则永远匹配不到。
// 失败模式：线性扫 depInfoList，命中重复 file 时返回第一个（见 addOptimizedDepInfo 的重复项风险）。
export function optimizedDepInfoFromFile(
  metadata: DepOptimizationMetadata,
  file: string,
): OptimizedDepInfo | undefined {
  return metadata.depInfoList.find((depInfo) => depInfo.file === file)
}

// 作用：在 record 中按谓词查找第一个匹配项，仅用于去重。
// 调用点：本文件 runOptimizeDeps 判断某个 chunk 是否已作为 entry 纳入 optimized。
// 失败模式：无；找不到返回 undefined。
function findOptimizedDepInfoInRecord(
  dependenciesInfo: Record<string, OptimizedDepInfo>,
  callbackFn: (depInfo: OptimizedDepInfo, id: string) => any,
): OptimizedDepInfo | undefined {
  for (const o of Object.keys(dependenciesInfo)) {
    const info = dependenciesInfo[o]
    if (callbackFn(info, o)) {
      return info
    }
  }
}

// 作用：懒判定某个已优化的产物文件是否需要 interop，并把结果写回 depInfo 缓存。
// 调用点：plugins/importAnalysis.ts（改写具名导入前调用）。
// 关键参数：file 是 cleanUrl 后的绝对路径；只有 needsInterop 为 undefined 时才重新解析。
// 为什么需要它：缓存命中时 metadata 里可能没有 needsInterop（磁盘只存可选字段），
//   而 interop 只影响 importAnalysis 的重写，没必要在启动时对全部依赖做一次解析。
// 失败模式：返回 undefined 表示该 file 不属于任何已知依赖（例如内部 chunk 的动态入口），
//   importAnalysis 对 undefined 只记日志不报错。
export async function optimizedDepNeedsInterop(
  environment: Environment,
  metadata: DepOptimizationMetadata,
  file: string,
): Promise<boolean | undefined> {
  const depInfo = optimizedDepInfoFromFile(metadata, file)
  if (depInfo?.src && depInfo.needsInterop === undefined) {
    depInfo.exportsData ??= extractExportsData(environment, depInfo.src)
    depInfo.needsInterop = needsInterop(
      environment,
      depInfo.id,
      await depInfo.exportsData,
    )
  }
  return depInfo?.needsInterop
}

// 临时目录超过 24h 未被触碰就认为上次进程异常退出，可以安全删除。
const MAX_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000
// 作用：清理 cacheDir 下残留的 *_temp_* 目录（进程被 kill 时 commit 未完成）。
// 调用点：本文件 loadCachedDepOptimizationMetadata（首次加载时 setTimeout(0) 触发）。
// 关键参数：config.cacheDir；只看目录名是否含 '_temp_'，再按 mtime 判断年龄。
// 失败模式：整个函数被 try/catch 包住，任何 IO 错误只记日志，绝不影响启动。
// 为什么按 mtime 而不是直接全删：可能还有其它仍在运行的 Vite 进程正在写自己的 temp 目录。
export async function cleanupDepsCacheStaleDirs(
  config: ResolvedConfig,
): Promise<void> {
  try {
    const cacheDir = path.resolve(config.cacheDir)
    if (fs.existsSync(cacheDir)) {
      const dirents = await fsp.readdir(cacheDir, { withFileTypes: true })
      for (const dirent of dirents) {
        if (dirent.isDirectory() && dirent.name.includes('_temp_')) {
          const tempDirPath = path.resolve(config.cacheDir, dirent.name)
          const stats = await fsp.stat(tempDirPath).catch(() => null)
          if (
            stats?.mtime &&
            Date.now() - stats.mtime.getTime() > MAX_TEMP_DIR_AGE_MS
          ) {
            debug?.(`removing stale cache temp dir ${tempDirPath}`)
            await fsp.rm(tempDirPath, { recursive: true, force: true })
          }
        }
      }
    }
  } catch (err) {
    config.logger.error(err)
  }
}

// We found issues with renaming folders in some systems. This is a custom
// implementation for the optimizer. It isn't intended to be a general utility

// Based on node-graceful-fs

// The ISC License
// Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors
// https://github.com/isaacs/node-graceful-fs/blob/234379906b7d2f4c9cfeb412d2516f42b0fb4953/LICENSE

// On Windows, A/V software can lock the directory, causing this
// to fail with an EACCES or EPERM if the directory contains newly
// created files. The original tried for up to 60 seconds, we only
// wait for 5 seconds, as a longer time would be seen as an error

// 作用：带重试的目录 rename，仅在 Windows 的 commit 路径使用（见 runOptimizeDeps.commit）。
// 调用点：本文件 runOptimizeDeps 的 commit()（isWindows 分支）。
// 关键参数：from/to 是目录路径；超时 5s，退避从 0 开始每次 +10ms（上限 100ms）。
// 重试条件：只重试 EACCES/EPERM（杀毒软件/索引服务短暂占用）；
//   且每次重试前先 stat(to)，若目标已存在（ENOENT 不成立）就放弃，避免把不同目录覆盖。
// 失败模式：超时后把最后一次 error 交给回调，commit 会因此 reject。
const GRACEFUL_RENAME_TIMEOUT = 5000
const safeRename = promisify(function gracefulRename(
  from: string,
  to: string,
  cb: (error: NodeJS.ErrnoException | null) => void,
) {
  const start = Date.now()
  let backoff = 0
  fs.rename(from, to, function CB(er) {
    if (
      er &&
      (er.code === 'EACCES' || er.code === 'EPERM') &&
      Date.now() - start < GRACEFUL_RENAME_TIMEOUT
    ) {
      setTimeout(function () {
        fs.stat(to, function (stater, _st) {
          if (stater && stater.code === 'ENOENT') fs.rename(from, to, CB)
          else CB(er)
        })
      }, backoff)
      if (backoff < 100) backoff += 10
      return
    }
    cb(er)
  })
})
