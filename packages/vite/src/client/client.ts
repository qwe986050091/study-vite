// 文件角色：浏览器端 HMR 客户端入口，最终作为 `/@vite/client` 下发给页面。
// 链路位置：server 端 plugins/clientInjections.ts 的 clientInjectionsPlugin 在 transform 阶段
//   对本文件做占位符替换（见下方 declare const 块），把服务端配置编译进代码；
//   命中条件是 cleanId === CLIENT_ENTRY（即 packages/vite/src/client/client.ts）。
// 上游：页面通过 <script type="module" src="/@vite/client"> 加载；
//   plugins/importAnalysis.ts 给每个模块注入 createHotContext，plugins/css.ts 注入
//   updateStyle / removeStyle，二者都来自本文件（经 clientEntry.ts 再导出）。
// 下游：
//   - shared/hmr.ts 的 HMRClient / HMRContext：真正的热更新状态机；
//   - shared/hmrHandler.ts 的 createHMRHandler：把收到的消息串行排队；
//   - shared/moduleRunnerTransport.ts：把 WebSocket 适配成 transport；
//   - client/overlay.ts：错误浮层。
// 关键不变量：
//   1. 一条 WS 连接同时承载 HMR 消息与 `vite:invoke` RPC（见 moduleRunnerTransport）；
//   2. 消息处理必须串行，否则两次 update 的 import 顺序会乱（由 createHMRHandler 保证）；
//   3. 本文件只做「消息 -> DOM/模块操作」的分发，真正的 accept 边界计算在 node/server/hmr.ts。
// 容易误解：这是 rolldown 内核的 Vite，dev 下 TS/JSX 转译走 oxc（plugins/oxc.ts），
//   但客户端代码本身仍是普通 TS，经同一套 dev 转译后以 ESM 下发。
import type { ErrorPayload, HotPayload } from '#types/hmrPayload'
import type { ViteHotContext } from '#types/hot'
import type { BundledDevHMRClient } from '../shared/bundledDevHmr'
import { setupForwardConsoleHandler } from '../shared/forwardConsole'
import { HMRClient, HMRContext } from '../shared/hmr'
import { createHMRHandler } from '../shared/hmrHandler'
import {
  createWebSocketModuleRunnerTransport,
  normalizeModuleRunnerTransport,
} from '../shared/moduleRunnerTransport'
import { moduleUrlToBrowserUrl } from '../shared/utils'
import { ErrorOverlay, cspNonce, overlayId } from './overlay'
// @ts-expect-error internal virtual module
import '@vite/env'

// injected by the hmr plugin when served
declare const __BASE__: string
declare const __SERVER_HOST__: string
declare const __HMR_PROTOCOL__: string | null
declare const __HMR_HOSTNAME__: string | null
declare const __HMR_PORT__: number | null
declare const __HMR_DIRECT_TARGET__: string
declare const __HMR_BASE__: string
declare const __HMR_TIMEOUT__: number
declare const __HMR_ENABLE_OVERLAY__: boolean
declare const __WS_TOKEN__: string
declare const __SERVER_FORWARD_CONSOLE__: any

// 上面这些 __XXX__ 是本文件独有的编译期占位符，不要手工赋值：
// plugins/clientInjections.ts 的 createClientConfigValueReplacer() 一次性生成所有替换值，
// transform 里 injectConfigValues(code) 逐个 replace（多数只替换首次出现，__BASE__ 是全局 /g）。
// 对应关系：
//   __SERVER_HOST__        <- resolveHostname(server.host) + server.port + base
//   __HMR_PROTOCOL__       <- server.ws.protocol 或 null（null 时下面按页面协议推断 wss）
//   __HMR_HOSTNAME__       <- server.ws.host 或 null
//   __HMR_PORT__           <- ws.clientPort || ws.port
//                             || (middlewareMode 且未自建 ws server 时 24678) || null
//   __HMR_DIRECT_TARGET__  <- ws.host|resolvedHostname + ws.port|server.port + base（回退直连用）
//   __HMR_BASE__           <- base [+ ws.path]
//   __HMR_TIMEOUT__        <- ws.timeout，默认 30000，既做 ws 心跳也做重连轮询间隔
//   __WS_TOKEN__           <- config.webSocketToken，服务端校验 ?token=
//   __HMR_ENABLE_OVERLAY__ <- server.hmr.overlay !== false
//   __SERVER_FORWARD_CONSOLE__ <- server.forwardConsole 配置
// 注意 bundled dev（environment.config.isBundled）下这个插件不生效，
// 改由 getHmrImplementation() 对已构建的 bundledDevClient 做同一套替换。
console.debug('[vite] connecting...')

// 通过 import.meta.url 反推当前 client 的 host/port：这是「用户没配 hmr 参数」时唯一的兜底来源。
// 需要兜底是因为 __HMR_PORT__ 可能是 null（例如 middlewareMode 由外部 http server 决定端口）。
const importMetaUrl = new URL(import.meta.url)

