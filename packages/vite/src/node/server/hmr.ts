// 文件角色
// - 位置：dev server 的 HMR 决策层。它既不持有 socket，也不做转译，只回答一个问题：
//   「一个文件变了，哪些模块需要更新、能不能热更新、要不要整页刷新」。
// - 上游调用：server/index.ts 的 watcher 回调 —— onFileChange / onFileAddUnlink 先执行
//   moduleGraph.onFileChange 与 pluginContainer.watchChange，然后 onHMRUpdate → handleHMRUpdate。
//   另外 import.meta.hot.invalidate 走 environment.ts 的 invalidateModule → updateModules；
//   server.reloadModule / environment.reloadModule 也直接调用 updateModules。
// - 下游：本文件读 moduleGraph 的 importers 图并写 invalidateModule，最后通过 environment.hot
//   （transport，默认实现见 ws.ts）广播 HotPayload；浏览器端消费者是 src/client/client.ts，
//   SSR 端消费者是 src/module-runner/hmrHandler.ts。
// - 关键不变量：一次文件变更只用一个 timestamp；先 propagateUpdate 算边界，再 invalidateModule 改缓存，
//   最后才发 payload —— 顺序颠倒会让客户端拿到指向旧图的更新。
// - 容易误解：update payload 只声明「哪个模块可以自更新」，不搬运代码；客户端拿 acceptedPath 拼上新的
//   ?t= 重新请求模块，代码新鲜度由 moduleGraph.lastHMRTimestamp 驱动。
// - 类型定义：HotPayload / Update 在 src/types/hmrPayload.d.ts；两端共用的 HMRClient / HMRContext
//   在 src/shared/hmr.ts。
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'
import colors from 'picocolors'
import type { RollupError } from 'rolldown'
import type { CustomPayload, HotPayload, Update } from '#types/hmrPayload'
import type { InferCustomEventPayload, ViteDevServer } from '..'
import type {
  InvokeMethods,
  InvokeResponseData,
  InvokeSendData,
} from '../../shared/invokeMethods'
import { withTrailingSlash } from '../../shared/utils'
import { CLIENT_DIR } from '../constants'
import {
  ignoreDeprecationWarnings,
  warnFutureDeprecation,
} from '../deprecations'
import { getEnvFilesForMode } from '../env'
import type { Environment } from '../environment'
import type { Plugin } from '../plugin'
import { getHookHandler } from '../plugins'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import {
  createDebugger,
  formatAndTruncateFileList,
  monotonicDateNow,
  normalizePath,
} from '../utils'
import type { DevEnvironment } from './environment'
import { prepareError } from './middlewares/error'
import type { ModuleNode } from './mixedModuleGraph'
import type { EnvironmentModuleNode } from './moduleGraph'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './pluginContainer'
import type { HttpServer } from '.'
import { restartServerWithUrls } from '.'

// 调试开关：DEBUG=vite:hmr 时输出传播细节；本文件大量 debugHmr?.() 都是可静默的。
export const debugHmr: ((...args: any[]) => any) | undefined =
  createDebugger('vite:hmr')

// lexAcceptedHmrDeps 用它跳过 accept() 参数里的空白字符。
const whitespaceRE = /\s/

// client 运行时目录（/@vite/client 的来源）。改到它下面的文件不能热更新，只能整页刷新。
const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface WsOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  server?: HttpServer
}

// 兼容层：vite.config 里的 server.hmr.* 已在 config.ts 中映射进 server.ws.*，
// 这里保留接口只为让旧配置仍能通过类型检查（字段全部 @deprecated）。
export interface HmrOptions {
  /**
   * @deprecated Use `server.ws.protocol` instead.
   */
  protocol?: string
  /**
   * @deprecated Use `server.ws.host` instead.
   */
  host?: string
  /**
   * @deprecated Use `server.ws.port` instead.
   */
  port?: number
  /**
   * @deprecated Use `server.ws.clientPort` instead.
   */
  clientPort?: number
  /**
   * @deprecated Use `server.ws.path` instead.
   */
  path?: string
  /**
   * @deprecated Use `server.ws.timeout` instead.
   */
  timeout?: number
  overlay?: boolean
  /**
   * @deprecated Use `server.ws.server` instead.
   */
  server?: HttpServer
}

