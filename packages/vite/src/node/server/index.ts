import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { get as httpGet } from 'node:http'
import type * as http from 'node:http'
import type { Http2SecureServer } from 'node:http2'
import { get as httpsGet } from 'node:https'
import type * as net from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { disableCache, ignoreInput } from '@voidzero-dev/vite-task-client'
import chokidar from 'chokidar'
import connect from 'connect'
import corsMiddleware from 'cors'
import launchEditorMiddleware from 'launch-editor-middleware'
import colors from 'picocolors'
import type { SourceMap } from 'rolldown'
import { detectAgent } from 'std-env'
import type { ModuleRunner } from 'vite/module-runner'
import type { FSWatcher } from '#dep-types/chokidar'
import type { Connect } from '#dep-types/connect'
import type {
  ForwardConsoleOptions,
  ResolvedForwardConsoleOptions,
} from '../../shared/forwardConsole'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isResolvedConfig, resolveConfig } from '../config'
import {
  CLIENT_DIR,
  DEFAULT_DEV_PORT,
  defaultAllowedOrigins,
} from '../constants'
import { warnFutureDeprecation } from '../deprecations'
import { getEnvFilesForMode } from '../env'
import type { CommonServerOptions } from '../http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import type { MinimalPluginContextWithoutEnvironment } from '../plugin'
import { reloadOnTsconfigChange } from '../plugins/esbuild'
import { initPublicFiles } from '../publicDir'
import { bindCLIShortcuts } from '../shortcuts'
import type { BindCLIShortcutsOptions, ShortcutsState } from '../shortcuts'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import type { RequiredExceptFor } from '../typeUtils'
import {
  type Hostname,
  diffDnsOrderChange,
  getServerUrlByHost,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  mergeWithDefaults,
  monotonicDateNow,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
  setupHmrWsOptionCompat,
  setupSIGTERMListener,
  teardownSIGTERMListener,
} from '../utils'
import {
  createNoopWatcher,
  getResolvedOutDirs,
  makeWatcherCloseFinal,
  resolveChokidarOptions,
  resolveEmptyOutDir,
} from '../watch'
import type { ServerWatchOptions } from '../watch'
import type { DevEnvironment } from './environment'
import type { HmrOptions, NormalizedHotChannel, WsOptions } from './hmr'
import { handleHMRUpdate, updateModules } from './hmr'
import { baseMiddleware } from './middlewares/base'
import { errorMiddleware } from './middlewares/error'
import { hostValidationMiddleware } from './middlewares/hostCheck'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import { memoryFilesMiddleware } from './middlewares/memoryFiles'
import { notFoundMiddleware } from './middlewares/notFound'
import { proxyMiddleware } from './middlewares/proxy'
import { rejectInvalidRequestMiddleware } from './middlewares/rejectInvalidRequest'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { isTimeDebugEnabled, timeMiddleware } from './middlewares/time'
import {
  cachedTransformMiddleware,
  transformMiddleware,
} from './middlewares/transform'
import { triggerLazyBundlingMiddleware } from './middlewares/triggerLazyBundling'
import { ModuleGraph } from './mixedModuleGraph'
import type { ModuleNode } from './mixedModuleGraph'
import { openBrowser as _openBrowser } from './openBrowser'
import type { PluginContainer } from './pluginContainer'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
  createPluginContainer,
} from './pluginContainer'
import { searchForPackageRoot, searchForWorkspaceRoot } from './searchRoot'
import type { TransformOptions, TransformResult } from './transformRequest'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'

// ============================================================================
// 文件角色：dev server 的装配厂。

// 这一层不处理任何「模块语义」，只做三件事：
//   1. 把 config 变成可运行的对象图：environments（client/ssr）、watcher、ws、
//      pluginContainer、moduleGraph、depsOptimizer。
//   2. 按固定顺序挂载 connect 中间件链（见下方 “中间件顺序总表”）。
//   3. 把文件系统事件接到 HMR 与各 environment 的 watchChange 上。

// 读法建议：先看 createServer → _createServer 的装配顺序，再跳到中间件挂载处，
// 最后看 watcher 回调。真正的模块处理在 server/middlewares/transform.ts →
// server/transformRequest.ts → server/pluginContainer.ts，不在本文件。
// ============================================================================
const usedConfigs = new WeakSet<ResolvedConfig>()
// 一个 ResolvedConfig 只允许绑定一个 server 实例。
// restart 的做法是「用同一份 inlineConfig 重新 resolve 出新的 config」，
// 因此不会触发这里的检查；若有人拿同一个 config 再 createServer，直接报错，
// 避免两个 server 共享同一份 plugin 实例与缓存而互相踩踏。

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * Configure WebSocket connection options.
   * Set to `false` to disable the WebSocket server and connection.
   */
  ws?: WsOptions | false
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     */
    clientFiles?: string[]
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     */
    ssrFiles?: string[]
  }
  /**
   * File system watcher options, or null to disable FS watching.
   *
   * Accepts chokidar options
   * (https://github.com/paulmillr/chokidar/tree/3.6.0#api), which are used by
   * the chokidar watcher, and Rolldown watch options, which are used by the
   * Rolldown file watcher when bundled dev mode is enabled.
   */
  watch?: ServerWatchOptions | null
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: HttpServer
      }
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)
  /**
   * Backward compatibility. The buildStart and buildEnd hooks were called only once for
   * the client environment. This option enables per-environment buildStart and buildEnd hooks.
   * @default false
   * @experimental
   */
  perEnvironmentStartEndDuringDev?: boolean
  /**
   * Backward compatibility. The watchChange hook was called only once for the client environment.
   * This option enables per-environment watchChange hooks.
   * @default false
   * @experimental
   */
  perEnvironmentWatchChangeDuringDev?: boolean
  /**
   * Run HMR tasks, by default the HMR propagation is done in parallel for all environments
   * @experimental
   */
  hotUpdateEnvironments?: (
    server: ViteDevServer,
    hmr: (environment: DevEnvironment) => Promise<void>,
  ) => Promise<void>

  forwardConsole?: boolean | ForwardConsoleOptions
}

