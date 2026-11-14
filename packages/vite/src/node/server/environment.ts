import path from 'node:path'
import colors from 'picocolors'
import type { FetchFunctionOptions, FetchResult } from 'vite/module-runner'
import type { FSWatcher } from '#dep-types/chokidar'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../../shared/constants'
import { cleanUrl, promiseWithResolvers, unwrapId } from '../../shared/utils'
import { BaseEnvironment } from '../baseEnvironment'
import type {
  EnvironmentOptions,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../config'
import type { DepsOptimizer } from '../optimizer'
import { isDepOptimizationDisabled } from '../optimizer'
import {
  createDepsOptimizer,
  createExplicitDepsOptimizer,
} from '../optimizer/optimizer'
import type { ViteDevServer } from '../server'
import { fetchModule } from '../ssr/fetchModule'
import { mergeConfig, monotonicDateNow } from '../utils'
import { BundledDev } from './bundledDev'
import type {
  HotChannel,
  NormalizedHotChannel,
  NormalizedHotChannelClient,
} from './hmr'
import { getShortName, normalizeHotChannel, updateModules } from './hmr'
import { buildErrorMessage } from './middlewares/error'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { EnvironmentModuleNode } from './moduleGraph'
import type { EnvironmentPluginContainer } from './pluginContainer'
import {
  ERR_CLOSED_SERVER,
  createEnvironmentPluginContainer,
} from './pluginContainer'
import type { SafeModulePaths } from './safeModulePaths'
import type { TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import { warmupFiles } from './warmup'
import { type WebSocketServer, isWebSocketServer } from './ws'

// ============================================================================
// 文件角色：一个「环境」（client / ssr / 自定义）的运行时对象。

// 它是 Vite 6 之后的核心抽象：每个 environment 各有一份
//   pluginContainer（插件状态独立）、moduleGraph（模块图独立）、
//   depsOptimizer（依赖预构建独立）、hot（HMR 通道独立）。
// 因此同一个文件可以被 client 与 ssr 以不同插件链、不同解析条件处理，
// 互不污染缓存。

// 上游：server/index.ts 的 _createServer 里对每个 environment 调 init()；
// 下游：transformRequest → transformRequest.ts；HMR → hmr.ts；
// 依赖预构建 → optimizer/optimizer.ts。

// 注意 server.transformRequest / server.moduleGraph 只是这里的兼容代理。
// ============================================================================
export interface DevEnvironmentContext {
  hot: boolean
  transport?: HotChannel | WebSocketServer
  options?: EnvironmentOptions
  remoteRunner?: {
    inlineSourceMap?: boolean
  }
  depsOptimizer?: DepsOptimizer
  /** @internal used for client environment */
  disableFetchModule?: boolean
  /** @internal used for full bundle mode */
  disableDepsOptimizer?: boolean
}

export class DevEnvironment extends BaseEnvironment {
  // mode='dev' 是 environment 的判别式：扫描阶段是 'scan'，构建阶段是 'build'。
  // 插件里判断 environment.mode 的地方，量的就是这个字段。
  mode = 'dev' as const
  moduleGraph: EnvironmentModuleGraph
  // 每个 environment 独立的模块图。父子关系、HMR accept 边界都在图里，
  // 因此 client 与 ssr 的 HMR 传播互不干扰。
  /** @internal */
  safeModulePaths: SafeModulePaths

  depsOptimizer?: DepsOptimizer
  // 依赖预构建器。可能为 undefined（优化被禁用、或该环境走全量打包 bundledDev）。
  /**
   * @internal
   */
  _remoteRunnerOptions: DevEnvironmentContext['remoteRunner']
  /**
   * @internal
   */
  _skipFsCheck: boolean
  // 远程 runner（如浏览器端 ModuleRunner）请求时，文件访问检查由对端负责，
  // 这里跳过本地 fs 检查，避免同一个文件被检查两次。

  get pluginContainer(): EnvironmentPluginContainer<DevEnvironment> {
    if (!this._pluginContainer)
      throw new Error(
        `${this.name} environment.pluginContainer called before initialized`,
      )
    return this._pluginContainer
  }
  /**
   * @internal
   */
  _pluginContainer: EnvironmentPluginContainer<DevEnvironment> | undefined

  /**
   * @internal
   */
  _closing: boolean = false
  // 关闭标志。关闭期间新到的 transformRequest 会立刻抛 ERR_CLOSED_SERVER
  // （仅当 dev.recoverable 为真），让客户端快速重试而不是排队。
  /**
   * @internal
   */
  _pendingRequests: Map<
    // 正在处理中的请求表，键是 URL。同 URL 并发请求复用一个 promise；
    // 条目里带 timestamp，用于判断复用是否安全（详见 transformRequest.ts）。
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _crawlEndFinder: CrawlEndFinder
  // 「静态 import 爬取结束」检测器：首个请求进来后，等待整棵静态 import 图
  // 处理完，再让 waitForRequestsIdle 的调用方继续。实现见文件末尾。

  /**
  * Hot channel for this environment. If not provided or disabled,
  * it will be a noop channel that does nothing.
  *
  * @example
  * environment.hot.send({ type: 'full-reload' })
  */
  hot: NormalizedHotChannel
  // HMR 通道路由。传入 WebSocketServer 时直接复用；
  // 传入自定义 transport（SSR/远程）时包一层；都没传就是 noop 通道。

  public bundledDev?: BundledDev

  constructor(
    name: string,
    config: ResolvedConfig,
    context: DevEnvironmentContext,
  ) {
    let options = config.environments[name]
    // 配置合并：config.environments[name] 是 resolveConfig 时按环境算好的，
    // context.options 是创建时额外覆盖（例如 createServer 的 inline 配置）。
    if (!options) {
      throw new Error(`Environment "${name}" is not defined in the config.`)
    }
    if (context.options) {
      options = mergeConfig(
        options,
        context.options,
      ) as ResolvedEnvironmentOptions
    }
    super(name, config, options)
    this.safeModulePaths = options.safeModulePaths
      // 全量打包模式（bundledDev / isBundled）下不再需要依赖预构建：
      // 产物由 rolldown 一次性打进内存，模块解析不再依赖 deps 缓存目录。
      // 这一步会在后面把 depsOptimizer 置空。
    if (
      options.isBundled ||
      (name === 'client' && config.experimental.bundledDev)
    ) {
      context.disableDepsOptimizer = true
      this.bundledDev = new BundledDev(this)
    }

    this._pendingRequests = new Map()

    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) =>
      // 模块图的 resolve 回调刻意走 pluginContainer.resolveId，而不是内置解析器：
      // 这样 alias、tsconfig paths、用户插件的解析规则对模块图同样生效，
      // 图里的 id 与实际 transform 用的 id 才保证一致。
      this.pluginContainer!.resolveId(url, undefined),
    )

    this._crawlEndFinder = setupOnCrawlEnd()

    this._remoteRunnerOptions = context.remoteRunner ?? {}
    this._skipFsCheck = !!(
      context.transport &&
      !(isWebSocketServer in context.transport) &&
      context.transport.skipFsCheck
    )

    this.hot = context.transport
      // hot 的三种形态统一成 NormalizedHotChannel：
      //   - ws 直接可用（dev client）；
      //   - 自定义 transport（远程 runner）；
      //   - 无（noop）。
      // 归一化之后，HMR 代码只需要面对 channel，不用关心传输层。
      ? isWebSocketServer in context.transport
        ? context.transport
        : normalizeHotChannel(context.transport, context.hot)
      : normalizeHotChannel({}, context.hot)

    this.hot.setInvokeHandler({
      // 注册 runner 侧可回调的服务端能力：
      //   fetchModule（模块加载）、getBuiltins（内置模块清单）、
      //   resetBundledDevClient（全量打包模式下客户端重连时重建上下文）。
      fetchModule: (id, importer, options) => {
        if (context.disableFetchModule) {
          throw new Error('fetchModule is disabled in this environment')
        }
        return this.fetchModule(id, importer, options)
      },
      getBuiltins: async () => {
        return this.config.resolve.builtins.map((builtin) =>
          typeof builtin === 'string'
            ? { type: 'string', value: builtin }
            : { type: 'RegExp', source: builtin.source, flags: builtin.flags },
        )
      },
      resetBundledDevClient: (oldClientId, newClientId) => {
        if (!this.bundledDev) {
          throw new Error('bundled dev is not enabled in this environment')
        }
        return this.bundledDev.resetClient(oldClientId, newClientId)
      },
    })

      // import.meta.hot.invalidate() 的服务端处理：模块自己声明「我处理不了这个更新」，
      // 于是从它的 importers 重新发起一轮传播（跳过自引用）。
      // 只对 isSelfAccepting 的模块生效，且每个 timestamp 只接受一次，
      // 防止两边互相 invalidate 形成死循环。
    this.hot.on(
      'vite:invalidate',
      ({ path, message, firstInvalidatedBy }, client) => {
        this.invalidateModule(
          {
            path: unwrapId(path),
            message,
            firstInvalidatedBy,
          },
          client,
        )
      },
    )

    if (!context.disableDepsOptimizer) {
      // 依赖预构建器的选择：
      //   - 外部传入（restart 复用）→ 直接用；
      //   - optimizeDeps.disabled → 不建；
      //   - noDiscovery=true → 只预构建 include 里显式列出的依赖；
      //   - 否则 → 扫描 + 自动发现。
      // 注意创建时机在 init() 之前，因为 moduleGraph 的解析可能间接依赖它。
      const { optimizeDeps } = this.config
      if (context.depsOptimizer) {
        this.depsOptimizer = context.depsOptimizer
      } else if (isDepOptimizationDisabled(optimizeDeps)) {
        this.depsOptimizer = undefined
      } else {
        this.depsOptimizer = (
          optimizeDeps.noDiscovery
            ? createExplicitDepsOptimizer
            : createDepsOptimizer
        )(this)
      }
    }
  }

  async init(options?: {
    // init 只做一件事：建 pluginContainer。但它必须显式 await，
    // 因为容器创建时会解析 rolldown options（跑一遍 options hook），
    // 后续任何 resolve 都假设插件已经就绪。
    watcher?: FSWatcher
    /**
     * the previous instance used for the environment with the same name
     *
     * when using, the consumer should check if it's an instance generated from the same class or factory function
     */
    previousInstance?: DevEnvironment
  }): Promise<void> {
    if (this._initiated) {
      return
    }
    this._initiated = true
    this._pluginContainer = await createEnvironmentPluginContainer(
      this,
      this.config.plugins,
      options?.watcher,
    )
  }

  /** @internal */
  async _registerInputsAsSafeModules(): Promise<void> {
    // 把入口模块（index.html 或 config.input）解析后登记为 safe module，
    // 允许它们在 server.fs.allow 之外也能被加载。
    // 传 scan:true 是为了避开死锁：正常解析会等扫描结束，而扫描又在等 buildStart，
    // buildStart 结束时正好会调用本函数。
    const input = this.config.input
    const entries =
      input == null
        ? ['index.html']
        : typeof input === 'string'
          ? [input]
          : Array.isArray(input)
            ? input
            : Object.values(input)

    const resolveEntries = async () => {
      const resolvedEntries = await Promise.all(
        entries.map((entry) =>
          this.pluginContainer.resolveId(entry, undefined, {
            isEntry: true,
            // Avoid a deadlock when the dependency scanner triggers the first
            // buildStart. Normal resolution waits for the scan to finish,
            // while the scan is waiting for buildStart to finish.
            scan: true,
          }),
        ),
      )
      for (const resolved of resolvedEntries) {
        if (resolved && !resolved.external) {
          const file = cleanUrl(resolved.id)
          if (path.isAbsolute(file)) {
            this.safeModulePaths.addId(resolved.id)
          }
        }
      }
    }

    if (input == null) {
      await resolveEntries().catch(() => {})
    } else {
      await resolveEntries()
    }
  }

  /**
   * When the dev server is restarted, the methods are called in the following order:
   * - new instance `init`
   * - previous instance `close`
   * - new instance `listen`
   */
  async listen(server: ViteDevServer): Promise<void> {
    // listen 的职责：开 HMR 通道 → 初始化 bundledDev 与 depsOptimizer → 预热。
    // 重启时的调用顺序是「新实例 init → 旧实例 close → 新实例 listen」，
    // 所以这里可以安全地假设旧环境的资源已经释放。
    this.hot.listen()
    await Promise.all([this.bundledDev?.listen(), this.depsOptimizer?.init()])
    warmupFiles(server, this)
  }

  /**
   * Register a resolved module ID as safe to load in this environment, even
   * outside `server.fs.allow`. Filesystem IDs must be normalized absolute paths
   * and may include a query. `server.fs.deny` still applies.
   * Call from the plugin's `transform` hook when it adds a reference to the module.
   */
  addSafeModule(id: string): void {
    // 插件可以通过 environment.addSafeModule(id) 主动放行 root 外的文件。
    // 典型场景：monorepo 里的共享包、虚拟模块映射到的真实文件。
    this.safeModulePaths.addId(id)
  }

  /**
   * Called by the module runner to retrieve information about the specified
   * module. Internally calls `transformRequest` and wraps the result in the
   * format that the module runner understands.
   * This method is not meant to be called manually.
   */
    // runner 侧（浏览器/远程）拉取模块的入口。它与 transformRequest 的差别只在
    // 返回格式：这里要包成 runner 能执行的形态（含 sourcemap 内联等）。
  fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<FetchResult> {
    return fetchModule(this, id, importer, {
      ...this._remoteRunnerOptions,
      ...options,
    })
  }

  async reloadModule(module: EnvironmentModuleNode): Promise<void> {
    if (this.config.server.hmr !== false && module.file) {
      updateModules(this, module.file, [module], monotonicDateNow())
    }
  }

  transformRequest(url: string): Promise<TransformResult | null> {
    // 本 environment 的 transformRequest 入口。注意它绑定的是 this，
    // 所以 url → 模块的解析、图、预构建器都取本环境的，不会串到 client。
    return transformRequest(this, url, { skipFsCheck: this._skipFsCheck })
  }

  async warmupRequest(url: string): Promise<void> {
    // 预热：只关心「把结果写进缓存」，失败不抛给调用方。
    // 已过期的依赖（ERR_OUTDATED_OPTIMIZED_DEP）属于正常流程，静默忽略。
    if (this.bundledDev) {
      // no-op
      return
    }

    try {
      await transformRequest(this, url, { skipFsCheck: true })
    } catch (e) {
      if (
        e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
        e?.code === ERR_CLOSED_SERVER
      ) {
        // these are expected errors
        return
      }
      // Unexpected error, log the issue but avoid an unhandled exception
      this.logger.error(
        buildErrorMessage(e, [`Pre-transform error: ${e.message}`], false),
        {
          error: e,
          timestamp: true,
        },
      )
    }
  }

    // invalidate 的服务端主体：确认模块存在、可自接受、且本轮尚未处理过，
    // 然后以它的 importers 为起点跑一轮 updateModules。
    // lastHMRTimestamp 传的是「模块上次更新时间」，保证本轮传播的基准一致。
  protected invalidateModule(
    m: {
      path: string
      message?: string
      firstInvalidatedBy: string
    },
    _client: NormalizedHotChannelClient,
  ): void {
    if (this.bundledDev) {
      // full-bundle mode handles `import.meta.hot.invalidate()` fully client-side
      return
    }

    const mod = this.moduleGraph.urlToModuleMap.get(m.path)
    if (
      mod &&
      mod.isSelfAccepting &&
      mod.lastHMRTimestamp > 0 &&
      !mod.lastHMRInvalidationReceived
    ) {
      mod.lastHMRInvalidationReceived = true
      this.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(m.path) +
          (m.message ? ` ${m.message}` : ''),
        { timestamp: true },
      )
      const file = getShortName(mod.file!, this.config.root)
      updateModules(
        this,
        file,
        [...mod.importers].filter((imp) => imp !== mod), // ignore self-imports
        mod.lastHMRTimestamp,
        m.firstInvalidatedBy,
      )
    }
  }

  async close(): Promise<void> {
    // 关闭顺序：先置 _closing 让新请求快速失败，再并行关闭
    // 插件容器 / 预构建器 / 通道，最后等所有 in-flight 请求结束。
    // 等待是循环的：等待期间可能又有新请求注册进来（它们会很快失败）。
    this._closing = true

    this._crawlEndFinder.cancel()
    await Promise.allSettled([
      this.bundledDev ? this.bundledDev.close() : this.pluginContainer.close(),
      this.depsOptimizer?.close(),
      // WebSocketServer is independent of HotChannel and should not be closed on environment close
      isWebSocketServer in this.hot ? Promise.resolve() : this.hot.close(),
      (async () => {
        while (this._pendingRequests.size > 0) {
          await Promise.allSettled(
            [...this._pendingRequests.values()].map(
              (pending) => pending.request,
            ),
          )
        }
      })(),
    ])
  }

  /**
   * Calling `await environment.waitForRequestsIdle(id)` will wait until all static imports
   * are processed after the first transformRequest call. If called from a load or transform
   * plugin hook, the id needs to be passed as a parameter to avoid deadlocks.
   * Calling this function after the first static imports section of the module graph has been
   * processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle(ignoredId?: string): Promise<void> {
    // 等「静态 import 爬取」结束。ignoredId 用于在 load/transform 内部调用时
    // 排除自己，否则会等自己完成而死锁。
    return this._crawlEndFinder.waitForRequestsIdle(ignoredId)
  }

  /**
   * @internal
   */
  _registerRequestProcessing(id: string, done: () => Promise<unknown>): void {
    this._crawlEndFinder.registerRequestProcessing(id, done)
  }
}

const callCrawlEndIfIdleAfterMs = 50
// 静默 50ms 后才判定「爬取结束」：给浏览器并发请求留出到达窗口。
// 太短会把同一批静态 import 的后续请求算成新一批。

interface CrawlEndFinder {
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  cancel: () => void
}

function setupOnCrawlEnd(): CrawlEndFinder {
  // crawlEndFinder 的实现：注册 ← 请求开始；标记完成 ← 请求结束。
  // 注册集合空了之后并不立即 resolve，而是等一个 50ms 的安静期再检查一次，
  // 期间若又来新请求就重新计时。
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    // ignoredId 的处理：把它直接标记为已完成再返回 promise。
    // 注意它同时写 seenIds，防止后续同一个 id 再被登记。
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    } else {
      checkIfCrawlEndAfterTimeout()
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    registeredIds.delete(id)
    checkIfCrawlEndAfterTimeout()
  }

  function checkIfCrawlEndAfterTimeout() {
    // 只有「没有注册中的请求」且「安静期到了」才 resolve；
    // cancelled 之后不再 resolve，避免 server 关闭后还有等待者悬挂。
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    onCrawlEndPromiseWithResolvers.resolve()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}