// 新式 hotUpdate 钩子的参数：按 environment 各给一份，modules 是该环境自己的节点。
// 注意它与下面的 HmrContext 的区别：这个能精确到 client / ssr，是推荐用法。
export interface HotUpdateOptions {
  type: 'create' | 'update' | 'delete'
  file: string
  timestamp: number
  modules: Array<EnvironmentModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

// 旧式 handleHotUpdate 钩子的参数：modules 是 client+ssr 混合图里的兼容节点（ModuleNode），
// 只为向后兼容保留，新插件应改用 hotUpdate + HotUpdateOptions。
export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

// 传播结果里的一条边界。三个字段直接映射成 Update payload：
// boundary → path（谁自己处理这次更新）；acceptedVia → acceptedPath（它接受的是谁，客户端要重新 import 的那个）；
// isWithinCircularImport 告诉客户端这条接受关系处在 import 环里，重放顺序不可靠。
interface PropagationBoundary {
  boundary: EnvironmentModuleNode & { type: 'js' | 'css' }
  acceptedVia: EnvironmentModuleNode
  isWithinCircularImport: boolean
}

// 单个客户端的最小能力：能发 payload。ws.ts 的 WebSocketClient 在此之上多了 raw socket。
export interface HotChannelClient {
  send(payload: HotPayload): void
}

export type HotChannelListener<T extends string = string> = (
  data: InferCustomEventPayload<T>,
  client: HotChannelClient,
) => void

export interface HotChannel<Api = any> {
  /**
   * When true, the fs access check is skipped in fetchModule.
   * Set this for transports that is not exposed over the network.
   */
  skipFsCheck?: boolean
  /**
   * Broadcast events to all clients
   */
  send?(payload: HotPayload): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on?<T extends string>(event: T, listener: HotChannelListener<T>): void
  on?(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off?(event: string, listener: Function): void
  /**
   * Start listening for messages
   */
  listen?(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close?(): Promise<unknown> | void

  api?: Api
}

// 作用：取相对 root 的短路径，只用于日志/提示展示。
// 调用点：本文件 handleHMRUpdate、environment.ts 的 invalidateModule、bundledDev.ts。
// 失败模式：无；file 不在 root 下时原样返回。
export function getShortName(file: string, root: string): string {
  return file.startsWith(withTrailingSlash(root))
    ? path.posix.relative(root, file)
    : file
}

export interface NormalizedHotChannelClient {
  /**
   * Send event to the client
   */
  send(payload: HotPayload): void
  /**
   * Send custom event
   */
  send(event: string, payload?: CustomPayload['data']): void
}

// 归一化后的 transport：send 同时接受 payload 与 (event, data) 两种签名，
// on/off 保证监听器拿到的 client 参数已被包装成 NormalizedHotChannelClient。
export interface NormalizedHotChannel<Api = any> {
  /**
   * Broadcast events to all clients
   */
  send(payload: HotPayload): void
  /**
   * Send custom event
   */
  send<T extends string>(event: T, payload?: InferCustomEventPayload<T>): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on<T extends string>(
    event: T,
    listener: (
      data: InferCustomEventPayload<T>,
      client: NormalizedHotChannelClient,
    ) => void,
  ): void
  /**
   * @deprecated use `vite:client:connect` event instead
   */
  on(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off(event: string, listener: Function): void
  /** @internal */
  setInvokeHandler(invokeHandlers: InvokeMethods | undefined): void
  handleInvoke(payload: HotPayload): Promise<{ result: any } | { error: any }>
  /**
   * Start listening for messages
   */
  listen(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close(): Promise<unknown> | void

  api?: Api
}

// 作用：把任意 HotChannel 包成统一接口（send 重载、client 归一化、invoke 请求-响应协议、HMR 开关）。
// 调用点：ws.ts 的 createWebSocketServer（给 ws 传输再包一层）、environment.ts 构造函数
//   （environment.hot = normalizeHotChannel(context.transport, context.hot)）。
// 关键参数：enableHmr 决定是否放行 update / full-reload / prune 这类 HMR 专用 payload；
//   normalizeClient=false 时（ws.ts 用它）不再包装 client，因为 ws 层已经自己处理了 send。
// 失败模式：不抛错；底层 channel 少实现某个方法时静默降级（channel.on?.），表现为「收不到事件」。
export const normalizeHotChannel = (
  channel: HotChannel,
  enableHmr: boolean,
  normalizeClient = true,
): NormalizedHotChannel => {
  // on 时包装了一层出参，off 必须能找回同一个包装函数，否则监听器无法反注册（泄漏）。
  // 以原函数为键的 WeakMap 正好解决这个配对问题（下面 off 用它）。
  const normalizedListenerMap = new WeakMap<
    (data: any, client: NormalizedHotChannelClient) => void | Promise<void>,
    (data: any, client: HotChannelClient) => void | Promise<void>
  >()
  // 每个底层 client 只包装一次，保证同一条连接上的多次事件拿到同一个 wrapper（可直接比较/去重）。
  const normalizedClients = new WeakMap<
    HotChannelClient,
    NormalizedHotChannelClient
  >()

  let invokeHandlers: InvokeMethods | undefined
  let listenerForInvokeHandler:
    | ((data: InvokeSendData, client: HotChannelClient) => void)
    | undefined
  // invoke 协议的服务端实现：客户端 import.meta.hot.send('vite:invoke', {...}) →
  // 按 payload.data.name 找 handlers 里的函数执行，结果或错误包成 {result} / {error}。
  // 失败模式：handler 抛错不向上冒泡，而是序列化成 error 对象回给客户端（ModuleRunner 据此报错）。
  const handleInvoke = async <T extends keyof InvokeMethods>(
    payload: HotPayload,
  ) => {
    if (!invokeHandlers) {
      // 没有注册 handler 时返回明确的 TransportError，而不是让客户端拿到 undefined。
      return {
        error: {
          name: 'TransportError',
          message: 'invokeHandlers is not set',
          stack: new Error().stack,
        },
      }
    }

    const data: InvokeSendData<T> = (payload as CustomPayload).data
    const { name, data: args } = data
    try {
      const invokeHandler = invokeHandlers[name]
      // @ts-expect-error `invokeHandler` is `InvokeMethods[T]`, so passing the args is fine
      const result = await invokeHandler(...args)
      return { result }
    } catch (error) {
      return {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          // 展开可枚举属性以保留 RollupError 的 loc / frame / plugin 等字段（客户端覆盖层要用）。
          ...error, // preserve enumerable properties such as RollupError.loc, frame, plugin
        },
      }
    }
  }

  return {
    ...channel,
    on: (
      event: string,
      fn: (data: any, client: NormalizedHotChannelClient) => void,
    ) => {
      if (event === 'connection' || !normalizeClient) {
        // 'connection' 是历史事件名，没有 client 参数需要包装，直接透传。
        channel.on?.(event, fn as () => void)
        return
      }

      const listenerWithNormalizedClient = (
        data: any,
        client: HotChannelClient,
      ) => {
        if (!normalizedClients.has(client)) {
          normalizedClients.set(client, {
            send: (...args) => {
              let payload: HotPayload
              if (typeof args[0] === 'string') {
                // 与 NormalizedHotChannel.send 一致：支持 (event, data) 与 (payload) 两种签名。
                payload = {
                  type: 'custom',
                  event: args[0],
                  data: args[1],
                }
              } else {
                payload = args[0]
              }
              client.send(payload)
            },
          })
        }
        fn(data, normalizedClients.get(client)!)
      }
      // 记录映射，off 时才能摘掉同一个包装函数（见上面的 WeakMap 注释）。
      normalizedListenerMap.set(fn, listenerWithNormalizedClient)

      channel.on?.(event, listenerWithNormalizedClient)
    },
    off: (event: string, fn: () => void) => {
      if (event === 'connection' || !normalizeClient) {
        channel.off?.(event, fn as () => void)
        return
      }

      const normalizedListener = normalizedListenerMap.get(fn)
      if (normalizedListener) {
        channel.off?.(event, normalizedListener)
      }
    },
    setInvokeHandler(_invokeHandlers) {
      invokeHandlers = _invokeHandlers
      // 传 undefined 表示禁用：必须主动 off 掉旧监听，否则旧 handler 会继续响应新请求。
      if (!_invokeHandlers) {
        if (listenerForInvokeHandler) {
          channel.off?.('vite:invoke', listenerForInvokeHandler)
        }
        return
      }

      listenerForInvokeHandler = async (payload, client) => {
        // 响应事件名由请求 id 改写而来（send → response）：客户端靠这个 id 把结果配回 promise，
        // 所以这里绝不能改写成别的前缀。
        const responseInvoke = payload.id.replace('send', 'response') as
          | 'response'
          | `response:${string}`
        client.send({
          type: 'custom',
          event: 'vite:invoke',
          data: {
            name: payload.name,
            id: responseInvoke,
            data: (await handleInvoke({
              type: 'custom',
              event: 'vite:invoke',
              data: payload,
            }))!,
          } satisfies InvokeResponseData,
        })
      }
      channel.on?.('vite:invoke', listenerForInvokeHandler)
    },
    handleInvoke,
    send: (...args: any[]) => {
      let payload: HotPayload
      if (typeof args[0] === 'string') {
        payload = {
          type: 'custom',
          event: args[0],
          data: args[1],
        }
      } else {
        payload = args[0]
      }

      if (
        // HMR 关闭时仍要放行 connected / ping / custom / error：
        // 它们是连接保活、插件自定义事件与错误展示，不属于热更新本身。
        enableHmr ||
        payload.type === 'connected' ||
        payload.type === 'ping' ||
        payload.type === 'custom' ||
        payload.type === 'error'
      ) {
        channel.send?.(payload)
      }
    },
    listen() {
      return channel.listen?.()
    },
    close() {
      return channel.close?.()
    },
  }
}

// 作用：把带 hotUpdate / handleHotUpdate 钩子的插件按 order 排成 [pre..., normal..., post...]。
// 调用点：本文件 getSortedHotUpdatePlugins（每个 Environment 各排一次）。
// 关键实现：三个游标 pre/normal/post 直接 splice 到对应区间，避免为每个 hook 建 3 个临时数组。
export function getSortedPluginsByHotUpdateHook(
  plugins: readonly Plugin[],
): Plugin[] {
  const sortedPlugins: Plugin[] = []
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) {
    // 新钩子名优先：一个插件同时实现 hotUpdate 与 handleHotUpdate 时只按热更新钩子算一次。
    const hook = plugin.hotUpdate ?? plugin.handleHotUpdate
    if (hook) {
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  return sortedPlugins
}

const sortedHotUpdatePluginsCache = new WeakMap<Environment, Plugin[]>()
// 按 Environment 缓存排序结果。插件列表在 server 生命周期内不变（改插件需要重启），
// 所以 WeakMap 缓存是安全的；Environment 被重启替换后旧缓存自然被回收。
function getSortedHotUpdatePlugins(environment: Environment): Plugin[] {
  let sortedPlugins = sortedHotUpdatePluginsCache.get(environment)
  if (!sortedPlugins) {
    sortedPlugins = getSortedPluginsByHotUpdateHook(environment.plugins)
    sortedHotUpdatePluginsCache.set(environment, sortedPlugins)
  }
  return sortedPlugins
}

// 作用：一次文件变更的完整处理入口 —— 决定是重启、整页刷新，还是算出 HMR 边界后广播。
// 调用点：server/index.ts 的 onHMRUpdate（watcher 的 change / add / unlink 三条链路最终都汇到这里）。
// 关键参数：type 是 create/delete/update（影响 html 分支与解析失败模块的补偿）；file 是规范化绝对路径；
//   server 用于读取 config 与各 environment。
// 失败模式：本函数不向上抛错。插件钩子的异常被收进 hotMap[env].error，随后在 hmr() 里以 error payload
//   发给客户端（浏览器覆盖层因此能看到插件错误）；重启失败只打日志。
// 处理顺序（不要随意调整）：
//   1) config / config 依赖 / env 文件 → 重启（后续步骤都基于旧 config，必须先退出）
//   2) /@vite/client 自身文件 → 全量刷新（它不能热更新）
//   3) 逐个 environment 收集该文件对应的模块（create 时补上解析失败的 importer）
//   4) 跑插件 hotUpdate（新）与 handleHotUpdate（旧），允许过滤模块列表
//   5) 逐个 environment 调 updateModules（传播 → 失效 → 广播）
export async function handleHMRUpdate(
  type: 'create' | 'delete' | 'update',
  file: string,
  server: ViteDevServer,
): Promise<void> {
  const { config } = server
  // server.moduleGraph 是 client+ssr 的兼容视图，已标记废弃；这里取它只是为了喂旧钩子。
  const mixedModuleGraph = ignoreDeprecationWarnings(() => server.moduleGraph)

  const environmentSnapshot = server.environments
  const environments = Object.values(environmentSnapshot)
  // A plugin hook may restart the server, replacing the environments and
  // invalidating this HMR transaction.
  // 插件可能在本事务中重启 server：重启后 environments 是全新对象，继续用旧快照里的图
  // 会把状态写进已废弃的实例。所以每次 await 之后都要 isStale() 检查。
  const isStale = () => server.environments !== environmentSnapshot
  const shortFile = getShortName(file, config.root)

  // config 文件、它的依赖、以及 .env 文件变更都无法热更新：配置对象已经固化在内存里，
  // 只能重启进程内的 server（这也是唯一会走 restartServerWithUrls 的入口）。
  const isConfig = file === config.configFile
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name,
  )

  const isEnv =
    config.envDir !== false &&
    getEnvFilesForMode(config.mode, config.envDir).includes(file)
  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${normalizePath(
          path.relative(process.cwd(), file),
        )} changed, restarting server...`,
      ),
      { clear: true, timestamp: true },
    )
    try {
      await restartServerWithUrls(server)
    } catch (e) {
      // 重启失败只记日志并 return：此时 server 可能已经半关闭，继续 HMR 只会产生二次错误。
      config.logger.error(colors.red(e))
    }
    return
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`)

  // (dev only) the client itself cannot be hot updated.
  // client 运行时（/@vite/client）承载 HMR 协议本身，热替换它没有意义，直接整页刷新。
  if (file.startsWith(withTrailingSlash(normalizedClientDir))) {
    environments.forEach(({ hot }) =>
      hot.send({
        type: 'full-reload',
        path: '*',
        triggeredBy: path.resolve(config.root, file),
      }),
    )
    return
  }

  if (config.experimental.bundledDev) {
    // bundled dev（实验特性）还没接 hotUpdate 钩子；它的 HMR 由 bundledDev.ts 自己处理。
    // TODO: support handleHotUpdate / hotUpdate
    return
  }

  // 全局唯一时间戳：同一文件变更下所有 environment、所有 boundary 共用，客户端据此区分新旧。
  const timestamp = monotonicDateNow()
  const contextMeta = {
    type,
    file,
    timestamp,
    // read 是惰性的：只有真正需要源码的插件才触发磁盘 IO；readModifiedFile 处理了
    // 「变更事件早于写入完成」导致的空文件（实现见文件末尾）。
    read: () => readModifiedFile(file),
    server,
  }
  // 每个 environment 一份 options（插件可各自过滤模块列表），error 也按 environment 隔离。
  const hotMap = new Map<
    Environment,
    { options: HotUpdateOptions; error?: Error }
  >()

  for (const environment of environments) {
    const mods = new Set(environment.moduleGraph.getModulesByFile(file))
    if (type === 'create') {
      // create 事件特殊：新文件可能正是之前解析失败的 import 目标。把这些出错的 importer 也加入
      // 待更新集合，导入成功后下一次 update 会让错误覆盖层自动消失。
      for (const mod of environment.moduleGraph._hasResolveFailedErrorModules) {
        mods.add(mod)
      }
    }
    const options = {
      ...contextMeta,
      modules: [...mods],
    }
    hotMap.set(environment, { options })
  }

  const mixedMods = new Set(mixedModuleGraph.getModulesByFile(file))

  // 旧钩子只认混合图节点，单独构造一份；之后还要与新钩子的过滤结果双向同步（见下面的两处同步代码）。
  const mixedHmrContext: HmrContext = {
    ...contextMeta,
    modules: [...mixedMods],
  }

  // 旧钩子需要一个 plugin context（有 warn/error 等），这里用最小实现，watchMode: true。
  const contextForHandleHotUpdate = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  const clientEnvironment = server.environments.client
  const ssrEnvironment = server.environments.ssr
  const clientContext = clientEnvironment.pluginContainer.minimalContext
  const clientHotUpdateOptions = hotMap.get(clientEnvironment)!.options
  const ssrHotUpdateOptions = hotMap.get(ssrEnvironment)?.options
  try {
    // 第一轮只跑 client 环境的插件：client 插件最可能同时实现新旧两个钩子，而且新钩子的过滤结果
    // 要用混合图同步给旧钩子。ssr/其他环境留到第二轮，避免混合图状态与 per-env 状态交叉污染。
    for (const plugin of getSortedHotUpdatePlugins(clientEnvironment)) {
      if (plugin.hotUpdate) {
        // 新钩子：返回 undefined 表示不作改动；返回数组表示「只更新这些模块」。
        const filteredModules = await getHookHandler(plugin.hotUpdate).call(
          clientContext,
          clientHotUpdateOptions,
        )
        if (isStale()) return
        if (filteredModules) {
          clientHotUpdateOptions.modules = filteredModules
          // Invalidate the hmrContext to force compat modules to be updated
          // 同步混合图：保留「新结果里的模块」+「ssr 结果里的模块」（ssr 不受 client 过滤影响），
          // 再把新结果里混合图没有的节点补成兼容节点。
          mixedHmrContext.modules = mixedHmrContext.modules.filter(
            (mixedMod) =>
              filteredModules.some((mod) => mixedMod.id === mod.id) ||
              ssrHotUpdateOptions?.modules.some(
                (ssrMod) => ssrMod.id === mixedMod.id,
              ),
          )
          mixedHmrContext.modules.push(
            ...filteredModules
              .filter(
                (mod) =>
                  !mixedHmrContext.modules.some(
                    (mixedMod) => mixedMod.id === mod.id,
                  ),
              )
              .map((mod) =>
                mixedModuleGraph.getBackwardCompatibleModuleNode(mod),
              ),
          )
        }
      } else if (type === 'update') {
        // 旧钩子只在 update 事件提示弃用：create/delete 是较新的流程，不再对旧用法告警。
        warnFutureDeprecation(
          config,
          'removePluginHookHandleHotUpdate',
          `Used in plugin "${plugin.name}".`,
          false,
        )
        // later on, we'll need: if (runtime === 'client')
        // Backward compatibility with mixed client and ssr moduleGraph
        // 旧钩子拿到的是混合图节点；它的过滤结果要拆回 client/ssr 两套真实节点，
        // 靠 ModuleNode 上的 _clientModule / _ssrModule 反查。
        const filteredModules = await getHookHandler(
          plugin.handleHotUpdate!,
        ).call(contextForHandleHotUpdate, mixedHmrContext)
        if (isStale()) return
        if (filteredModules) {
          mixedHmrContext.modules = filteredModules
          clientHotUpdateOptions.modules =
            clientHotUpdateOptions.modules.filter((mod) =>
              filteredModules.some((mixedMod) => mod.id === mixedMod.id),
            )
          clientHotUpdateOptions.modules.push(
            ...(filteredModules
              .filter(
                (mixedMod) =>
                  !clientHotUpdateOptions.modules.some(
                    (mod) => mod.id === mixedMod.id,
                  ),
              )
              .map((mixedMod) => mixedMod._clientModule)
              .filter(Boolean) as EnvironmentModuleNode[]),
          )
          if (ssrHotUpdateOptions) {
            ssrHotUpdateOptions.modules = ssrHotUpdateOptions.modules.filter(
              (mod) =>
                filteredModules.some((mixedMod) => mod.id === mixedMod.id),
            )
            ssrHotUpdateOptions.modules.push(
              ...(filteredModules
                .filter(
                  (mixedMod) =>
                    !ssrHotUpdateOptions.modules.some(
                      (mod) => mod.id === mixedMod.id,
                    ),
                )
                .map((mixedMod) => mixedMod._ssrModule)
                .filter(Boolean) as EnvironmentModuleNode[]),
            )
          }
        }
      }
    }
  } catch (error) {
    if (isStale()) return
    // 插件错误不抛出：挂到对应 environment 上，交给 hmr() 统一发 error payload（客户端覆盖层）。
    hotMap.get(clientEnvironment)!.error = error
  }

  for (const environment of environments) {
    if (environment.name === 'client') continue
    // 第二轮：client 之外的环境只跑新钩子（旧钩子只有一份混合上下文，无法按环境重放）。
    const hot = hotMap.get(environment)!
    const context = environment.pluginContainer.minimalContext
    try {
      for (const plugin of getSortedHotUpdatePlugins(environment)) {
        if (plugin.hotUpdate) {
          const filteredModules = await getHookHandler(plugin.hotUpdate).call(
            context,
            hot.options,
          )
          if (isStale()) return
          if (filteredModules) {
            hot.options.modules = filteredModules
          }
        }
      }
    } catch (error) {
      if (isStale()) return
      hot.error = error
    }
  }

  // 单个 environment 的 HMR 执行体：把 options.modules 交给 updateModules。
  // modules 为空说明文件没进图（例如纯 HTML/静态资源），此时只有 client 下的 html 需要整页刷新。
  async function hmr(environment: DevEnvironment) {
    if (isStale()) return
    try {
      const { options, error } = hotMap.get(environment)!
      if (error) {
        throw error
      }
      if (!options.modules.length) {
        // html file cannot be hot updated
        // 模板 HTML 改了就整页刷新。middlewareMode 下无法确定该刷哪个 URL，用 '*' 表示全部。
        if (file.endsWith('.html') && environment.name === 'client') {
          environment.logger.info(
            colors.green(`page reload `) + colors.dim(shortFile),
            {
              clear: true,
              timestamp: true,
            },
          )
          environment.hot.send({
            type: 'full-reload',
            path: config.server.middlewareMode
              ? '*'
              : '/' + normalizePath(path.relative(config.root, file)),
          })
        } else {
          // loaded but not in the module graph, probably not js
          // 文件在磁盘上变了但不在任何环境图里：可能不是 JS（如 README），静默忽略。
          debugHmr?.(
            `(${environment.name}) [no modules matched] ${colors.dim(shortFile)}`,
          )
        }
        return
      }

      // shortFile 只用于日志；timestamp 用全局那一个，保证各环境一致。
      updateModules(environment, shortFile, options.modules, timestamp)
    } catch (err) {
      // 这里把错误变成 payload 而不是抛出：HMR 链路是异步的，抛出去只会变成 unhandled rejection。
      environment.hot.send({
        type: 'error',
        err: prepareError(err),
      })
    }
  }

  if (isStale()) return

  // 默认并行跑所有 environment 的 HMR；用户可用 server.hotUpdateEnvironments 改成串行或自定义调度。
  const hotUpdateEnvironments =
    server.config.server.hotUpdateEnvironments ??
    ((server, hmr) => {
      // Run HMR in parallel for all environments by default
      return Promise.all(
        Object.values(server.environments).map((environment) =>
          hmr(environment),
        ),
      )
    })

  await hotUpdateEnvironments(server, hmr)
}

type HasDeadEnd = string | boolean

// 作用：对一个 environment 的一组变更模块做「传播 → 失效 → 生成 payload → 广播」。
// 调用点：本文件 handleHMRUpdate；server/index.ts 的 reloadModule；environment.ts 的 reloadModule
//   （测试或插件手动触发）与 invalidateModule（import.meta.hot.invalidate 的服务端处理）。
// 关键参数：firstInvalidatedBy 只在 invalidate 链路里有值，表示「最初调用 invalidate 的模块 url」，
//   用于阻断环形 accept 导致的无限 invalidate。
// 不变量（读这段代码最容易错的地方）：
//   1) 必须先 propagateUpdate 再 invalidateModule —— 传播依赖图结构，而 invalidate 会清掉 transformResult；
//      反过来先失效会让 transformRequest 的「处理中失效」时间戳判断失去意义。
//   2) traversedModules 跨模块共享（一次变更内每个节点只传播一次）；invalidatedModules 也共享，
//      但两者用途不同：前者剪枝 DAG，后者给 invalidateModule 去重。
//   3) needFullReload 一旦被置成字符串原因就不再回退成 false —— 只要有一条链断掉就整页刷新。
//   4) 一旦决定 full-reload 就直接 return，不再顺带发部分 update（避免两套状态同时生效）。
export function updateModules(
  environment: DevEnvironment,
  file: string,
  modules: EnvironmentModuleNode[],
  timestamp: number,
  firstInvalidatedBy?: string,
): void {
  const { hot } = environment
  const updates: Update[] = []
  const invalidatedModules = new Set<EnvironmentModuleNode>()
  const traversedModules = new Set<EnvironmentModuleNode>()
  // Modules could be empty if a root module is invalidated via import.meta.hot.invalidate()
  // 初值为 false，但 modules 为空时必须 full reload：只有 invalidate 链路会把 modules 传空，
  // 表示「根模块被整体失效」，此时没有任何边界可用。
  let needFullReload: HasDeadEnd = modules.length === 0

  for (const mod of modules) {
    const boundaries: PropagationBoundary[] = []
    // 顺序：先算边界（只读图），再失效（改图）。
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    environment.moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
    )

    if (needFullReload) {
      // 已经确定要整页刷新：后续模块不必再算 payload，但仍要继续 invalidate（缓存必须一致）。
      continue
    }

    if (hasDeadEnd) {
      // 字符串原因（当前实现里是 boolean 转来的）只用于日志提示。
      needFullReload = hasDeadEnd
      continue
    }

    // If import.meta.hot.invalidate was called already on that module for the same update,
    // it means any importer of that module can't hot update. We should fallback to full reload.
    // 若某条边界的 accept 来源就是最初 invalidate 的模块，说明两者互为接受方、本轮不可能收敛，
    // 直接退化成 full reload，避免客户端反复 invalidate。
    if (
      firstInvalidatedBy &&
      boundaries.some(
        ({ acceptedVia }) => acceptedVia.url === firstInvalidatedBy,
      )
    ) {
      needFullReload = 'circular import invalidate'
      continue
    }

    updates.push(
      // payload 只声明「哪个模块的哪个依赖变了」：path=边界模块（它自己会处理这次更新），
      // acceptedPath=被接受的模块（客户端要重新 import 的那个）。
      // explicitImportRequired 用于 .json 等「必须带 ?import 才能走 import 语句」的 URL。
      ...boundaries.map(
        ({ boundary, acceptedVia, isWithinCircularImport }) => ({
          type: `${boundary.type}-update` as const,
          timestamp,
          path: boundary.url,
          acceptedPath: acceptedVia.url,
          explicitImportRequired:
            boundary.type === 'js'
              ? isExplicitImportRequired(acceptedVia.url)
              : false,
          isWithinCircularImport,
          firstInvalidatedBy,
        }),
      ),
    )
  }

  // html file cannot be hot updated because it may be used as the template for a top-level request response.
  // 只有当 html 没被当作模块 import 时才算「模板变更」；若它被 import 成 js 模块（少见），可以走正常 HMR。
  const isClientHtmlChange =
    file.endsWith('.html') &&
    environment.name === 'client' &&
    // if the html file is imported as a module, we assume that this file is
    // not used as the template for top-level request response
    // (i.e. not used by the middleware).
    modules.every((mod) => mod.type !== 'js')

  if (needFullReload || isClientHtmlChange) {
    const reason =
      typeof needFullReload === 'string'
        ? colors.dim(` (${needFullReload})`)
        : ''
    environment.logger.info(
      colors.green(`page reload `) + colors.dim(file) + reason,
      { clear: !firstInvalidatedBy, timestamp: true },
    )
    hot.send({
      type: 'full-reload',
      triggeredBy: path.resolve(environment.config.root, file),
      // path='*' 表示全部页面刷新。只有「客户端 html 模板变了、且没有其他 update」时才精确到 /file，
      // 让其他页面（如 iframe）不受影响；有 update 时可能牵连其他 URL，所以退回 '*'。
      path:
        !isClientHtmlChange ||
        environment.config.server.middlewareMode ||
        updates.length > 0 // if there's an update, other URLs may be affected
          ? '*'
          : '/' + file,
    })
    return
  }

  if (updates.length === 0) {
    // 传播完成却没有边界：链在某个未分析（或已完成 accept 处理）的节点处停住，什么都不用做。
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  const filePaths = [...new Set(updates.map((u) => u.path))]
  const { formatted, truncated } = formatAndTruncateFileList(filePaths)
  // 日志只展示截断后的列表，debug 里才是全量。
  if (truncated) debugHmr?.(`hmr update ${filePaths.join(', ')}`)
  environment.logger.info(colors.green(`hmr update `) + colors.dim(formatted), {
    clear: !firstInvalidatedBy,
    timestamp: true,
  })
  hot.send({
    type: 'update',
    updates,
  })
}

// 作用：部分接受判定 —— 当 importer 用到的每个绑定都被 dep 的 acceptExports 覆盖时，这条依赖无需向上传播。
// 调用点：本文件 propagateUpdate。空集合返回 true（没用到任何绑定，自然无需接受）。
function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

// 作用：从变更模块出发，沿 importers 向上找「能自己处理这次更新」的边界（accept 边界）。
// 调用点：本文件 updateModules。返回 true 表示这条链走到死胡同（没人 accept，必须 full reload）。
// 关键参数：traversedModules 是全局剪枝集合（一次变更内每个节点只传播一次）；boundaries 累积结果；
//   currentChain 是当前 DFS 路径，用于环检测。
// 失败模式：不抛错。宁可返回 false（少更新）也不误判 full reload —— 少更新只是页面没变，
//   误判刷新会丢掉 DOM 状态与用户输入。
function propagateUpdate(
  node: EnvironmentModuleNode,
  traversedModules: Set<EnvironmentModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: EnvironmentModuleNode[] = [node],
): HasDeadEnd {
  if (traversedModules.has(node)) {
    // 剪枝：同一节点第二次到达时直接返回 false ——「这个节点已经有另一条可达路径处理过了」。
    // 代价是环上的某些边界可能被漏掉，所以下面还有 isNodeWithinCircularImports 单独兜环。
    return false
  }
  traversedModules.add(node)

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  // isSelfAccepting === undefined 表示 importAnalysis 还没跑过（浏览器从未请求它）；
  // 未加载的模块没有需要更新的运行时，继续向上会把「从未加载的链」误判成 dead end。
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id,
      )}`,
    )
    return false
  }

  if (node.isSelfAccepting) {
    // isSelfAccepting is only true for js and css
    // 自接受模块（accept() 无参、Vue/React 组件文件）就是边界，acceptedVia 指向自己：
    // 客户端会重新 import 它本身，然后执行它自己注册的 accept 回调。
    const boundary = node as EnvironmentModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) {
    // acceptedHmrExports is only true for js and css
    // 部分接受的双面性：节点自己也是边界（它能处理「自己被改」），但函数**不 return**，继续向上传播 ——
    // 因为它处理不了「别人依赖我的那几个导出」。这条边界是给「自己被改」用的，向上传播是给 importer 用的。
    const boundary = node as EnvironmentModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
  } else {
    if (!node.importers.size) {
      // 既不自接受、又没人 import：入口模块（index.html 引的 main.js）或孤立模块，
      // 没有任何 importer 能替它处理变更，只能整页刷新。
      return true
    }
  }

  for (const importer of node.importers) {
    const subChain = [...currentChain, importer]

    if (importer.acceptedHmrDeps.has(node)) {
      // acceptedHmrDeps has value only for js and css
      // importer 明确 accept 了我 → importer 是边界，acceptedVia 是我：
      // 客户端重新 import 我，再回调 importer 注册的 accept 回调。这条边处理完 continue，不再向上。
      const boundary = importer as EnvironmentModuleNode & {
        type: 'js' | 'css'
      }
      boundaries.push({
        boundary,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      // 精确到绑定：importer 只用了被 acceptExports 覆盖的那几个导出时，这条依赖既不产生边界，
      // 也不算死胡同。注意 key 是 node.id（不是 url）。
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (
      // 防环：importer 已在当前 DFS 路径上就跳过；没有这个判断，环形 import 会无限递归。
      !currentChain.includes(importer) &&
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      // 子树里任意一条链走到死胡同，整棵树就必须整页刷新（一次刷新覆盖整页，不存在「部分刷新」）。
      return true
    }
  }
  return false
}

/**
 * Check importers recursively if it's an import loop. An accepted module within
 * an import loop cannot recover its execution order and should be reloaded.
 *
 * @param node The node that accepts HMR and is a boundary
 * @param nodeChain The chain of nodes/imports that lead to the node.
 *   (The last node in the chain imports the `node` parameter)
 * @param currentChain The current chain tracked from the `node` parameter
 * @param traversedModules The set of modules that have traversed
 */
// 作用：判断某个 accept 边界是否处在 import 环里。环中模块在更新后的执行顺序无法保证，
// 客户端即便重放 accept 回调也可能拿到半初始化的模块，所以 payload 会带 isWithinCircularImport。
// 调用点：本文件 propagateUpdate（self-accept / acceptExports / accept 依赖三种边界）。
// 关键参数：nodeChain 是「从变更模块走到边界的路径」，currentChain 是「从边界往外追踪的当前路径」，
//   两者相交即成环；traversedModules 防止本函数自身重复遍历。
function isNodeWithinCircularImports(
  node: EnvironmentModuleNode,
  nodeChain: EnvironmentModuleNode[],
  currentChain: EnvironmentModuleNode[] = [node],
  traversedModules = new Set<EnvironmentModuleNode>(),
): boolean {
  // To help visualize how each parameter works, imagine this import graph:
  // 箭头方向 = import 方向（左边 import 右边）；沿箭头反向走，就是「找 importer」的方向。
  // A -> B -> C -> ACCEPTED -> D -> E -> NODE
  //      ^--------------------------|
  // 图中 B 通过虚线回边 import NODE，因此 NODE <- E <- D <- ACCEPTED <- C <- B <- NODE 构成一个环。
  // ACCEPTED: the node that accepts HMR. the `node` parameter.
  // NODE    : the initial node that triggered this HMR.
  // 上面两个标签是本函数的主要输入：node 是被接受的边界，nodeChain 是从变更模块上溯到边界的路径。
  // This function will return true in the above graph, which:
  // `node`         : ACCEPTED
  // `nodeChain`    : [NODE, E, D, ACCEPTED]
  // `currentChain` : [ACCEPTED, C, B]
  // 上面三行是这张图里各参数的实际取值，可对着图逐项验证判定走向。
  // It works by checking if any `node` importers are within `nodeChain`, which
  // means there's an import loop with a HMR-accepted module in it.

  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  for (const importer of node.importers) {
    // Node may import itself which is safe
    // 自引用（模块 import 自己）不构成环，跳过。
    if (importer === node) continue

    // Check circular imports
    const importerIndex = nodeChain.indexOf(importer)
    if (importerIndex > -1) {
      // Log extra debug information so users can fix and remove the circular imports
      if (debugHmr) {
        // Following explanation above:
        // `importer`                    : E
        // `currentChain` reversed       : [B, C, ACCEPTED]
        // `nodeChain` sliced & reversed : [D, E]
        // Combined                      : [E, B, C, ACCEPTED, D, E]
        const importChain = [
          importer,
          ...currentChain.toReversed(),
          ...nodeChain.slice(importerIndex, -1).reverse(),
        ]
        debugHmr(
          colors.yellow(`circular imports detected: `) +
            importChain.map((m) => colors.dim(m.url)).join(' -> '),
        )
      }
      return true
    }

    // Continue recursively
    if (!currentChain.includes(importer)) {
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        [...currentChain, importer],
        traversedModules,
      )
      if (result) return result
    }
  }
  return false
}

// 作用：对「更新后不再被任何人 import」的模块发 prune payload，并推进它们的 HMR 时间戳。
// 调用点：plugins/importAnalysis.ts 的两处（「无 import」短路分支与正常 import 改写分支），
//   都在 updateModuleInfo 返回 noLongerImported 时调用。
// 为什么必须改时间戳：模块可能被再次 import（例如条件分支切回来），浏览器会用旧 ?t= 命中缓存，
// 导致 dispose/prune 副作用不会重新执行。
export function handlePrunedModules(
  mods: Set<EnvironmentModuleNode>,
  { hot }: DevEnvironment,
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = monotonicDateNow()
  mods.forEach((mod) => {
    // 与 invalidateModule(isHmr=true) 保持一致的两个副作用：推进时间戳、允许再次 invalidate。
    mod.lastHMRTimestamp = t
    mod.lastHMRInvalidationReceived = false
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`)
  })
  hot.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