export interface ResolvedServerOptions extends Omit<
  RequiredExceptFor<
    ServerOptions,
    | 'host'
    | 'https'
    | 'proxy'
    | 'hmr'
    | 'ws'
    | 'watch'
    | 'origin'
    | 'hotUpdateEnvironments'
  >,
  'fs' | 'middlewareMode' | 'sourcemapIgnoreList' | 'forwardConsole'
> {
  fs: Required<FileSystemServeOptions>
  middlewareMode: NonNullable<ServerOptions['middlewareMode']>
  sourcemapIgnoreList: Exclude<
    ServerOptions['sourcemapIgnoreList'],
    false | undefined
  >
  forwardConsole: ResolvedForwardConsoleOptions
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `'extended'` to also check all modules before plugin load hooks.
   * Set to `false` to disable the restrictions.
   *
   * @default true
   */
  strict?: boolean | 'extended'

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**\/.git/**']
   */
  deny?: string[]
}

export type ServerHook = (
  this: MinimalPluginContextWithoutEnvironment,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export interface CloseServerHookContext {
  /**
   * Whether the server is being restarted (e.g. a config change or
   * `server.restart()`) or closed (e.g. the `q` shortcut, SIGTERM, stdin
   * ending, or `server.close()`).
   */
  reason: 'restart' | 'close'
}

export type CloseServerHook = (
  this: MinimalPluginContextWithoutEnvironment,
  context: CloseServerHookContext,
) => void | Promise<void>

export type HttpServer = http.Server | Http2SecureServer

export async function resolveForwardConsoleOptions(
  value: boolean | ForwardConsoleOptions | undefined,
): Promise<ResolvedForwardConsoleOptions> {
  value ??= !!detectAgent().name

  if (value === false) {
    return {
      enabled: false,
      unhandledErrors: false,
      logLevels: [],
    }
  }

  if (value === true) {
    return {
      enabled: true,
      unhandledErrors: true,
      logLevels: ['error', 'warn'],
    }
  }

  const unhandledErrors = value.unhandledErrors ?? true
  const logLevels = value.logLevels ?? []

  return {
    enabled: unhandledErrors || logLevels.length > 0,
    unhandledErrors,
    logLevels,
  }
}

interface ServerRestartState {
  promise: Promise<void> | null
  pending: boolean
  forceOptimize: boolean
}

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: HttpServer | null
  /**
   * Chokidar watcher instance. If `config.server.watch` is set to `null`,
   * it will not watch any files and calling `add` or `unwatch` will have no effect.
   * https://github.com/paulmillr/chokidar/tree/3.6.0#api
   */
  watcher: FSWatcher
  /**
   * WebSocket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * An alias to `server.environments.client.hot`.
   * If you want to interact with all environments, loop over `server.environments`.
   */
  hot: NormalizedHotChannel
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module execution environments attached to the Vite server.
   */
  environments: Record<'client' | 'ssr' | (string & {}), DevEnvironment>
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * in middleware mode or if the server is not listening on any port.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Same as `transformRequest` but only warm up the URLs so the next request
   * will already be cached. The function will never throw as it handles and
   * reports errors internally.
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: '' } | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * Open browser
   */
  openBrowser(): void
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  /**
   * @internal
   */
  _setInternalServer(server: ViteDevServer): void
  /**
   * Internal close implementation shared by `close()` and `restart()`. The
   * `reason` is forwarded to `closeServer` plugin hooks so they can distinguish
   * a restart from a real close.
   * @internal
   */
  _closeServer(reason: 'restart' | 'close'): Promise<void>
  /**
   * @internal
   */
  _shortcutsState?: ShortcutsState<ViteDevServer>
  /**
   * @internal
   */
  _currentServerPort?: number | undefined
  /**
   * @internal
   */
  _configServerPort?: number | undefined
  /**
   * @internal
   */
  _ssrCompatModuleRunner?: ModuleRunner
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
  /**
   * Names of the network interface that each {@link ResolvedServerUrls.network}
   * URL is bound to, in the same order as `network`. An entry is `undefined`
   * when the interface name is not known, for example when an explicit `host`
   * is set.
   */
  networkInterfaceNames?: (string | undefined)[]
}

// 对外入口。固定 listen=true：调用方拿到 server 时端口已经打开。
// 内部 _createServer 还要服务 restart 场景（listen=false，先建对象后监听），
// 所以真正的参数在下面那个函数。
export function createServer(
  inlineConfig: InlineConfig | ResolvedConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { listen: true })
}

