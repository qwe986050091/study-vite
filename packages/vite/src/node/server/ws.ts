// 文件角色
// - 位置：dev server 的默认传输层（WebSocket）。只负责「握手准入 + 连接管理 + 序列化 + 广播」，
//   不做任何 HMR 决策（决策在 server/hmr.ts）。
// - 上游：server/index.ts 的 createServer 调用 createWebSocketServer(httpServer, config, httpsOptions)，
//   返回值同时作为 server.ws（兼容层）与 client environment 的 hot transport
//   （createEnvironment 传入 { ws } → environment.hot）。
// - 下游：payload 由 environment.hot.send（即本文件 normalizeHotChannel 包装出的 send）广播；
//   浏览器端消费者是 src/client/client.ts，它用 'vite-hmr' 子协议连上来接收 HotPayload。
// - 关键不变量：只有通过 token 校验（或非浏览器请求）的连接才会长期留在 wss.clients；
//   'vite-ping' 连接虽被 accept，但不触发 connection 事件、并立即以 1000 关闭，
//   避免广播打到探活连接上。
// - 容易误解：HMR 不是「每个 environment 一条连接」。所有环境共用这一个 ws server，
//   environment.hot 只是同一个对象的不同包装视图；哪些 payload 允许发出由 normalizeHotChannel 的
//   enableHmr 决定，不由连接决定。
import crypto from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { STATUS_CODES, createServer as createHttpServer } from 'node:http'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import { createServer as createHttpsServer } from 'node:https'
import type { Socket } from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { isHostAllowed } from 'host-validation-middleware'
import colors from 'picocolors'
import type { WebSocket as WebSocketRaw } from 'ws'
import { WebSocketServer as WebSocketServerRaw_ } from 'ws'
import type { WebSocket as WebSocketTypes } from '#dep-types/ws'
import type { InferCustomEventPayload } from '#types/customEvent'
import type {
  ErrorPayload,
  FullReloadPayload,
  HotPayload,
} from '#types/hmrPayload'
import type { ResolvedConfig } from '..'
import { isObject } from '../utils'
import type { NormalizedHotChannel, NormalizedHotChannelClient } from './hmr'
import { normalizeHotChannel } from './hmr'
import type { HttpServer } from '.'

/* In Bun, the `ws` module is overridden to hook into the native code. Using the bundled `js` version
 * of `ws` will not work as Bun's req.socket does not allow reading/writing to the underlying socket.
 */
// Bun 运行时里 ws 被替换成原生实现，必须 require 出它的 WebSocketServer，否则无法读写底层 socket。
const WebSocketServerRaw = process.versions.bun
  ? // @ts-expect-error: Bun defines `import.meta.require`
    import.meta.require('ws').WebSocketServer
  : WebSocketServerRaw_

// 浏览器端用 new WebSocket(url, 'vite-hmr') 声明子协议；服务端用它在 upgrade 时区分
// HMR 连接与 'vite-ping' 探活连接。
export const HMR_HEADER = 'vite-hmr'

export type WebSocketCustomListener<T> = (
  data: T,
  client: WebSocketClient,
) => void

// 类型标记：environment.ts 用它判断「这个 transport 已经是 ws server，不要再包一层、
// 也不要在 environment.close 时提前关掉它」（ws 的生命周期由 server 级 close 管）。
export const isWebSocketServer: unique symbol = Symbol('isWebSocketServer')

// 对外类型 = 归一化 HotChannel + 原生 ws 事件 + clients 快照 + 类型标记。
export interface WebSocketServer extends NormalizedHotChannel {
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on: WebSocketTypes.Server['on'] & {
    <T extends string>(
      event: T,
      listener: WebSocketCustomListener<InferCustomEventPayload<T>>,
    ): void
  }
  /**
   * Unregister event listener.
   */
  off: WebSocketTypes.Server['off'] & {
    (event: string, listener: Function): void
  }
  /**
   * Listen on port and host
   */
  listen(): void
  /**
   * Disconnect all clients and terminate the server.
   */
  close(): Promise<void>