// use server configuration, then fallback to inference
const serverHost = __SERVER_HOST__
// 优先级：显式配置 > 从 import.meta.url 推断。https 页面必须用 wss，
// 否则浏览器会按混合内容（mixed content）直接拦截连接。
const socketProtocol =
  __HMR_PROTOCOL__ || (importMetaUrl.protocol === 'https:' ? 'wss' : 'ws')
const hmrPort = __HMR_PORT__
const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${
  hmrPort || importMetaUrl.port
}${__HMR_BASE__}`
// directSocketHost 是「绕过页面 host 的直连地址」：只有 __HMR_PORT__ 为 null（端口靠推断）时，
// 才会在首次连接失败后回退到它，见下面 transport.connect 的 catch 分支。
const directSocketHost = __HMR_DIRECT_TARGET__
export const base = __BASE__ || '/'
const hmrTimeout = __HMR_TIMEOUT__
const wsToken = __WS_TOKEN__
const forwardConsole = __SERVER_FORWARD_CONSOLE__

// transport 是 client 侧唯一的外发通道，被 HMRClient.send / invoke、bundled dev、forwardConsole 共用。
// 再包一层 normalizeModuleRunnerTransport 的原因：它补齐 invoke 的 RPC 语义
// （把请求包成 custom/vite:invoke 并按 id 配对 response），WS 本身只会收发字符串。
export const transport = normalizeModuleRunnerTransport(
  (() => {
    let wsTransport = createWebSocketModuleRunnerTransport({
      createConnection: () =>
        new WebSocket(
          `${socketProtocol}://${socketHost}?token=${wsToken}`,
          'vite-hmr',
        ),
      pingInterval: hmrTimeout,
    })

    // 惰性工厂：createConnection 只在 connect() 时才 new WebSocket，
    // 每次 connect 都会新建一条连接，所以回退时直接替换 wsTransport，不复用旧实例。
    return {
      async connect(handlers) {
        try {
          await wsTransport.connect(handlers)
        } catch (e) {
          // only use fallback when port is inferred and was not connected before to prevent confusion
          // 仅当端口是推断出来的（!hmrPort）才回退直连：用户显式配了 port 却连不上，说明是配置问题，
          // 再换地址只会掩盖真正的错误。
          if (!hmrPort) {
            wsTransport = createWebSocketModuleRunnerTransport({
              createConnection: () =>
                new WebSocket(
                  `${socketProtocol}://${directSocketHost}?token=${wsToken}`,
                  'vite-hmr',
                ),
              pingInterval: hmrTimeout,
            })
            try {
              await wsTransport.connect(handlers)
              console.info(
                '[vite] Direct websocket connection fallback. Check out https://vite.dev/config/server-options.html#server-hmr to remove the previous connection error.',
              )
            } catch (e) {
              // 'WebSocket closed without opened.' 是 moduleRunnerTransport 里 reject 的固定文案：
              // 表示握手阶段就被服务端/代理关掉了（token 不对、ws 路径不匹配、或服务根本没起来）。
              if (
                e instanceof Error &&
                e.message.includes('WebSocket closed without opened.')
              ) {
                const currentScriptHostURL = new URL(import.meta.url)
                const currentScriptHost =
                  currentScriptHostURL.host +
                  currentScriptHostURL.pathname.replace(/@vite\/client$/, '')
                console.error(
                  '[vite] failed to connect to websocket.\n' +
                    'your current setup:\n' +
                    `  (browser) ${currentScriptHost} <--[HTTP]--> ${serverHost} (server)\n` +
                    `  (browser) ${socketHost} <--[WebSocket (failing)]--> ${directSocketHost} (server)\n` +
                    'Check out your Vite / network configuration and https://vite.dev/config/server-options.html#server-hmr .',
                )
              }
            }
            return
          }
          console.error(`[vite] failed to connect to websocket (${e}). `)
          throw e
        }
      },
      async disconnect() {
        await wsTransport.disconnect()
      },
      send(data) {
        wsTransport.send(data)
      },
    }
  })(),
)

// willUnload 用于区分「用户真的离开页面」和「服务端重启导致断连」：
// 前者不该触发重连轮询，后者必须等恢复后整页刷新（见 handleMessage 的 vite:ws:disconnect 分支）。
let willUnload = false
if (typeof window !== 'undefined') {
  // window can be misleadingly defined in a worker if using define (see #19307)
  window.addEventListener?.('beforeunload', () => {
    willUnload = true
  })
}

// 作用：把模块 URL 归一化后用于比较/拼接，去掉值为 direct 的查询参数。
// 调用点：本文件 handleMessage('update') 的 CSS 分支，以及比较 <link href> 时。
// 关键参数：pathname 可能是相对路径，所以借 'http://vite.dev' 做解析基准，只取 pathname + search。
// 失败模式：URL 非法会抛 TypeError；调用方传的都是浏览器给出的 href，正常不会。
function cleanUrl(pathname: string): string {
  const url = new URL(pathname, 'http://vite.dev')
  url.searchParams.delete('direct')
  return url.pathname + url.search
}