// 装配入口。顺序是有依赖的，不要随意重排：
//   resolveConfig（产出 environments 描述）→ 建 http server / ws → 建 watcher
//   → 逐个 environment.init()（各自建 pluginContainer、moduleGraph、depsOptimizer）
//   → 兼容层 moduleGraph/pluginContainer → 挂中间件 → 覆写 httpServer.listen。
// 注意 environment.init 在挂中间件之前，因为中间件闭包会直接引用 environment 对象。
export async function _createServer(
  inlineConfig: ResolvedConfig | InlineConfig | undefined = {},
  options: {
    listen: boolean
    previousEnvironments?: Record<string, DevEnvironment>
    previousShortcutsState?: ShortcutsState<ViteDevServer>
    restartState?: ServerRestartState
  },
): Promise<ViteDevServer> {
  // The dev server is a long-running, interactive process whose outputs
  // (network responses, HMR updates) cannot be replayed from a cache.
  disableCache()
  // dev server 是长驻交互进程，响应与 HMR 推送都无法从缓存重放。
  // 这里关掉 Vite Task 的缓存，避免 CI 里把 dev server 的输出当成可缓存产物。

  const restartState = options.restartState ?? {
    promise: null,
    pending: false,
    forceOptimize: false,
  }

  const config = isResolvedConfig(inlineConfig)
    // config 可能已经是 resolve 过的（restart 路径传入 ResolvedConfig）。
    // command 必须是 'serve'：build 与 serve 的 environment 集合、插件 apply 结果都不同，
    // 混用会得到一份「看起来能用但缺 dev 插件」的配置。
    ? inlineConfig
    : await resolveConfig(inlineConfig, 'serve')

  if (usedConfigs.has(config)) {
    throw new Error(`There is already a server associated with the config.`)
  }

  if (config.command !== 'serve') {
    throw new Error(
      `Config was resolved for a "build", expected a "serve" command.`,
    )
  }

  usedConfigs.add(config)
  // 标记该 config 已被占用（配合文件顶部的 usedConfigs 检查）。

  const initPublicFilesPromise = initPublicFiles(config)
  // public 目录的文件列表是异步扫描的，这里先发起、稍后 await。
  // 它与后面的 ws/watcher 初始化无依赖，并行可以少一次磁盘往返。

  const { root, server: serverConfig } = config
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  const { middlewareMode } = serverConfig

  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rolldownOptions.output,
  )
  const emptyOutDir = resolveEmptyOutDir(
    config.build.emptyOutDir,
    config.root,
    resolvedOutDirs,
  )
  const resolvedWatchOptions = resolveChokidarOptions(
    {
      disableGlobbing: true,
      ...serverConfig.watch,
    },
    resolvedOutDirs,
    emptyOutDir,
    config.cacheDir,
  )

  const middlewares = connect() as Connect.Server
  // connect 实例是中间件链的容器。后续所有 use() 的顺序即请求处理顺序。
  // middlewareMode 下不建 http server，这个 connect 实例交给宿主框架挂载。
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(middlewares, httpsOptions)

  const ws = createWebSocketServer(httpServer, config, httpsOptions)
  // WebSocket 服务在这里创建，但真正的 listen 延迟到 environment.listen()。
  // 原因：restart 时希望先替换掉整个 server 对象再开始接收连接。

  const publicFiles = await initPublicFilesPromise
  const { publicDir } = config

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }

  // watcher 监听三类路径：
  //   1. root（bundledDev 模式下不监听，因为产物由 rolldown 的 watcher 管）
  //   2. 配置文件依赖（vite.config 及其 import 的文件，可能在 root 外）
  //   3. .env 文件与 public 目录（两者都可能位于 root 之外）
  // watch: null 时用 noop watcher，保证调用方不用判空。
  // eslint-disable-next-line eqeqeq
  const watchEnabled = serverConfig.watch !== null
  const watcher = watchEnabled
    // config file dependencies and env file might be outside of root
    ? makeWatcherCloseFinal(
        chokidar.watch(
          [
            ...(config.experimental.bundledDev ? [] : [root]),
            ...config.configFileDependencies,
            ...getEnvFilesForMode(config.mode, config.envDir),
            // Watch the public directory explicitly because it might be outside
            // of the root directory.
            ...(publicDir && publicFiles ? [publicDir] : []),
          ],

          resolvedWatchOptions,
        ) as FSWatcher,
      )
    : createNoopWatcher(resolvedWatchOptions)

  watcher.on('error', (error: Error) => {
    config.logger.error(colors.red(`file watcher error: ${error.message}`))
  })

  const environments: Record<string, DevEnvironment> = {}
  // 每个 environment 自己 init：建 pluginContainer（各自一份插件实例状态）、
  // moduleGraph、depsOptimizer，并挂到 ws 上。
  // previousInstance 只在 restart 时传入，用于复用「不必重建」的状态（如已预构建的依赖）。

  await Promise.all(
    Object.entries(config.environments).map(
      async ([name, environmentOptions]) => {
        const environment = await environmentOptions.dev.createEnvironment(
          name,
          config,
          {
            ws,
          },
        )
        environments[name] = environment

        const previousInstance =
          options.previousEnvironments?.[environment.name]
        await environment.init({ watcher, previousInstance })
      },
    ),
  )

  // Release previous environments after initialization to prevent memory leaks
  // from retaining old server graphs across restarts.
  options.previousEnvironments = undefined

  // Backward compatibility