  [isWebSocketServer]: true
  /**
   * Get all connected clients.
   */
  clients: Set<WebSocketClient>
  // 只读快照：每次访问都重新包装一遍（getSocketClient 有 WeakMap 缓存），调用方不应长期持有。
}

export interface WebSocketClient extends NormalizedHotChannelClient {
  /**
   * The raw WebSocket instance
   * @advanced
   */
  socket: WebSocketTypes
}

// 这些事件名走原生 wss.on（连接/错误/监听/消息），其余事件名一律当作自定义事件进 customListeners。
// 判断逻辑在文件末尾返回对象的 on/off 里。
const wsServerEvents = [
  'connection',
  'error',
  'headers',
  'listening',
  'message',
]

function noop() {
  // config.server.ws === false 时，整个 server 退化成只含 noop 的替身。
  // noop
}

// we only allow websockets to be connected if it has a valid token
// this is to prevent untrusted origins to connect to the server
// for example, Cross-site WebSocket hijacking
// 与 CORS 不同：浏览器对 WebSocket 不施加同源策略，所以服务端必须自己把关。
// we should check the token before calling wss.handleUpgrade
// otherwise untrusted ws clients will be included in wss.clients
// 实现上还有两个开关：allowedHosts 校验与 legacy.skipWebSocketTokenCheck（见下面的 shouldHandle）。
// using the query params means the token might be logged out in server or middleware logs
// but we assume that is not an issue since the token is regenerated for each process
// 作用：校验 ws url 的 ?token= 是否等于本进程生成的 config.webSocketToken。
// 调用点：本文件 shouldHandle（带 Origin 头的浏览器请求必须带 token）。
// 为什么用 timingSafeEqual：避免逐字节比较泄露 token 前缀；长度不等时它会抛错，catch 后返回 false。
// 失败模式：无 token、长度不符、token 错误一律 false（随后 shouldHandle 拒绝握手）。
function hasValidToken(config: ResolvedConfig, url: URL) {
  const token = url.searchParams.get('token')
  if (!token) return false

  try {
    const isValidToken = crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(config.webSocketToken),
    )
    return isValidToken
  } catch {} // an error is thrown when the length is incorrect
  return false
}