let isFirstUpdate = true
// outdatedLinkTags 记录「即将被替换掉」的 <link>：它可能已经从 DOM 移除但 load 事件还没来，
// 查找当前 link 时必须跳过，否则会把旧节点误认成目标节点。
const outdatedLinkTags = new WeakSet<HTMLLinkElement>()

// 作用：返回一个去抖的 location.reload，20ms 内的多次调用只刷新一次。
// 调用点：本文件创建 pageReload；实际使用在 handleMessage 的 update / full-reload 分支。
// 为什么去抖：同一次文件变更可能产生多条 update，逐条 reload 会让页面闪多次并丢状态。
// 失败模式：后一次调用会清掉前一次的定时器，那次 reload 便不会发生——这是期望行为。
const debounceReload = (time: number) => {
  let timer: ReturnType<typeof setTimeout> | null
  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    timer = setTimeout(() => {
      location.reload()
    }, time)
  }
}
// 20ms 是「同一批 update 的到达窗口」：服务端一次变更只会发一条 payload，
// 但多个环境/多条 update 可能前后脚到达，去抖把它们的刷新合并成一次。
export const pageReload = debounceReload(20)

// HMRClient 是两端（浏览器 / ModuleRunner）共用的热更新状态机，三个构造参数都是注入点：
//   logger：浏览器用 console，runner 用 module-runner/hmrLogger.ts；
//   transport：这里传上面的 WS transport；
//   importUpdatedModule：这里传浏览器 import()，runner 传 runner.import()。
// 所以 shared/hmr.ts 里的 accept/dispose/queue 逻辑能在浏览器和 SSR 里复用。
const hmrClient = new HMRClient(
  {
    error: (err) => console.error('[vite]', err),
    debug: (...msg) => console.debug('[vite]', ...msg),
  },
  transport,
  // 作用：按 update 描述重新 import 被接受的模块，是 HMR「真正加载新代码」的唯一入口。
  // 调用点：shared/hmr.ts 的 HMRClient.fetchUpdate 内部调用（runner 侧注入的是 runner.import）。
  // 关键参数：acceptedPath 是模块 URL；timestamp 用于破缓存；explicitImportRequired 见下。
  // 失败模式：import 失败由 fetchUpdate 的 try/catch 走 warnFailedUpdate；
  //   循环依赖场景额外挂 catch 主动 reload，因为执行顺序已不可恢复。
  async function importUpdatedModule({
    acceptedPath,
    timestamp,
    explicitImportRequired,
    isWithinCircularImport,
  }) {
    const [acceptedPathWithoutQuery, query] = acceptedPath.split(`?`)
    // URL 里可能已有查询串（如 ?vue&type=style），先拆开再按固定形状拼：
    // import 标记必须在 t= 之前，服务端 transformRequest 依赖这个形状识别「显式 import」。
    const moduleUrl = `${acceptedPathWithoutQuery}?${explicitImportRequired ? 'import&' : ''}t=${timestamp}${
      query ? `&${query}` : ''
    }`
    // shared/utils.ts 的 moduleUrlToBrowserUrl：裸 id（不以 . 或 / 开头）先 wrapId 成 /@id/...，
    // 再拼 base；否则浏览器会把虚拟模块当成相对路径解析。
    const browserUrl = moduleUrlToBrowserUrl(moduleUrl, base)
    // 必须 @vite-ignore：URL 是运行期拼的，任何静态分析（含 rolldown 的 import 重写）都不该改写它。
    const importPromise = import(/* @vite-ignore */ browserUrl)
    if (isWithinCircularImport) {
      // 循环依赖下的 HMR 无法保证新模块先于旧模块执行，重试只会拿到旧绑定；
      // 整页刷新是唯一正确的恢复手段，日志提示用 --debug hmr 查看环。
      importPromise.catch(() => {
        console.info(
          `[hmr] ${acceptedPath} failed to apply HMR as it's within a circular import. Reloading page to reset the execution order. ` +
            `To debug and break the circular import, you can run \`vite --debug hmr\` to log the circular dependency path if a file change triggered it.`,
        )
        pageReload()
      })
    }
    return await importPromise
  },
)
// set by the full-bundle-mode entry (`bundledDevClient.ts`); the `import type` above keeps
// `BundledDevHMRClient` compile-time only, so `client.mjs` bundles no bundled-dev code
// 作用：让 full-bundle 模式（client/bundledDevClient.ts）把自己的 HMR 实现注册进来，
//   之后 handleMessage 会把 update 交给它，而不是基于逐模块请求的 hmrClient。
// 调用点：client/bundledDevClient.ts 顶层（注册 bundledDevHmrClient 实例）。
// 为什么用注册而不是直接 import：clientEntry.ts 要保证 /@vite/client 里不含 bundled dev 代码，
//   所以这里只用 `import type`，运行期由另一个入口反向注入实例。
let bundledDevClient: BundledDevHMRClient | undefined
export function registerBundledDevClient(client: BundledDevHMRClient): void {
  bundledDevClient = client
}
// 顺序敏感：先 connect 并挂上消息处理器，再注册 forwardConsole（后者也要 send，
// 未连接时 normalizeModuleRunnerTransport 会让 send 等待 connectingPromise）。
// createHMRHandler 把 handleMessage 串成队列——两条 update 并发执行会打乱模块求值顺序。
transport.connect!(createHMRHandler(handleMessage))