// ---- 向后兼容层 ----
// Vite 6 起 environment 是一等概念；但大量生态代码仍访问 server.moduleGraph /
// server.pluginContainer（默认 client，ssr 用 options.ssr 区分）。
// 下面两个对象只是转发器：读属性时会触发 future deprecation 警告，
// 真正实现分别在 environment.moduleGraph 与 environment.pluginContainer。

  let moduleGraph = new ModuleGraph({
    client: () => environments.client.moduleGraph,
    ssr: () => environments.ssr.moduleGraph,
  })
  let pluginContainer = createPluginContainer(environments)

  const closeHttpServer = createServerCloseFn(httpServer)

  const devHtmlTransformFn = createDevHtmlTransformFn(config)

  // Promise used by `server.close()` to ensure `closeServer()` is only called once
  let closeServerPromise: Promise<void> | undefined
  const closeServer = async (reason: 'restart' | 'close') => {
    // 关闭顺序与启动相反：先停「会产生新工作」的源（watcher/ws），
    // 再等各 environment 收尾，最后关 http server 与兼容 runner。
    // 用 allSettled 而不是 all：某一项关闭失败不应该阻止其它资源释放。
    // closeServer 插件钩子在拆除完成后调用，因此钩子里不能再假设 server 可用。
    if (!middlewareMode) {
      teardownSIGTERMListener(closeServerAndExit)
    }

    await Promise.allSettled([
      watcher.close(),
      ws.close(),
      Promise.allSettled(
        Object.values(server.environments).map((environment) =>
          environment.close(),
        ),
      ),
      closeHttpServer(),
      server._ssrCompatModuleRunner?.close(),
    ])
    server.resolvedUrls = null
    server._ssrCompatModuleRunner = undefined

    // Run `closeServer` plugin hooks after the server has been torn down.
    const closeServerContext = new BasicMinimalPluginContext(
      { ...basePluginContextMeta, watchMode: true },
      config.logger,
    )
    await Promise.all(
      config
        .getSortedPluginHooks('closeServer')
        .map((hook) => hook.call(closeServerContext, { reason })),
    )
  }

  let hot = ws
  // server.hot 是 client environment 的 hot 通道的别名（v6 之前 ws 本身就是 hot）。
  // 这里保留 getter/setter 兼容旧代码，实际数据在 environment 里。
  let server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    ws,
    get hot() {
      warnFutureDeprecation(config, 'removeServerHot')
      return hot
    },
    set hot(h) {
      hot = h
    },

    environments,
    get pluginContainer() {
      warnFutureDeprecation(config, 'removeServerPluginContainer')
      return pluginContainer
    },
    set pluginContainer(p) {
      pluginContainer = p
    },
    get moduleGraph() {
      warnFutureDeprecation(config, 'removeServerModuleGraph')
      return moduleGraph
    },
    set moduleGraph(graph) {
      moduleGraph = graph
    },

    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: '' } | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, {
        json: {
          // 兼容入口：旧 API 通过 options.ssr 选 environment，新 API 直接用
          // server.environments[name].transformRequest。两者最终走同一条实现
          // （server/transformRequest.ts 的 transformRequest）。
          stringify:
            config.json.stringify === true && config.json.namedExports !== true,
        },
      })
    },
    transformRequest(url, options) {
      warnFutureDeprecation(config, 'removeServerTransformRequest')
      const environment = server.environments[options?.ssr ? 'ssr' : 'client']
      return environment.transformRequest(url)
    },
    warmupRequest(url, options) {
      warnFutureDeprecation(config, 'removeServerWarmupRequest')
      const environment = server.environments[options?.ssr ? 'ssr' : 'client']
      return environment.warmupRequest(url)
    },
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      warnFutureDeprecation(config, 'removeSsrLoadModule')
      return ssrLoadModule(url, server, opts?.fixStacktrace)
    },
    ssrFixStacktrace(e) {
      warnFutureDeprecation(
        config,
        'removeSsrLoadModule',
        "ssrFixStacktrace doesn't need to be used for Environment Module Runners.",
      )
      ssrFixStacktrace(e, server.environments.ssr.moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      warnFutureDeprecation(
        config,
        'removeSsrLoadModule',
        "ssrRewriteStacktrace doesn't need to be used for Environment Module Runners.",
      )
      return ssrRewriteStacktrace(stack, server.environments.ssr.moduleGraph)
        .result
    },
    async reloadModule(module) {
      warnFutureDeprecation(config, 'removeServerReloadModule')
      if (serverConfig.hmr !== false && module.file) {
        // TODO: Should we also update the node moduleGraph for backward compatibility?
        const environmentModule = (module._clientModule ?? module._ssrModule)!
        updateModules(
          environments[environmentModule.environment]!,
          module.file,
          [environmentModule],
          monotonicDateNow(),
        )
      }
    },
    async listen(port?: number, isRestart?: boolean) {
      // listen 分两步：先解析 hostname 并注册 listening 回调（此时才知道真实端口，
      // 因为 port 可能被系统分配或顺延），再交给 startServer 真正 bind。
      // restart 时不自动开浏览器：用户已经在页面上，重复开 tab 只会制造噪音。
      const hostname = await resolveHostname(config.server.host)
      if (httpServer) {
        httpServer.prependListener('listening', () => {
          server.resolvedUrls = resolveServerUrls(
            httpServer,
            config.server,
            hostname,
            httpsOptions,
            config,
          )
        })
      }
      await startServer(server, hostname, port)
      if (httpServer) {
        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    openBrowser() {
      const options = server.config.server
      const url = getServerUrlByHost(server.resolvedUrls, options.host)
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    async close() {
      return server._closeServer('close')
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('Cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'Cannot print server URLs before server.listen is called.',
        )
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options)
    },
    async restart(forceOptimize?: boolean) {
      // restart 的并发语义：同一时刻只允许一个 restart 在跑。
      // 期间再来请求只置 pending=true，由外层 do/while 合并成一次额外重启，
      // 避免「配置文件连续保存」把 server 拆了建、建了拆。
      restartState.forceOptimize ||= !!forceOptimize
      if (restartState.promise) {
        restartState.pending = true
        return restartState.promise
      }
      restartState.promise = (async () => {
        try {
          do {
            restartState.pending = false
            await restartServer(server, restartState)
          } while (restartState.pending)
        } finally {
          restartState.promise = null
          restartState.pending = false
          restartState.forceOptimize = false
        }
      })()
      return restartState.promise
    },

    waitForRequestsIdle(ignoredId?: string): Promise<void> {
      return environments.client.waitForRequestsIdle(ignoredId)
    },

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _closeServer(reason: 'restart' | 'close') {
      if (!closeServerPromise) {
        closeServerPromise = closeServer(reason)
      }
      return closeServerPromise
    },
    _shortcutsState: options.previousShortcutsState,
  }

  // maintain consistency with the server instance after restarting.
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      return server[property]
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      server[property] = value
      return true
    },
  })

  const closeServerAndExit = async (_: unknown, exitCode?: number) => {
    try {
      await server.close()
    } finally {
      process.exitCode ??= exitCode ? 128 + exitCode : undefined
      process.exit()
    }
  }

  if (!middlewareMode) {
    setupSIGTERMListener(closeServerAndExit)
  }

    // 文件事件的统一出口：先让插件 watchChange 看到（插件可能要清自己的缓存），
            // 再让 moduleGraph 标记失效，最后交给 HMR 决定是热更新还是整页刷新。
  const onHMRUpdate = async (
    type: 'create' | 'delete' | 'update',
    file: string,
  ) => {
    if (serverConfig.hmr !== false) {
      await handleHMRUpdate(type, file, server)
    }
  }

  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    // add / unlink 额外处理两件事：
    //   1. public 目录增删要同步 publicFiles 集合；
    //      同名模块的 etag 要从 etagToModuleMap 里摘掉，否则缓存中间件会把
    //      「本该由 public 文件胜出」的请求 304 回一个旧模块。
    //   2. unlink 要清 moduleGraph 的文件缓存，避免继续按旧 file 关系做 HMR 传播。
    file = normalizePath(file)
    reloadOnTsconfigChange(server, file)

    await Promise.all(
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, {
          event: isUnlink ? 'delete' : 'create',
        }),
      ),
    )

    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        const path = file.slice(publicDir.length)
        publicFiles[isUnlink ? 'delete' : 'add'](path)
        if (!isUnlink) {
          const clientModuleGraph = server.environments.client.moduleGraph
          const moduleWithSamePath =
            await clientModuleGraph.getModuleByUrl(path)
          const etag = moduleWithSamePath?.transformResult?.etag
          if (etag) {
            // The public file should win on the next request over a module with the
            // same path. Prevent the transform etag fast path from serving the module
            clientModuleGraph.etagToModuleMap.delete(etag)
          }
        }
      }
    }
    if (isUnlink) {
      // invalidate module graph cache on file change
      for (const environment of Object.values(server.environments)) {
        environment.moduleGraph.onFileDelete(file)
      }
    }
    await onHMRUpdate(isUnlink ? 'delete' : 'create', file)
  }

  const onFileChange = async (file: string) => {
    // change 事件不删 moduleGraph 条目，只标失效：HMR 需要沿 importers 往上找 accept 边界，
    // 图结构必须还在。真正的重写发生在下一次 transformRequest。
    file = normalizePath(file)
    reloadOnTsconfigChange(server, file)

    await Promise.all(
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, { event: 'update' }),
      ),
    )
    // invalidate module graph cache on file change
    for (const environment of Object.values(server.environments)) {
      environment.moduleGraph.onFileChange(file)
    }
    await onHMRUpdate('update', file)
  }

  watcher.on('change', (file) => {
    // watcher 的事件回调是 fire-and-forget；错误只能记日志，
    // 因为 chokidar 不会等我们，也没有调用方可以接住异常。
    onFileChange(file).catch((e) => server.config.logger.error(e))
  })

  watcher.on('add', (file) => {
    onFileAddUnlink(file, false).catch((e) => server.config.logger.error(e))
  })
  watcher.on('unlink', (file) => {
    onFileAddUnlink(file, true).catch((e) => server.config.logger.error(e))
  })

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  // Pre applied internal middlewares ------------------------------------------
// ============================================================================
// 中间件顺序总表（自上而下即请求处理顺序，顺序本身是协议的一部分）：

  //   time（DEBUG 计时）
  //   rejectInvalidRequest   拒绝非法 URL（如带 \0 / 非 GET 的畸形请求）
  //   cors
  //   hostValidation         DNS rebinding 防护；HTTPS 下跳过（HTTPS 不受该攻击影响）
  //   [configureServer 用户中间件]   ← 用户插件在这里插入自己的中间件
  //   cachedTransform        仅按 etag 回 304，不产出内容
  //   proxy                  server.proxy 转发；必须在 base/static 之前，否则代理路径被当成本地文件
  //   base                   非 '/' base 的路径剥离与重定向
  //   /__open-in-editor      点击报错栈里的文件链接
  //   viteHMRPingMiddleware  以 Accept: text/x-vite-ping 探活，回 204
  //   servePublic            public 目录原样返回，必须在 transform 之前（public 文件不参与转换）
  //   transformMiddleware    模块请求的主入口（JS/CSS/worker/wasm/html proxy）
  //   serveRawFs             /@fs/ 原文件
  //   serveStatic            root 下的静态文件（图片等）
  //   htmlFallback           SPA/MPA 的路径补全（/foo → /foo.html）
  //   [configureServer 的 post 钩子]  用户想在 index.html 之前接管请求时用
  //   indexHtmlMiddleware    最终返回转换后的 index.html
  //   notFound / errorMiddleware

  // 关键点：transform 在 static 之前。模块路径优先按「需要编译的源码」解释，
  // 解析不到时才回落到「当成静态文件直接返回」。
  // ============================================================================

  // request timer
  if (isTimeDebugEnabled) {
    middlewares.use(timeMiddleware(root))
  }

  middlewares.use(rejectInvalidRequestMiddleware())

  // cors
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // host check (to prevent DNS rebinding attacks)
  const { allowedHosts } = serverConfig
  // no need to check for HTTPS as HTTPS is not vulnerable to DNS rebinding attacks
  if (allowedHosts !== true && !serverConfig.https) {
    middlewares.use(hostValidationMiddleware(allowedHosts, false))
  }

  // apply configureServer hooks ------------------------------------------------

  const configureServerContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook.call(configureServerContext, reflexServer))
  }

  // Internal middlewares ------------------------------------------------------

  if (!config.experimental.bundledDev) {
    // 缓存中间件放在用户中间件之后：用户中间件若命中就不该被 etag 短路。
    // 它只做一件事——请求带 If-None-Match 且与 moduleGraph 里记录的 etag 一致时回 304，
    // 省掉 transform。CSS 请求要排除：同一文件可能同时以「直接请求」和「被 import」
    // 两种身份存在，etag 会混用。
    // bundledDev 模式下模块不经过这里（产物来自 rolldown 的内存文件系统）。
    middlewares.use(cachedTransformMiddleware(server))
  }

  // proxy
  const { proxy } = serverConfig
  // proxy 必须在 base 与 static 之前：代理前缀（如 /api）不应被当成 root 下的路径。
  if (proxy) {
    const middlewareServer =
      (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config))
  }

  // base
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode))
  }

  // open in editor support
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // ping request handler
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    // HMR 探活：浏览器端用 fetch(..., {headers:{Accept:'text/x-vite-ping'}}) 判断 server 是否还活着。
    // 用 204 而不是 200，避免任何 body 解析。
    if (req.headers.accept === 'text/x-vite-ping') {
      res.writeHead(204).end()
    } else {
      next()
    }
  })

  // serve static files under /public
  // public 目录先于 transform：public 里的文件约定「原样返回、不参与编译」，
  // 若让 transform 先看到，.js 文件会被当成模块处理，语义就变了。
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (publicDir) {
    middlewares.use(servePublicMiddleware(server, publicFiles))
  }

  if (config.experimental.bundledDev) {
    // bundledDev 与普通 dev 是两条互斥的请求路径：
    //   bundledDev：rolldown 在内存里产出整包，中间件只负责触发构建与读内存文件；
    //   普通 dev：按模块请求即时 transform（下面这条链）。
    // 二者不能同时挂，否则同一 URL 会有两个生产者。
    middlewares.use(triggerLazyBundlingMiddleware(server))
    middlewares.use(memoryFilesMiddleware(server))
  } else {
    // main transform middleware
    middlewares.use(transformMiddleware(server))

    // serve static files
    middlewares.use(serveRawFsMiddleware(server))
    middlewares.use(serveStaticMiddleware(server))
  }

  // html fallback
  if (config.appType === 'spa' || config.appType === 'mpa') {
    // htmlFallback 只对 spa/mpa 生效：把 /foo 补成 /foo.html 或 /index.html，
    // 再由 indexHtmlMiddleware 统一注入。
    middlewares.use(
      htmlFallbackMiddleware(
        root,
        config.appType === 'spa',
        server.environments.client,
      ),
    )
  }

  // apply configureServer post hooks ------------------------------------------