// 作用：创建 ws server（或一个 noop 替身），接入 http server 的 upgrade 事件，并归一化成 HotChannel。
// 调用点：server/index.ts 的 createServer —— 返回值同时赋给 server.ws 与各 environment 的 transport。
// 关键参数：server 为 null 表示 middleware mode（此时自建 wsHttpServer 监听独立端口，默认 24678）；
//   httpsOptions 决定自建 server 用 http 还是 https；config.server.ws 可整体关掉或指定独立端口/host/path。
// 失败模式：端口占用（EADDRINUSE）只打日志，HMR 静默失效；握手校验失败则不 upgrade
//   （浏览器看到连接失败，客户端会重试）。
export function createWebSocketServer(
  server: HttpServer | null,
  config: ResolvedConfig,
  httpsOptions?: HttpsServerOptions,
): WebSocketServer {
  if (config.server.ws === false) {
    // 完全关闭：保留同样形状的 API，避免调用方到处判空。clients 返回空集合，
    // handleInvoke 明确返回 TransportError，让 ModuleRunner 的 fetchModule 报可读错误而不是 TypeError。
    return {
      [isWebSocketServer]: true,
      get clients() {
        return new Set<WebSocketClient>()
      },
      async close() {
        // noop
      },
      on: noop as any as WebSocketServer['on'],
      off: noop as any as WebSocketServer['off'],
      setInvokeHandler: noop,
      handleInvoke: async () => ({
        error: {
          name: 'TransportError',
          message: 'handleInvoke not implemented',
          stack: new Error().stack,
        },
      }),
      listen: noop,
      send: noop,
    }
  }

  let wsHttpServer: Server | undefined = undefined
  // 仅在 middleware mode（或 ws 端口与主 server 不同）时才会创建，见下面的 else 分支。

  const wsOptions = isObject(config.server.ws) ? config.server.ws : undefined
  const wsCustomServer = wsOptions?.server
  const wsPort = wsOptions?.port
  // TODO: the main server port may not have been chosen yet as it may use the next available
  // 只有端口一致时才能复用主 http server 处理 upgrade；注意主端口此时可能还没最终确定（自动换端口），
  // 所以这里只是「看起来兼容」。
  const portsAreCompatible = !wsPort || wsPort === config.server.port
  const wsServer = wsCustomServer || (portsAreCompatible && server)
  let hmrServerWsListener: (
    req: InstanceType<typeof IncomingMessage>,
    socket: Duplex,
    head: Buffer,
  ) => void
  const customListeners = new Map<string, Set<WebSocketCustomListener<any>>>()
  const clientsMap = new WeakMap<WebSocketRaw, WebSocketClient>()
  // 24678 是 Vite 历史上固定给 ws 的默认端口（middleware mode 下客户端要显式连它）。
  const port = wsPort || 24678
  const host = wsOptions?.host || undefined
  // 冻结一份数组，让 isHostAllowed 内部可以安全地缓存判定结果；=== true 表示全部放行。
  const allowedHosts =
    config.server.allowedHosts === true
      ? config.server.allowedHosts
      : Object.freeze([...config.server.allowedHosts]) // Freeze the array to allow caching

  // 作用：握手前的准入判断，返回 false 时 ws 库直接拒绝（不会创建 client）。
  // 调用点：赋给 wss.shouldHandle，由 ws 在 handleUpgrade 内部调用。
  // 顺序是刻意的：vite-ping 最优先（它必须在 /@vite/client 加载前就能探活），再看 allowedHosts，
  // 然后是 legacy 跳过开关，最后才要求「带 Origin 的浏览器请求必须带 token」。
  // 失败模式：返回 false 不抛错；连接表现为握手失败，客户端自行重试。
  const shouldHandle = (req: IncomingMessage) => {
    const protocol = req.headers['sec-websocket-protocol']!
    // vite-ping is allowed to connect from anywhere
    // because it needs to be connected before the client fetches the new `/@vite/client`
    // this is fine because vite-ping does not receive / send any meaningful data
    // 探活连接不携带任何业务数据，所以允许任意来源 —— 在「探活可用」与安全之间取平衡。
    if (protocol === 'vite-ping') return true

    if (
      allowedHosts !== true &&
      !isHostAllowed(req.headers.host, allowedHosts)
    ) {
      // Host 头校验用于防 DNS rebinding；allowedHosts === true 时整段跳过。
      return false
    }

    if (config.legacy?.skipWebSocketTokenCheck) {
      // 兼容开关：旧版客户端无法携带 token 时整体跳过校验。
      return true
    }

    // If the Origin header is set, this request might be coming from a browser.
    // Browsers always sets the Origin header for WebSocket connections.
    // 浏览器一定带 Origin（受 SOP 约束），所以必须校验 token。
    if (req.headers.origin) {
      const parsedUrl = new URL(`http://example.com${req.url!}`)
      return hasValidToken(config, parsedUrl)
    }

    // We allow non-browser requests to connect without a token
    // for backward compat and convenience
    // This is fine because if you can sent a request without the SOP limitation,
    // you can also send a normal HTTP request to the server.
    // 非浏览器（Node/CLI）不带 Origin，允许免 token：它们本来就不受 SOP 保护，
    // 能连 ws 就能直接发 http 请求，加 token 没有安全收益。
    return true
  }
  // noServer 模式下所有握手都要手动 handleUpgrade。isPing 的连接 accept 后立刻以 1000 关闭：
  // 浏览器 onopen 会触发（探活成功），但连接不会残留在 clients 里。
  const handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    isPing: boolean,
  ) => {
    wss.handleUpgrade(req, socket as Socket, head, (ws) => {
      // vite-ping is allowed to connect from anywhere
      // we close the connection immediately without connection event
      // so that the client does not get included in `wss.clients`
      if (isPing) {
        ws.close(/* Normal Closure */ 1000)
        return
      }
      wss.emit('connection', ws, req)
    })
  }
  const wss: WebSocketServerRaw_ = new WebSocketServerRaw({ noServer: true })
  // noServer: true —— 由我们自己决定接不接 upgrade，避免 ws 库另建 http server。
  wss.shouldHandle = shouldHandle

  if (wsServer) {
    // 常规 dev：把 HMR upgrade 挂到主 http server 上复用同一端口。
    let hmrBase = config.base
    const wsPath = wsOptions?.path
    if (wsPath) {
      // HMR 路径 = base + ws.path，必须与 client.ts 拼出的 socketUrl 完全一致，否则 pathname 匹配不上。
      hmrBase = path.posix.join(hmrBase, wsPath)
    }
    hmrServerWsListener = (req, socket, head) => {
      const protocol = req.headers['sec-websocket-protocol']!
      const parsedUrl = new URL(`http://example.com${req.url!}`)
      // 只处理子协议为 vite-hmr / vite-ping 且路径匹配的连接，其余交还给其他 upgrade 监听器
      // （代理、插件、自定义中间件都要能收到自己的 upgrade）。
      if (
        [HMR_HEADER, 'vite-ping'].includes(protocol) &&
        parsedUrl.pathname === hmrBase
      ) {
        handleUpgrade(req, socket as Socket, head, protocol === 'vite-ping')
      } else {
        // Node.js detaches its own socket error handler before emitting
        // `upgrade`, so a socket that no listener takes over would crash the
        // process when the client resets the connection (e.g. ECONNRESET).
        // Other listeners (proxy, plugins) still receive the error as usual.
        // 没人接手的 socket 在客户端复位时会以 ECONNRESET 崩进程；这里兜一个 noop，
        // 其他监听器仍能正常收到 error 事件。
        socket.on('error', noop)
      }
    }
    wsServer.on('upgrade', hmrServerWsListener)
  } else {
    // middleware mode：没有主 http server（或 ws 端口不同），自建一个只回 426 的 server。
    // http server request handler keeps the same with
    // https://github.com/websockets/ws/blob/45e17acea791d865df6b255a55182e9c42e5877a/lib/websocket-server.js#L88-L96
    const route = ((_, res) => {
      // 非 upgrade 的普通 HTTP 请求回 426 Upgrade Required：明确告诉客户端「这个端口只做 WebSocket」。
      const statusCode = 426
      const body = STATUS_CODES[statusCode]
      if (!body)
        throw new Error(`No body text found for the ${statusCode} status code`)

      res.writeHead(statusCode, {
        'Content-Length': body.length,
        'Content-Type': 'text/plain',
      })
      res.end(body)
    }) as Parameters<typeof createHttpServer>[1]
    // vite dev server in middleware mode
    // need to call ws listen manually
    // https 配置必须一起复制：否则 https 页面里的 wss:// 握手会因证书不一致失败。
    if (httpsOptions) {
      wsHttpServer = createHttpsServer(httpsOptions, route)
    } else {
      wsHttpServer = createHttpServer(route)
    }
    wsHttpServer.on('upgrade', (req, socket, head) => {
      const protocol = req.headers['sec-websocket-protocol']!
      if (protocol === 'vite-ping' && server && !server.listening) {
        // reject connection to tell the vite/client that the server is not ready
        // if the http server is not listening
        // because the ws server listens before the http server listens
        // ws server 可能先于 http server 启动。此时直接 destroy：客户端据此知道「还没就绪」，
        // 会继续重试，而不是误判为永久连不上。
        req.destroy()
        return
      }
      handleUpgrade(req, socket as Socket, head, protocol === 'vite-ping')
    })
    wsHttpServer.on('error', (e: Error & { code: string; port: number }) => {
      // 端口冲突只记日志：dev server 主体仍然可用，只是 HMR 不可用（不抛错以免整个启动失败）。
      if (e.code === 'EADDRINUSE') {
        config.logger.error(
          colors.red(
            `WebSocket server error: Port ${e.port} is already in use`,
          ),
          { error: e },
        )
      } else {
        config.logger.error(
          colors.red(`WebSocket server error:\n${e.stack || e.message}`),
          { error: e },
        )
      }
    })
  }

  // 把 custom 事件分发给已注册的监听器；没有监听器就快速返回，避免为每条消息包装 client。
  const emitCustomEvent = <T extends string>(
    event: T,
    data: InferCustomEventPayload<T>,
    socket: WebSocketRaw,
  ) => {
    const listeners = customListeners.get(event)
    if (!listeners?.size) return

    const client = getSocketClient(socket)
    for (const listener of listeners) {
      listener(data, client)
    }
  }

  // 连接建立后的协议：收到的消息只认 {type:'custom', event, data}，其余一律忽略；
  // 连接/断开映射成 vite:client:connect / vite:client:disconnect 自定义事件。
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      // 没有任何 custom 监听器时连 JSON.parse 都省掉（高频消息路径）。
      if (!customListeners.size) return
      let parsed: any
      try {
        parsed = JSON.parse(String(raw))
      } catch {}
      // 非法 JSON 静默丢弃：ws 上可能有代理/探活发出的垃圾数据。
      if (!parsed || parsed.type !== 'custom' || !parsed.event) return
      emitCustomEvent(parsed.event, parsed.data, socket)
    })
    // 单个连接的 error 不能影响整个 wss，只打日志。
    socket.on('error', (err) => {
      config.logger.error(`${colors.red(`ws error:`)}\n${err.stack}`, {
        timestamp: true,
        error: err,
      })
    })
    socket.on('close', () => {
      // 让插件清理与该连接绑定的状态（例如 per-client 的 bundled dev 会话）。
      emitCustomEvent('vite:client:disconnect', undefined, socket)
    })

    emitCustomEvent('vite:client:connect', undefined, socket)

    // 必须先发 'connected'，再 flush 缓存：客户端把 connected 当作「可以开始 HMR」的信号。
    socket.send(JSON.stringify({ type: 'connected' }))
    if (bufferedMessage) {
      socket.send(JSON.stringify(bufferedMessage))
      bufferedMessage = null
    }
  })

  wss.on('error', (e: Error & { code: string; port: number }) => {
    // 与 wsHttpServer 的错误处理保持一致：只记日志，不让 HMR 故障影响 dev server 主体。
    if (e.code === 'EADDRINUSE') {
      config.logger.error(
        colors.red(`WebSocket server error: Port ${e.port} is already in use`),
        { error: e },
      )
    } else {
      config.logger.error(
        colors.red(`WebSocket server error:\n${e.stack || e.message}`),
        { error: e },
      )
    }
  })

  // Provide a wrapper to the ws client so we can send messages in JSON format
  // To be consistent with server.ws.send
  // 作用：把裸 ws 实例包成 { send, socket }。调用点：本文件 emitCustomEvent、clients getter、
  // wss connection 相关路径。WeakMap 保证同一 socket 拿到同一个 wrapper（可作为 Map 键比较）。
  function getSocketClient(socket: WebSocketRaw) {
    if (!clientsMap.has(socket)) {
      clientsMap.set(socket, {
        send: (...args: any[]) => {
          let payload: HotPayload
          if (typeof args[0] === 'string') {
            // 与 normalizedHotChannel.send 一样支持 (event, data) 与 (payload) 两种签名，
            // 然后统一 JSON 序列化（客户端只认 JSON）。
            payload = {
              type: 'custom',
              event: args[0],
              data: args[1],
            }
          } else {
            payload = args[0]
          }
          socket.send(JSON.stringify(payload))
        },
        socket,
      })
    }
    return clientsMap.get(socket)!
  }

  // On page reloads, if a file fails to compile and returns 500, the server
  // sends the error payload before the client connection is established.
  // If we have no open clients, buffer the error and send it to the next
  // connected client.
  // The same thing may happen when the optimizer runs fast enough to
  // finish the bundling before the client connects.
  // 只缓存 error 与 full-reload：这两类消息如果在 client 连上前丢掉，页面会带着坏状态继续跑。
  // update 不缓存 —— 它依赖客户端已有模块图，发给刚连上的新页面没有意义。
  let bufferedMessage: ErrorPayload | FullReloadPayload | null = null

  const normalizedHotChannel = normalizeHotChannel(
    {
      send(payload) {
        if (
          (payload.type === 'error' || payload.type === 'full-reload') &&
          !wss.clients.size
        ) {
          // 只有「一个客户端都没有」时才缓冲；有连接时直接广播，避免旧消息污染新页面。
          bufferedMessage = payload
          return
        }

        // 序列化一次、发给所有 client，避免 N 次 JSON.stringify。
        const stringified = JSON.stringify(payload)
        wss.clients.forEach((client) => {
          // readyState 1 means the connection is open
          // readyState 1 表示 OPEN；CLOSING/CLOSED 直接跳过（否则 ws 会抛错）。
          // 注意遍历的是原生 wss.clients；vite-ping 会被立即 close，不会长期留在里面。
          if (client.readyState === 1) {
            client.send(stringified)
          }
        })
      },
      on(event: string, fn: any) {
        if (!customListeners.has(event)) {
          customListeners.set(event, new Set())
        }
        customListeners.get(event)!.add(fn)
      },
      off(event: string, fn: any) {
        customListeners.get(event)?.delete(fn)
      },
      listen() {
        // 只有自建的 wsHttpServer 需要手动 listen；复用主 http server 时它已经监听。
        wsHttpServer?.listen(port, host)
      },
      close() {
        // should remove listener if hmr.server is set
        // otherwise the old listener swallows all WebSocket connections
        // server 重启会复用同一个 http server：旧 upgrade 监听器若不摘掉，会「吞掉」所有新连接
        // （旧 wss 已关闭，握手成功后也收不到任何消息）。
        if (hmrServerWsListener && wsServer) {
          wsServer.off('upgrade', hmrServerWsListener)
        }
        return new Promise<void>((resolve, reject) => {
          wss.clients.forEach((client) => {
            // terminate 而不是 close：dev server 关闭不该等客户端优雅断开。
            client.terminate()
          })
          wss.close((err) => {
            if (err) {
              reject(err)
            } else {
              if (wsHttpServer) {
                wsHttpServer.close((err) => {
                  if (err) {
                    reject(err)
                  } else {
                    resolve()
                  }
                })
              } else {
                resolve()
              }
            }
          })
        })
      },
    },
    config.server.hmr !== false,
    // Don't normalize client as we already handles the send, and to keep `.socket`
    // 第三个参数 false：send 已在上面的 channel 里实现，且必须保留原始 client（带 .socket 给插件用）。
    false,
  )
  return {
    ...normalizedHotChannel,

    on: ((event: string, fn: any) => {
      if (wsServerEvents.includes(event)) {
        // 原生 ws 事件（connection/error/listening/message/headers）走 wss 本身。
        wss.on(event, fn)
        return
      }
      // 其余都是 custom 事件（含 vite:client:connect / disconnect），进 customListeners。
      normalizedHotChannel.on(event, fn)
    }) as WebSocketServer['on'],
    off: ((event: string, fn: any) => {
      if (wsServerEvents.includes(event)) {
        wss.off(event, fn)
        return
      }
      normalizedHotChannel.off(event, fn)
    }) as WebSocketServer['off'],
    async close() {
      // 与 environment.close 的区别：environment 对 ws server 不调用 hot.close（见 environment.ts），
      // 真正的关闭发生在这里（server.closeServer）。
      await normalizedHotChannel.close()
    },

    [isWebSocketServer]: true,
    get clients() {
      // 每次返回新 Set，外部修改不会影响内部集合；元素是 WeakMap 缓存的 wrapper。
      return new Set([...wss.clients].map(getSocketClient))
    },
  }
}