// 把浏览器 console 转发到 dev server（server.forwardConsole 开启时才真正生效），
// 复用同一条 transport，因此不会干扰 HMR 消息的顺序。
setupForwardConsoleHandler(transport, forwardConsole)

// if this is the first update and there's already an error overlay, it means the
// page opened with existing server compile error and the whole module script failed
// to load (since one of the nested imports is 500). in this case a normal update
// won't work and a full reload is needed.
// 作用：首条 update 到达时的「自检」——页面若带着服务端编译错误的浮层启动，
//   说明入口模块图在加载阶段就 500 了，普通 HMR 补不上，必须整页刷新。
// 调用点：本文件 handleMessage('update') 开头；client/bundledDevClient.ts 作为 beforeApply 传入。
// 关键参数：无；返回 'reload' 表示已发起刷新，调用方应立即 return。
// 失败模式：非首次 update 时只清浮层不刷新；无 document（worker）时直接 'continue'。
export function clearOverlayOrReloadOnFirstUpdate(): 'reload' | 'continue' {
  if (hasDocument) {
    if (isFirstUpdate && hasErrorOverlay()) {
      location.reload()
      return 'reload'
    }
    if (enableOverlay) {
      // 只有「首次 update 且已有浮层」才 reload；其余情况先清掉旧浮层，避免旧错误遮住新的成功结果。
      clearErrorOverlay()
    }
    isFirstUpdate = false
  }
  return 'continue'
}