// configureServer 返回的函数（post hook）在这里执行：
// 它们注册的中间件会排在 indexHtml 之前、内置 transform/static 之后，
// 适合覆盖 index.html 或做最后的兜底处理。

  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(root, server))

    // handle 404s
    middlewares.use(notFoundMiddleware())
  }

  // error handler
  middlewares.use(errorMiddleware(server, !!middlewareMode))
  // 错误中间件必须最后挂：前面任何一环 next(err) 都会落到这里，
  // 由它决定是渲染 overlay 还是返回 500。

  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  let initingServer: Promise<void> | undefined
  let serverInited = false
  const initServer = async (onListen: boolean) => {
    // initServer 保证只执行一次（listen 可能被多次调用）：
    //   - 非 bundledDev 下先给 client environment 跑 buildStart（历史兼容：
    //     v5 之前 dev 只跑一次 buildStart，其它 environment 在首个请求时懒启动）；
    //   - 然后各 environment.listen(server)，其中包括依赖预构建的首次执行。
    // 因此「预构建发生在监听端口之前」是这一行保证的，不是 listen 本身。
    if (serverInited) return
    if (initingServer) return initingServer

    initingServer = (async function () {
      if (!config.experimental.bundledDev) {
        // For backward compatibility, we call buildStart for the client
        // environment when initing the server. For other environments
        // buildStart will be called when the first request is transformed
        await environments.client.pluginContainer.buildStart()
      }

      // ensure ws server started
      if (onListen || options.listen) {
        await Promise.all(
          Object.values(environments).map((e) => e.listen(server)),
        )
      }

      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }

  if (!middlewareMode && httpServer) {
    // 覆写 httpServer.listen：把 initServer 插到真正 bind 之前。
    // 这样用户调用 server.listen() 时，端口打开时依赖已经预构建完，
    // 首个浏览器请求不会撞上「依赖还没准备好」。
    // 非 middlewareMode 才需要；middlewareMode 下没有自己的 httpServer，直接 init。
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        await initServer(true)
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }) as any
  } else {
    await initServer(false)
  }

  return server
}

  // 端口策略：strictPort=false 时允许顺延，但 restart 要尽量留在原端口，
  // 否则浏览器里已打开的 tab 会指向一个失效 URL。
  // _configServerPort 记录「配置里的端口」，_currentServerPort 记录「实际端口」，
  // 两者不同说明发生过顺延。