// 作用：用一个极小的状态机扫出 import.meta.hot.accept('a', ['b','c']) 里的依赖字面量，
// 同时返回「是否自接受」。刻意不用完整的 AST 解析：accept 只允许字符串字面量或字面量数组。
// 调用点：plugins/importAnalysis.ts（提取 acceptedUrls / acceptedExports）。
// 返回值：true = 首个参数不是字符串/数组字面量（即 accept() 带回调或空参）= 自接受；
//   false = 显式列出了接受依赖。填进 urls 的 start/end 覆盖引号，供 importAnalysis 做字符串覆盖。
// 失败模式：模板字符串插值、非法 token 直接 throw 带 pos 的 RollupError，由转译阶段报给用户。
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  // 状态最多只有「调用参数」与「数组元素」两层，所以一个 prevState 就够，不需要栈。
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              // 首个实参不是字面量 → 直接回调或空参 → 自接受，立刻返回 true。
              return true // done
            }
          } else {
            if (char === `]`) {
              // 数组读完：显式列出了接受依赖，不是自接受。
              return false // done
            } else if (char === ',') {
              continue
            } else {
              // 数组里出现非法字符（对象、函数调用等）：accept 不支持这种写法。
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            // accept('dep') 形式：拿到第一个依赖就能确定不是自接受，提前结束扫描。
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          // 模板字符串插值无法静态确定依赖名，直接报错。
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

// 作用：acceptExports 的语法与 accept 的数组形式完全一致，所以复用同一个 lexer，把结果当导出名用。
// 调用点：plugins/importAnalysis.ts（experimental.hmrPartialAccept 开启时）。
// 返回值：true 表示显式列出了导出名。失败模式：同 lexAcceptedHmrDeps。
export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>,
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

// 统一错误构造：带上 pos，Vite 的错误覆盖层会据此定位到行/列。
function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`,
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
// 作用：读取刚变更的文件内容。带重试是因为 watcher 事件可能早于写入完成（读到空内容）：
// 轮询 10 次 × 10ms 等 mtime 变化后重读。调用点：本文件 handleHMRUpdate 的 contextMeta.read。
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, 'utf-8')
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs

    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10))
      const newMtime = (await fsp.stat(file)).mtimeMs
      if (newMtime !== mtime) {
        break
      }
    }

    return await fsp.readFile(file, 'utf-8')
  } else {
    return content
  }
}

export type ServerHotChannelApi = {
  innerEmitter: EventEmitter
  outsideEmitter: EventEmitter
}

export type ServerHotChannel = HotChannel<ServerHotChannelApi>
export type NormalizedServerHotChannel =
  NormalizedHotChannel<ServerHotChannelApi>

// 作用：给「没有浏览器连接」的 environment（典型是 ssr / 自定义 runner）提供一个纯 Node 侧
// HotChannel：send 只是 emit 到 outsideEmitter，由 runnableEnvironment.ts 接给 ModuleRunner。
// 调用点：server/environments/runnableEnvironment.ts（context.transport 缺省时创建），
//   并从 node/index.ts 导出供外部使用。
// 关键参数：skipFsCheck=true —— 该通道不经网络，fetchModule 不需要校验文件可访问性。
// 失败模式：没有监听者时 send 是空操作（EventEmitter 语义），不会报错。
export function createServerHotChannel(): ServerHotChannel {
  // innerEmitter 承载 on/off/connection（订阅方），outsideEmitter 承载 send（发布方）。
  // 分开是为了让「外部把消息塞进来」与「内部往外发消息」互不干扰。
  const innerEmitter = new EventEmitter()
  const outsideEmitter = new EventEmitter()

  return {
    skipFsCheck: true,
    send(payload: HotPayload) {
      outsideEmitter.emit('send', payload)
    },
    off(event, listener: () => void) {
      innerEmitter.off(event, listener)
    },
    on: ((event: string, listener: () => unknown) => {
      innerEmitter.on(event, listener)
    }) as ServerHotChannel['on'],
    close() {
      // 清空监听器，防止 server 重启后旧监听器继续响应新 environment 的消息。
      innerEmitter.removeAllListeners()
      outsideEmitter.removeAllListeners()
    },
    listen() {
      // 没有真实连接：直接触发一次 connection 事件，模拟「已有客户端连上」，让子环境立即开始工作。
      innerEmitter.emit('connection')
    },
    api: {
      innerEmitter,
      outsideEmitter,
    },
  }
}