// 作用：HMR 协议在浏览器侧的总分发器，payload 类型见 types/hmrPayload.d.ts。
// 调用点：本文件 transport.connect 处经 createHMRHandler 包装后注册为 onMessage。
// 关键参数：payload.type 决定走向；activeHmrClient 让 bundled dev 模式整体替换实现。
// 失败模式：本函数不 catch；异常会冒泡进 createHMRHandler 的队列，只 reject 当前这次 enqueue，
//   不会中断后续消息（Queue 在 finally 里继续 dequeue）。
async function handleMessage(payload: HotPayload) {
  // bundled dev 注册过就用它：它基于 rolldown 的 DevRuntime 自己算 HMR 边界，
  // 与下面基于逐模块 HTTP 请求的 hmrClient 是互斥的两条实现路径。
  const activeHmrClient = bundledDevClient ?? hmrClient
  switch (payload.type) {
    case 'connected':
      // 只是握手确认，便于用户看到连接成功；真正的连接状态由 transport 层维护。
      console.debug(`[vite] connected.`)
      break
    case 'bundled-dev-update':
      // full-bundle 模式专用：不带 updates 列表，由客户端自己按 changedIds 算边界并拉补丁。
      bundledDevClient!.handlePush(payload)
      break
    case 'update':
      // 先广播 vite:beforeUpdate，再判断首更；顺序不能反——监听者可能依赖「更新尚未应用」的状态。
      await activeHmrClient.notifyListeners('vite:beforeUpdate', payload)
      if (clearOverlayOrReloadOnFirstUpdate() === 'reload') {
        return
      }
      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          if (update.type === 'js-update') {
            // 刻意不在这里 await 出结果：queueUpdate 会把同一轮的多次 fetch 攒成一批，
            // 再按服务端给出的顺序执行 accept 回调（见 shared/hmr.ts 的 updateQueue）。
            return hmrClient.queueUpdate(update)
          }

          // css-update
          // this is only sent when a css file referenced with <link> is updated
          // 这条分支只处理「<link rel=stylesheet> 引入的 CSS」：它由 HTML 直接引用、没有 JS 模块包裹，
          // 所以不能走 import()，只能换 DOM 节点。
          // 由 <script> 注入的 <style> 走 updateStyle()/removeStyle()，见本文件后半部分。
          const { path, timestamp } = update
          const searchUrl = cleanUrl(path)
          // can't use querySelector with `[href*=]` here since the link may be
          // using relative paths so we need to use link.href to grab the full
          // URL for the include check.
          // 不能用 CSS 选择器 [href*=]：link 里可能是相对路径，必须用解析后的 e.href 做 includes 比较。
          // 跳过 outdatedLinkTags，防止匹配到上一轮已被替换、尚未 remove 的节点。
          const el = Array.from(
            document.querySelectorAll<HTMLLinkElement>('link'),
          ).find(
            (e) =>
              !outdatedLinkTags.has(e) && cleanUrl(e.href).includes(searchUrl),
          )

          if (!el) {
            // 页面里没有这条 link（样式是别的机制注入的），本次 css-update 直接忽略。
            return
          }

          const moduleUrl = `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}t=${timestamp}`
          const browserUrl = moduleUrlToBrowserUrl(moduleUrl, base)

          // rather than swapping the href on the existing tag, we will
          // create a new link tag. Once the new stylesheet has loaded we
          // will remove the existing link tag. This removes a Flash Of
          // Unstyled Content that can occur when swapping out the tag href
          // directly, as the new stylesheet has not yet been loaded.
          // 新建而不是改 href：直接改 href 会出现「新样式还没下载完、旧样式已被卸载」的空白帧（FOUC）。
          // load / error 都要 resolve：即使新样式加载失败也要删掉旧节点并结束 Promise，
          // 否则 Promise.all 会一直挂着，update 队列后面的消息全部卡死。
          return new Promise((resolve) => {
            const newLinkTag = el.cloneNode() as HTMLLinkElement
            newLinkTag.href = new URL(browserUrl, el.href).href
            const removeOldEl = () => {
              el.remove()
              console.debug(`[vite] css hot updated: ${searchUrl}`)
              resolve()
            }
            newLinkTag.addEventListener('load', removeOldEl)
            newLinkTag.addEventListener('error', removeOldEl)
            outdatedLinkTags.add(el)
            el.after(newLinkTag)
          })
        }),
      )
      await activeHmrClient.notifyListeners('vite:afterUpdate', payload)
      break
    case 'custom': {
      // 自定义事件直接广播给 import.meta.hot.on 注册的监听者，服务端可发任意 event。
      await activeHmrClient.notifyListeners(payload.event, payload.data)
      if (payload.event === 'vite:ws:disconnect') {
        if (hasDocument && !willUnload) {
          // 断连且不是页面卸载：服务端可能正在重启。这里不发新 HMR，而是轮询 ping 到恢复后整页刷新，
          // 因为断连期间错过的消息无法补发。willUnload 为 true 时跳过，避免关页面时触发刷新。
          console.log(`[vite] server connection lost. Polling for restart...`)
          const socket = payload.data.webSocket as WebSocket
          const url = new URL(socket.url)
          // 去掉 ?token= 再拼 ping：'vite-ping' 子协议不需要 token，
          // 也避免把凭据写进反复轮询的 URL。
          url.search = '' // remove query string including `token`
          await waitForSuccessfulPing(url.href)
          location.reload()
        }
      }
      break
    }
    case 'full-reload':
      // `ifFallback` reloads are addressed only to the bundling-fallback page,
      // which marks itself with this global (see `generateFallbackHtml`)
      // ifFallback 只针对 bundling 回退页（generateFallbackHtml 打的全局标记），其他页面收到应忽略。
      if (
        payload.ifFallback &&
        !(globalThis as any).__vite_is_fallback_page__
      ) {
        break
      }
      await activeHmrClient.notifyListeners('vite:beforeFullReload', payload)
      if (hasDocument) {
        if (payload.path && payload.path.endsWith('.html')) {
          // if html file is edited, only reload the page if the browser is
          // currently on that page.
          // payloadPath 用 base + path.slice(1) 还原成带 base 的绝对路径，与 location.pathname 对齐。
          // pagePath 需要 decodeURI：location.pathname 是编码过的，中文/空格路径直接比较会不等。
          const pagePath = decodeURI(location.pathname)
          const payloadPath = base + payload.path.slice(1)
          if (
            pagePath === payloadPath ||
            payload.path === '/index.html' ||
            (pagePath.endsWith('/') && pagePath + 'index.html' === payloadPath)
          ) {
            pageReload()
          }
          return
        } else {
          // 非 HTML（path 为 '*' 或不带 path）：所有页面一起刷新，服务端认为影响范围不可精确化。
          pageReload()
        }
      }
      break
    case 'prune':
      // prune 的语义是「模块已不在图上，但副作用还留着」：先广播，再执行各模块的 dispose/prune 回调清理。
      await activeHmrClient.notifyListeners('vite:beforePrune', payload)
      await activeHmrClient.prunePaths(payload.paths)
      break
    case 'error': {
      await activeHmrClient.notifyListeners('vite:error', payload)
      if (hasDocument) {
        const err = payload.err
        if (enableOverlay) {
          // 默认用 overlay：可读、可点文件名、可 Esc 关闭。
          createErrorOverlay(err)
        } else {
          // 用户显式关掉 server.hmr.overlay 时降级为 console.error，保证错误至少可见。
          console.error(
            `[vite] Internal Server Error\n${err.message}\n${err.stack}`,
          )
        }
      }
      break
    }
    case 'ping': // noop
      // 心跳由 transport 的 setInterval 发出，回包无需处理，仅用于保活（代理/nginx 会掐空闲连接）。
      break
    default: {
      // 穷尽检查：HotPayload 新增类型而这里没处理时，TS 会在编译期报错。
      const check: never = payload
      return check
    }
  }
}