async function startServer(
  server: ViteDevServer,
  hostname: Hostname,
  inlinePort?: number,
): Promise<void> {
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server
  const configPort = inlinePort ?? options.port
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, except if the config port changed.
  const port =
    configPort === server._configServerPort
      ? (server._currentServerPort ?? configPort)
      : configPort
  server._configServerPort = configPort

  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  })
  server._currentServerPort = serverPort
}

  // 关闭 http server 时主动 destroy 所有 socket：
  // keep-alive 连接会让 server.close() 一直等待，dev server 关闭就会卡住。
  // hasListened 用来区分「从未监听」——此时 close 会报 ERR_SERVER_NOT_RUNNING。
export function createServerCloseFn(
  server: HttpServer | null,
): () => Promise<void> {
  if (!server) {
    return () => Promise.resolve()
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

const _serverConfigDefaults = Object.freeze({
  port: DEFAULT_DEV_PORT,
  strictPort: false,
  host: 'localhost',
  allowedHosts: [],
  https: undefined,
  open: false,
  proxy: undefined,
  cors: { origin: defaultAllowedOrigins },
  headers: {},
  // hmr
  // ws
  warmup: {
    clientFiles: [],
    ssrFiles: [],
  },
  // watch
  middlewareMode: false,
  fs: {
    strict: true,
    // allow
    deny: [
      '.env',
      '.env.*',
      '*.{crt,pem,key,p12,pfx,cer,der}',
      '.npmrc',
      '.yarnrc.yml',
      '**/.git/**',
    ],
  },
  // origin
  preTransformRequests: true,
  // sourcemapIgnoreList
  perEnvironmentStartEndDuringDev: false,
  perEnvironmentWatchChangeDuringDev: false,
  // hotUpdateEnvironments
  forwardConsole: undefined,
} satisfies ServerOptions)
export const serverConfigDefaults: Readonly<Partial<ServerOptions>> =
  _serverConfigDefaults

const RESERVED_ALLOWED_HOSTS_CHARACTERS_RE = /[\\"']/

  // server 配置归一化。除了填默认值，这里做了三件与安全/可访问性相关的事：
  //   1. fs.allow 默认取 workspace root（pnpm/yarn 的包可能软链到 root 之外）；
  //   2. yarn PnP / pnpm 全局 virtual store 的缓存目录要额外加进 allow，否则依赖读不到；
  //   3. CLIENT_DIR（@vite/client）在 vite 自身位于 root 之外时必须显式放行。
export async function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): Promise<ResolvedServerOptions> {
  const _server = mergeWithDefaults(
    {
      ..._serverConfigDefaults,
      host: undefined, // do not set here to detect whether host is set or not
      sourcemapIgnoreList: isInNodeModules,
    },
    raw ?? {},
  )

  setupHmrWsOptionCompat(_server)

  const workspaceRoot = searchForWorkspaceRoot(root)
  const server: ResolvedServerOptions = {
    ..._server,
    fs: {
      ..._server.fs,
      // run searchForWorkspaceRoot only if needed
      allow: raw?.fs?.allow ?? [workspaceRoot],
    },
    sourcemapIgnoreList:
      _server.sourcemapIgnoreList === false
        ? () => false
        : _server.sourcemapIgnoreList,
    forwardConsole: await resolveForwardConsoleOptions(_server.forwardConsole),
  }

  let allowDirs = server.fs.allow

  const cwd = searchForPackageRoot(root)
  if (process.versions.pnp) {
    // running a command fails if cwd doesn't exist and root may not exist
    // search for package root to find a path that exists
    try {
      const enableGlobalCache =
        execSync('yarn config get enableGlobalCache', {
          cwd,
          windowsHide: true,
        })
          .toString()
          .trim() === 'true'
      const yarnCacheDir = execSync(
        `yarn config get ${enableGlobalCache ? 'globalFolder' : 'cacheFolder'}`,
        { cwd, windowsHide: true },
      )
        .toString()
        .trim()
      allowDirs.push(yarnCacheDir)
    } catch (e) {
      logger.warn(`Get yarn cache dir error: ${e.message}`, {
        timestamp: true,
      })
    }
  }

  // pnpm's global virtual store (GVS) may place package files outside workspace root.
  // pnpm 的全局虚拟 store 可能把包实体放在 workspace 之外。
  // 读 node_modules/.modules.yaml 里的 virtualStoreDir 是最稳的探测方式
  // （比嗅探启动器/子进程更可靠）。读不到就静默跳过——不是 pnpm 项目。
  // Read node_modules/.modules.yaml which pnpm always writes on install — this works
  // unconditionally regardless of how Vite is launched (node / npx / pnpm run),
  // avoiding the need for subprocess calls or user-agent sniffing.
  // Use workspace root (not package root) because .modules.yaml lives at the
  // monorepo root's node_modules/, not in nested workspace packages.
  const pnpmModulesYaml = path.join(
    workspaceRoot,
    'node_modules',
    '.modules.yaml',
  )
  // pnpm rewrites .modules.yaml on every install (e.g. its `prunedAt`
  // timestamp). Tell Vite Task to ignore it, so an install alone doesn't
  // invalidate cached builds.
  ignoreInput(pnpmModulesYaml)
  try {
    const content = fs.readFileSync(pnpmModulesYaml, 'utf-8')
    const parsed = JSON.parse(content)
    const virtualStoreDir = parsed.virtualStoreDir
    if (virtualStoreDir) {
      if (path.isAbsolute(virtualStoreDir)) {
        allowDirs.push(virtualStoreDir)
      } else if (virtualStoreDir.startsWith('..')) {
        allowDirs.push(
          path.resolve(
            path.join(workspaceRoot, 'node_modules'),
            virtualStoreDir,
          ),
        )
      }
    }
  } catch {
    // .modules.yaml not found or unreadable — not a pnpm project, skip
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs.allow = allowDirs

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

    // 允许通过环境变量追加 allowedHosts（容器/预览域名场景），
    // 但含引号或反斜杠的值直接拒绝，避免把注入内容写进 Host 校验规则。
  if (
    process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS &&
    Array.isArray(server.allowedHosts)
  ) {
    const rawAdditionalHosts =
      process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
    if (RESERVED_ALLOWED_HOSTS_CHARACTERS_RE.test(rawAdditionalHosts)) {
      logger.warn(
        colors.yellow(
          `${colors.bold('(!)')} Skipping additional allowed hosts from environment variable due to reserved characters. Received: "${rawAdditionalHosts}".`,
        ),
      )
    } else {
      const additionalHosts = rawAdditionalHosts
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
      server.allowedHosts = [...server.allowedHosts, ...additionalHosts]
    }
  }

  return server
}

  // restart 的实现是「新建一个 server，再把属性覆盖到旧对象上」：
  // 用户持有的 server 引用不变，但内部 environments / 中间件栈 / 插件全部换新。
  // 中间件栈用 stack 替换而不是整个 connect 实例替换，是为了让
  // app.use(vite.middlewares) 这种宿主挂载方式在 restart 后仍然有效。
async function restartServer(
  server: ViteDevServer,
  restartState: ServerRestartState,
) {
  global.__vite_start_time = performance.now()

  let inlineConfig = server.config.inlineConfig
  if (restartState.forceOptimize) {
    inlineConfig = mergeConfig(inlineConfig, {
      forceOptimizeDeps: true,
    })
  }

  // Reinit the server by creating a new instance using the same inlineConfig
  // This will trigger a reload of the config file and re-create the plugins and
  // middlewares. We then assign all properties of the new server to the existing
  // server instance and set the user instance to be used in the new server.
  // This allows us to keep the same server instance for the user.
  {
    let newServer: ViteDevServer | null = null
    try {
      // delay ws server listen
      newServer = await _createServer(inlineConfig, {
        listen: false,
        previousEnvironments: server.environments,
        previousShortcutsState: server._shortcutsState,
        restartState,
      })
    } catch (err: any) {
      server.config.logger.error(err.message, {
        timestamp: true,
      })
      server.config.logger.error('server restart failed', { timestamp: true })
      return
    }

    // Detach readline so close handler skips it. Reused to avoid stdin issues
    server._shortcutsState = undefined

    // Close with reason 'restart' so `closeServer` hooks can distinguish a
    // restart from a real close.
    await server._closeServer('restart')

    // Assign new server props to existing server instance
    const middlewares = server.middlewares
    newServer._configServerPort = server._configServerPort
    newServer._currentServerPort = server._currentServerPort
    Object.assign(server, newServer)

    // Keep the same connect instance so app.use(vite.middlewares) works
    // after a restart in middlewareMode (.route is always '/')
    middlewares.stack = newServer.middlewares.stack
    server.middlewares = middlewares

    // Rebind internal server variable so functions reference the user server
    newServer._setInternalServer(server)
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
  } else {
    await Promise.all(
      Object.values(server.environments).map((e) => e.listen(server)),
    )
  }
  logger.info('server restarted.', { timestamp: true })

  if (
    (server._shortcutsState as ShortcutsState<ViteDevServer> | undefined)
      ?.options
  ) {
    bindCLIShortcuts(
      server,
      { print: false },
      // Skip environment checks since shortcuts were bound before restart
      true,
    )
  }
}

/**
 * Internal function to restart the Vite server and print URLs if changed
 */
export async function restartServerWithUrls(
  server: ViteDevServer,
): Promise<void> {
  if (server.config.server.middlewareMode) {
    await server.restart()
    return
  }

  const { port: prevPort, host: prevHost } = server.config.server
  const prevUrls = server.resolvedUrls

  await server.restart()

  const {
    logger,
    server: { port, host },
  } = server.config
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    logger.info('')
    server.printUrls()
  }
}