const enableOverlay = __HMR_ENABLE_OVERLAY__
const hasDocument = 'document' in globalThis

// 作用：创建一个新的错误浮层，覆盖在页面最上层。
// 调用点：本文件 handleMessage('error') 的 enableOverlay 分支。
// 先 clear 再 append：同名 custom element 可以叠多个，旧错误不清会盖住新错误。
// overlayId 与构造器由 client/overlay.ts 定义并 customElements.define 注册。
function createErrorOverlay(err: ErrorPayload['err']) {
  clearErrorOverlay()
  const { customElements } = globalThis
  if (customElements) {
    const ErrorOverlayConstructor = customElements.get(overlayId)!
    document.body.appendChild(new ErrorOverlayConstructor(err))
  }
}

// close() 由 ErrorOverlay 自己实现（移除节点 + 解绑 keydown），这里只负责遍历所有浮层。
function clearErrorOverlay() {
  document.querySelectorAll<ErrorOverlay>(overlayId).forEach((n) => n.close())
}

// 返回数量而非布尔值：clearOverlayOrReloadOnFirstUpdate 用它判断「页面是否带着错误启动」。
function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length
}

// 作用：服务端断连后反复探测 WS 是否恢复，恢复后由调用方整页刷新。
// 调用点：本文件 handleMessage('custom') 的 vite:ws:disconnect 分支。
// 关键参数：socketUrl 已去掉 token 与查询串。
// 失败模式：除 SharedWorker 内部报错外不会 reject；
//   页面不可见时会挂起等待 visibilitychange，避免后台标签页疯狂重连。
function waitForSuccessfulPing(socketUrl: string) {
  // 无 SharedWorker 或 Trusted Types 拒绝 blob URL 时的主线程实现：
  // 区别只是可见性状态由本页自己维护。
  const useMainThreadFallback = () => {
    const visibilityManager: VisibilityManager = {
      currentState: document.visibilityState,
      listeners: new Set(),
    }
    const onVisibilityChange = () => {
      visibilityManager.currentState = document.visibilityState
      for (const listener of visibilityManager.listeners) {
        listener(visibilityManager.currentState)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return waitForSuccessfulPingInternal(socketUrl, visibilityManager)
  }

  if (typeof SharedWorker === 'undefined') {
    return useMainThreadFallback()
  }

  // needs to be inlined to
  //   - load the worker after the server is closed
  //   - make it work with backend integrations
  // 必须内联 Worker 代码：服务端关闭后已无法再 fetch 任何脚本，/@vite/client 本身也可能已卸载；
  // 内联才能兼容把 client 打进后端产物的场景。toString() 依赖下面两个函数不引用外部闭包变量。
  const blob = new Blob(
    [
      '"use strict";',
      `const waitForSuccessfulPingInternal = ${waitForSuccessfulPingInternal.toString()};`,
      `const fn = ${pingWorkerContentMain.toString()};`,
      `fn(${JSON.stringify(socketUrl)})`,
    ],
    { type: 'application/javascript' },
  )
  const objURL = URL.createObjectURL(blob)

  let sharedWorker: SharedWorker
  try {
    sharedWorker = new SharedWorker(objURL)
  } catch (error) {
    URL.revokeObjectURL(objURL)
    // Trusted Types enforcement rejects string worker URLs.
    // Trusted Types 强制策略下 new SharedWorker(string) 会抛 TypeError，此时降级主线程轮询。
    if (error instanceof TypeError) {
      return useMainThreadFallback()
    }
    throw error
  }
  return new Promise<void>((resolve, reject) => {
    const onVisibilityChange = () => {
      // 页面可见性转发给 worker：后台标签页里定时器/WS 会被节流，
      // 由「只在可见时探测」驱动更可靠，也能避免无意义的连接尝试。
      sharedWorker.port.postMessage({ visibility: document.visibilityState })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    sharedWorker.port.addEventListener('message', (event) => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      sharedWorker.port.close()

      const data: { type: 'success' } | { type: 'error'; error: Error } =
        event.data
      if (data.type === 'error') {
        reject(data.error)
        return
      }
      resolve()
    })

    onVisibilityChange()
    sharedWorker.port.start()
  })
}

type VisibilityManager = {
  currentState: DocumentVisibilityState
  listeners: Set<(newVisibility: DocumentVisibilityState) => void>
}

// SharedWorker 内部逻辑（被 toString() 内联进 blob）：接收页面发来的 visibility，
// 用 waitForSuccessfulPingInternal 轮询，成功/失败都通过 port 回传。
// 注意：这里依赖 self.addEventListener('connect')，只能在 worker 里执行。
function pingWorkerContentMain(socketUrl: string) {
  self.addEventListener('connect', (_event) => {
    const event = _event as MessageEvent
    const port = event.ports[0]

    if (!socketUrl) {
      // 防御空 URL：blob 模板里 socketUrl 来自 JSON.stringify，正常不会是空串。
      port.postMessage({
        type: 'error',
        error: new Error('socketUrl not found'),
      })
      return
    }

    const visibilityManager: VisibilityManager = {
      currentState: 'visible',
      listeners: new Set(),
    }
    port.addEventListener('message', (event) => {
      const { visibility } = event.data
      visibilityManager.currentState = visibility
      console.debug('[vite] new window visibility', visibility)
      for (const listener of visibilityManager.listeners) {
        listener(visibility)
      }
    })
    port.start()

    console.debug('[vite] connected from window')
    waitForSuccessfulPingInternal(socketUrl, visibilityManager).then(
      () => {
        console.debug('[vite] ping successful')
        try {
          port.postMessage({ type: 'success' })
        } catch (error) {
          port.postMessage({ type: 'error', error })
        }
      },
      (error) => {
        console.debug('[vite] error happened', error)
        try {
          port.postMessage({ type: 'error', error })
        } catch (error) {
          port.postMessage({ type: 'error', error })
        }
      },
    )
  })
}

// 作用：真正的探测循环。
// 调用点：waitForSuccessfulPing 的主线程回退分支、pingWorkerContentMain（SharedWorker 内部）。
// 关键参数：ms 是轮询间隔（固定 1000）；visibilityManager 提供当前页面可见性。
// 失败模式：不设重试上限，连接不恢复就一直等；这是有意的——此时页面已无法正常工作。
async function waitForSuccessfulPingInternal(
  socketUrl: string,
  visibilityManager: VisibilityManager,
  ms = 1000,
) {
  function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function ping() {
    try {
      // 用专门子协议 'vite-ping' 建一条短连接：能 open 就说明服务端 WS 已恢复。
      // 只监听 open/error 并立即 close，不做任何消息交互，也不带 token。
      const socket = new WebSocket(socketUrl, 'vite-ping')
      return new Promise<boolean>((resolve) => {
        function onOpen() {
          resolve(true)
          close()
        }
        function onError() {
          resolve(false)
          close()
        }
        function close() {
          socket.removeEventListener('open', onOpen)
          socket.removeEventListener('error', onError)
          socket.close()
        }
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onError)
      })
    } catch {
      return false
    }
  }

  function waitForWindowShow(visibilityManager: VisibilityManager) {
    return new Promise<void>((resolve) => {
      const onChange = (newVisibility: DocumentVisibilityState) => {
        if (newVisibility === 'visible') {
          resolve()
          visibilityManager.listeners.delete(onChange)
        }
      }
      visibilityManager.listeners.add(onChange)
    })
  }

  if (await ping()) {
    // 先立即探测一次：服务端可能已经恢复，省掉第一次 1s 等待。
    return
  }
  await wait(ms)

  while (true) {
    if (visibilityManager.currentState === 'visible') {
      if (await ping()) {
        break
      }
      await wait(ms)
    } else {
      // 页面不可见时挂起，不发起连接尝试；等 visibilitychange 变可见再继续循环。
      await waitForWindowShow(visibilityManager)
    }
  }
}

// 两套表对应两种 CSS 载入方式：
//   sheetsMap：<style data-vite-dev-id>，由 css.ts 注入的 updateStyle 创建/维护；
//   linkSheetsMap：<link rel=stylesheet data-vite-dev-id>，由 HTML 直接引用，
//     其热更新在 handleMessage 的 css-update 分支里换节点，updateStyle 不能覆盖它。
// 两个 map 的 key 都是模块 URL（见 css.ts 里 __vite__id = id）。
const sheetsMap = new Map<string, HTMLStyleElement>()
const linkSheetsMap = new Map<string, HTMLLinkElement>()

// collect existing style elements that may have been inserted during SSR
// to avoid FOUC or duplicate styles
// SSR 场景下服务端可能已把样式内联进 HTML；客户端启动时先把它们登记进 map，
// 否则 HMR 会再插一份，导致重复样式 / FOUC。
if ('document' in globalThis) {
  document
    .querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')
    .forEach((el) => {
      sheetsMap.set(el.getAttribute('data-vite-dev-id')!, el)
    })
  document
    .querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][data-vite-dev-id]',
    )
    .forEach((el) => {
      linkSheetsMap.set(el.getAttribute('data-vite-dev-id')!, el)
    })
}

// all css imports should be inserted at the same position
// because after build it will be a single css file
// 所有 dev 期注入的 <style> 连续插在一起，顺序与构建后合并成单个 css 文件的顺序保持一致，
// 否则 dev 与 prod 的层叠（cascade）优先级会不同。
let lastInsertedStyle: HTMLStyleElement | undefined

// 作用：插入/更新一条 <style> 样式。
// 调用点：plugins/css.ts 生成的模块代码（__vite__updateStyle(__vite__id, __vite__css)）；
//   浏览器侧经 clientEntry.ts 导出为 /@vite/client 的公开 API。
// 关键参数：id = 模块 URL（同时写进 data-vite-dev-id 供 removeStyle 定位）；content = CSS 文本。
// 失败模式：无 document（worker/SSR）时会在 createElement 处抛错——本函数只应在浏览器调用。
export function updateStyle(id: string, content: string): void {
  if (linkSheetsMap.has(id)) return

  let style = sheetsMap.get(id)
  if (!style) {
    // 首次插入：必须带 cspNonce，否则 CSP 严格的页面会拒绝这条内联样式。
    style = document.createElement('style')
    style.setAttribute('type', 'text/css')
    style.setAttribute('data-vite-dev-id', id)
    style.textContent = content
    if (cspNonce) {
      style.setAttribute('nonce', cspNonce)
    }

    if (!lastInsertedStyle) {
      document.head.appendChild(style)

      // reset lastInsertedStyle after async
      // because dynamically imported css will be split into a different file
      // 插入后立刻（宏任务）清掉 lastInsertedStyle：紧接着的动态 import 可能拆出另一个 CSS 文件，
      // 不能继续以它为锚点，否则顺序会与构建产物不一致。
      setTimeout(() => {
        lastInsertedStyle = undefined
      }, 0)
    } else {
      // 后续样式插到上一个之后，保持「声明顺序 = 模块引入顺序」。
      lastInsertedStyle.insertAdjacentElement('afterend', style)
    }
    lastInsertedStyle = style
  } else if (style.textContent !== content) {
    // skip identical css, e.g. in a server rendered style: rewriting it still
    // replaces the stylesheet, which can re-create the font faces it declares
    // 内容相同就跳过写入：重写 textContent 会让浏览器重建整张 stylesheet，
    // @font-face 会被重新注册（重复下载字体）。
    style.textContent = content
  }
  sheetsMap.set(id, style)
}

// 作用：移除某模块注入的样式。
// 调用点：plugins/css.ts 注入的 `import.meta.hot.prune(() => __vite__removeStyle(__vite__id))`，
//   热更新后模块不再被引用时由 shared/hmr.ts 的 HMRClient.prunePaths 触发。
// 关键参数：id 同 updateStyle（模块 URL）。
// 失败模式：找不到节点时静默返回；重复调用安全（两个 map 会同步删除）。
export function removeStyle(id: string): void {
  if (linkSheetsMap.has(id)) {
    // re-select elements since HMR can replace links
    // link 会被 css-update 整体替换成新节点，所以必须重新 query，不能用 map 里缓存的旧引用。
    document
      .querySelectorAll<HTMLLinkElement>(
        // CSS.escape：模块 URL 含 ?、& 等选择器特殊字符，不转义会拼出非法选择器。
        `link[rel="stylesheet"][data-vite-dev-id="${CSS.escape(id)}"]`,
      )
      .forEach((el) => el.remove())
    linkSheetsMap.delete(id)
  }
  const style = sheetsMap.get(id)
  if (style) {
    document.head.removeChild(style)
    sheetsMap.delete(id)
  }
}

// 作用：为某个模块创建 import.meta.hot 上下文。
// 调用点：plugins/importAnalysis.ts 注入的 `import.meta.hot = __vite__createHotContext(moduleUrl)`。
// 关键参数：moduleUrl 必须是模块自身的 URL（ownerPath），accept 的依赖比较基于它。
// 失败模式：每次调用都会重置该模块已注册的回调（见 HMRContext 构造函数），
//   所以同一模块重复求值不会累积旧的 accept 监听。
export function createHotContext(moduleUrl: string): ViteHotContext {
  return new HMRContext(hmrClient, moduleUrl)
}

/**
 * urls here are dynamic import() urls that couldn't be statically analyzed
 */
// 作用：给模块 URL 追加一个查询参数（如 t=时间戳、import、direct），用于破缓存或改变服务端处理路径。
// 调用点：plugins/importAnalysis.ts 会把本函数源码内联进模块，运行期用 __vite__injectQuery；
//   bundled dev 与 worker 场景也复用同一实现。
// 关键参数：url 必须是相对/绝对路径，否则原样返回（不碰裸包名与带协议的 URL）。
// 失败模式：不校验结果合法性；调用方负责传入已解析过的 specifier。
export function injectQuery(url: string, queryToInject: string): string {
  // skip urls that won't be handled by vite
  // 裸说明符（如 'vue'）和带协议的 URL 不由 Vite 处理，直接放行。
  if (url[0] !== '.' && url[0] !== '/') {
    return url
  }

  // can't use pathname from URL since it may be relative like ../
  // 不能用 new URL(url).pathname：url 可能是 '../a.css' 这种相对路径，pathname 会丢信息。
  const pathname = url.replace(/[?#].*$/, '')
  const { search, hash } = new URL(url, 'http://vite.dev')

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ''}${
    hash || ''
  }`
}

// 重新导出错误浮层组件：clientEntry.ts 把它作为 /@vite/client 的公开 API 之一。
export { ErrorOverlay }
