// ============================================================================
// indexHtml.ts —— dev server 中 HTML 请求的最后一站，也是「浏览器 → Vite」链路的第一段
// ============================================================================
// 位置：packages/vite/src/node/server/middlewares/
// 上游：
//   dev —— server/index.ts 的 createServer 里 `middlewares.use(indexHtmlMiddleware(root, server))`，
//          排在 htmlFallbackMiddleware 与 configureServer 的 post 中间件之后；
//   preview —— preview.ts 的 preview() 里 `app.use(indexHtmlMiddleware(normalizedDistDir, server))`，
//          此时第二个参数是 PreviewServer，且不做任何 HTML 转换。
// 下游：
//   server.transformIndexHtml（server/index.ts）→ 本文件 createDevHtmlTransformFn 返回的闭包
//   → plugins/html.ts 的 applyHtmlTransforms 依次执行 hook 链，其中 devHtmlHook 是本文件的内置改写。
// 关键不变量：
//   1. 只有 `url.endsWith('.html')` 的请求会在这里出内容；把 `/foo` 补成 `/foo.html` 或
//      `/index.html` 是 htmlFallbackMiddleware 的职责（见 htmlFallback.ts），不是这里的。
//   2. dev 下每次请求都重新读盘 + 重新跑 hook 链，不做结果缓存；缓存语义交给
//      `Cache-Control: no-cache` + 内容 etag 的 304 协商（实现在 server/send.ts）。
//   3. bundledDev（experimental.bundledDev）是另一条路：HTML 直接取自 rolldown 的内存产物，
//      不经过 transformIndexHtml，也不会触发 devHtmlHook。
// 容易误解：
//   - 这里的 `.html` 判断额外排除 `sec-fetch-dest: script`：浏览器把 HTML 当模块 import 时
//     应该由前面的 transformMiddleware 返回模块代码，不能返回整页文档。
//   - 本文件不解析 `<base href>`；相对 URL 的基准是「当前文档 URL」，见 devHtmlHook 的 processNodeUrl。
// ============================================================================
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import escapeHTML from 'escape-html'
import MagicString from 'magic-string'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { SourceMapInput } from 'rolldown'
import type { Connect } from '#dep-types/connect'
import type { PreviewServer, ResolvedConfig, ViteDevServer } from '../..'
import { cleanUrl, moduleUrlToBrowserUrl } from '../../../shared/utils'
import { getNodeAssetAttributes } from '../../assetSource'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import { getHmrImplementation } from '../../plugins/clientInjections'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  extractImportExpressionFromClassicScript,
  findNeedTransformStyleAttribute,
  getScriptInfo,
  htmlEnvHook,
  htmlProxyResult,
  injectCspNonceMetaTagHook,
  injectNonceAttributeTagHook,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  removeViteIgnoreAttr,
  resolveHtmlTransforms,
  traverseHtml,
} from '../../plugins/html'
import { checkPublicFile } from '../../publicDir'
import {
  decodeURIIfPossible,
  ensureWatchedFile,
  getHash,
  injectQuery,
  isCSSRequest,
  isDevServer,
  isJSRequest,
  isParentDirectory,
  normalizePath,
  processSrcSetSync,
  tryStatSync,
} from '../../utils'
import {
  addHtmlRequestToSafeModulePaths,
  getHtmlAssetFetchDest,
  htmlUrlToRequestUrl,
} from '../htmlSafeModulePaths'
import { browserUrlToModuleUrl, moduleUrlToFilePath } from '../moduleUrl'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from '../pluginContainer'
import { send } from '../send'
import { getCodeWithSourcemap, injectSourcesContent } from '../sourcemap'
import { checkLoadingAccess, respondWithAccessDenied } from './static'

// 一个需要被 CSS 插件处理的 `<style>` 片段：start/end 是文本内容在原始 HTML 里的偏移。
interface AssetNode {
  start: number
  end: number
  code: string
}

// 一个含 url()/image-set() 的 style 属性：code 是属性值原文，location 是值在 HTML 里的区间。
// 单独收集是因为它的处理路径与 `<style>` 不同（要追踪 css-post 插件写入 htmlProxyResult 的结果）。
interface InlineStyleAttribute {
  index: number
  location: Token.Location
  code: string
}

// 作用：在 server 启动时调用一次，把用户插件的 transformIndexHtml 按 order 分成三段，
//       再与内置 hook 拼成一条固定顺序的数组，返回一个「每次 HTML 请求都调用」的转换函数。
// 调用点：server/index.ts 的 createServer（`const devHtmlTransformFn = createDevHtmlTransformFn(config)`），
//         之后由 server.transformIndexHtml 转发（server/index.ts 的 transformIndexHtml 方法），
//         indexHtmlMiddleware 也正是通过 server.transformIndexHtml 间接触发它。
// 关键参数：config 必须是 resolveConfig 后的最终配置（插件数组已按 enforce 排好、html.cspNonce/env 已定）。
//          返回函数收到的 url 是已去掉 query 的请求路径；originalUrl 保留 base 与 query，
//          作为相对 URL 的解析基准（见 htmlUrlToRequestUrl）。
// 失败模式：本函数自身不会失败；某个 hook 抛错会让返回的 Promise reject，
//           由 indexHtmlMiddleware 的 try/catch 捕获后 next(e) 交给 errorMiddleware。
export function createDevHtmlTransformFn(
  config: ResolvedConfig,
): (
  server: ViteDevServer,
  url: string,
  html: string,
  originalUrl?: string,
) => Promise<string> {
  // 用户 hook 的三段划分只看 transformIndexHtml.order（'pre' | 'post' | 默认），与插件的 enforce 无关：
  // enforce 只在 resolvePlugins 阶段决定插件在 config.plugins 里的先后，也就是只影响「同一段内部」的相对顺序。
  // 想让自己的 hook 跨段提前，必须显式写 order: 'pre'；写 enforce: 'pre' 不会起作用。
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
  )
  // 完整顺序（从上到下执行，后者看到的是前者的输出）：
  //   1. preImportMapHook          只检查 importmap 是否出现在 module script 之前并 warn，必须看到原始顺序；
  //   2. injectCspNonceMetaTagHook 注入 `<meta property="csp-nonce">`，供客户端读取 nonce；
  //   3. 用户 order:'pre'          用户最早的改写时机；
  //   4. htmlEnvHook               替换 %ENV_NAME%，必须早于 devHtmlHook：替换出来的路径还要再被改写；
  //   5. devHtmlHook               内置结构性改写（注入 @vite/client、script→proxy、内联样式等）；
  //   6. 用户 normal hooks         此时 @vite/client 已经注入（devHtmlHook 返回的 tags 在它之后立即生效）；
  //   7. 用户 order:'post'        用户收尾改写；
  //   8. injectNonceAttributeTagHook 给所有 script/style/link 补 nonce，放最后才能覆盖用户 post 注入的标签；
  //   9. postImportMapHook         把 importmap 移到第一个 module script / modulepreload 之前，必须最后做。
  const transformHooks = [
    preImportMapHook(config),
    injectCspNonceMetaTagHook(config),
    ...preHooks,
    htmlEnvHook(config),
    devHtmlHook,
    ...normalHooks,
    ...postHooks,
    injectNonceAttributeTagHook(config),
    postImportMapHook(config),
  ]
  // hook 以这个最小 plugin context 作为 `this` 执行：只提供 warn/error 等日志能力，
  // 不绑定具体 environment（HTML 转换是 config 级的，不属于 client/ssr 任一环境）。
  const pluginContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  return (
    server: ViteDevServer,
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string> => {
    // ctx.path 用去掉 query 的 url；ctx.filename 是磁盘绝对路径（虚拟 HTML 会是 root 本身），
    // 后者只用于 sourcemap 与告警里展示相对路径。
    return applyHtmlTransforms(html, transformHooks, pluginContext, {
      path: url,
      filename: getHtmlFilename(url, server),
      server,
      originalUrl,
    })
  }
}

// 作用：把「浏览器请求的 ModuleURL」还原成磁盘绝对路径，作为 hook ctx.filename。
// 调用点：本文件 createDevHtmlTransformFn 返回函数的 ctx.filename 字段。
// 关键点：/@fs/ 前缀由 moduleUrlToFilePath 交给 fsPathFromId 处理，其余按 root 解析；
//        decodeURIComponent 必须在 cleanUrl 之后：先去 ?query，再解 %20 这类编码。
// 失败模式：不做存在性检查，路径不存在也照常返回。
function getHtmlFilename(url: string, server: ViteDevServer) {
  return moduleUrlToFilePath(
    decodeURIComponent(cleanUrl(url)),
    server.config.root,
  )
}

// 作用：决定 HTML 里引用的某个 URL 是否要在返回 HTML 前「预热」（提前发起一次 transform）。
// 调用点：本文件 devHtmlHook → processNodeUrl 的 replacer，仅对 type=module 的脚本生效。
// 条件：不能是 public 目录里的文件（public 文件原样返回、不参与编译），且必须是 JS 或 CSS 请求。
// 失败模式：纯启发式判断；判错只会多一次无效预热，不影响输出正确性。
function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  )
}

const wordCharRE = /\w/

// 作用：判断 URL 是否是「裸相对」形式——首字符是词字符且不含冒号，例如 `foo.js`、`main.css`。
// 调用点：本文件 devHtmlHook → processNodeUrl 的 replacer，与 './x' 一起决定 SPA fallback 时是否补 base。
// 细节：首字符为词字符可排除 `/`、`.`、`#`、`?`；不含冒号可排除 `https:`、`data:`、`C:` 这类。
function isBareRelative(url: string) {
  return wordCharRE.test(url[0]) && !url.includes(':')
}

// `//` 开头的 URL 在浏览器里是「协议相对」，HTML 里没有语法能表达「以 // 开头的相对路径」，
// 所以 devHtmlHook 会把连续 `//` 压成单个 `/`（见下方注释）。
const multipleLeadingSlashesRE = /^\/{2,}/g

// 作用：内置的 HTML 结构性改写 hook，dev 下由 createDevHtmlTransformFn 放在 hook 链中部。
//       它做四件事：
//         1) 把 HTML 里会被浏览器请求的 URL 归一化成 Vite 可服务的形式（补 base、按文档 URL 解析、`?t=`）；
//         2) 把内联 `<script type="module">` 改写成 `src="...?html-proxy&index=N.js"`，内容搬进虚拟模块；
//         3) 把 `<style>` 文本与 style 属性交给 CSS 插件转换后原地写回；
//         4) 返回 `@vite/client` 的 script tag，由 applyHtmlTransforms 注入 head-prepend。
// 调用点：本文件 createDevHtmlTransformFn 的 transformHooks 数组（位于用户 normal hooks 之前）。
//         build 侧不走这里，而是 plugins/html.ts 的 buildHtmlPlugin。
// 关键参数：
//   html —— 上一个 hook 的输出，不是磁盘原文；
//   ctx.path / ctx.filename / ctx.originalUrl —— 分别对应请求 URL、磁盘路径、带 base/query 的原始 URL；
//   ctx.server —— 只有 dev 才有，SSR 集成直接调 transformIndexHtml 时可能为 undefined（代码里用 server! 断言）。
// 失败模式：parse5 解析错误只 warn（traverseHtml 的 onParseError）；CSS transform 抛错会让整个 HTML 请求失败。
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl },
) => {
  // HTML 里 `//foo` 会被浏览器当成协议相对 URL（沿用当前页面的协议），但这里需要的是相对路径。
  // 把连续 `//` 压成 `/` 后，后续 URL 归一化才有确定的基准。
  // There's no way to express a relative URL that starts with `//`. URLs starting with `//` is relative to the scheme.
  // The relative URL is needed to generate the URL in script tags and link tags.
  // We replace `//` with `/` here for workaround, which is the best we can do.
  if (htmlPath.startsWith('//')) {
    htmlPath = htmlPath.replace(multipleLeadingSlashesRE, '/')
  }

  const { config, watcher } = server!
  // base 用于拼写回 HTML 的 URL（保留 URL 编码）；decodedBase 是 base 的 URL 解码结果，
  // 供 moduleUrlToBrowserUrl 与「已解码的模块 URL」拼接。base 含非 ASCII 时混用会拼出双重编码的路径。
  const base = config.base || '/'
  const decodedBase = config.decodedBase || '/'

  let proxyModulePath: string
  let proxyModuleUrl: string

  // 两类 HTML 走不同的 identity：
  //   - 磁盘上真实存在的文件：proxyModulePath 用 root 相对的 ModuleURL，便于模块图与缓存键统一；
  //     若 URL 是 /@fs/ 形式（vitest-browser 等外部调用），改用绝对路径，保证缓存键始终是 root 相对形式。
  //   - 虚拟 HTML（URL 以 / 结尾，或 transformIndexHtml 传入不存在的路径，如 SSR 集成传 '/'）：
  //     加 `\0` 前缀标记为虚拟模块，后续不生成 sourcemap，id 也不会被当成真实文件路径解析。
  // trailingSlash 判断放在这里而不是后面：以 / 结尾的 URL 一定指向目录，不可能直接是文件。
  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && tryStatSync(filename)?.isFile()) {
    // 加入 watcher：HTML 文件变化时才能触发 HMR 的 full-reload。
    ensureWatchedFile(watcher, filename, config.root)
    // If htmlPath is a /@fs/ URL (e.g. vitest-browser always uses this form
    // for testerHtmlPath), normalise to an absolute FS path so proxyCacheUrl
    // is always root-relative.
    proxyModulePath = htmlPath.startsWith(FS_PREFIX) ? filename : htmlPath
    proxyModuleUrl = htmlPath
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = proxyModulePath
  }
  // 所有改写都记录在 MagicString 上，最后一次性 toString()：多次字符串拼接会让后面的偏移全部失效。
  const s = new MagicString(html)
  // 内联模块与内联 style 属性共用同一个自增索引：两者最终都以 `?html-proxy&index=N.{js,css}`
  // 的形式进 htmlProxy 缓存，索引必须整个文档内唯一。
  let inlineModuleIndex = -1
  // 缓存键 = 去掉 root 前缀、去掉 query、解码后的路径。必须与 plugins/html.ts 里
  // htmlInlineProxyPlugin.load 的 `file.replace(normalizePath(config.root), '')` 完全一致，
  // 否则 `?html-proxy` 虚拟模块会取不到内容并抛 "No matching HTML proxy module found"。
  // The key to the proxyHtml cache is decoded, as it will be compared
  // against decoded URLs by the HTML plugins.
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), ''),
  )
  // 收集阶段只记位置、不改写：traverseHtml 的 visitor 是同步的，而 CSS 转换是异步的，
  // 所以内联样式的转换统一放到遍历结束后的 Promise.all 里。
  const styleUrl: AssetNode[] = []
  const inlineStyles: InlineStyleAttribute[] = []
  const inlineModuleUrls: string[] = []
  const safeModulePathRegistrations: Promise<void>[] = []
  // 作用：把 HTML 属性里的一个 URL 改写成 Vite dev 能直接服务的形式。
  // 调用点：本文件 devHtmlHook 内三处——script 的 src、classic script 内的 import('...')、
  //         以及 getNodeAssetAttributes 返回的各类 href/src/srcset。
  // 关键参数：useSrcSetReplacer 表示值可能是逗号分隔的候选列表；fetchDest 只用于登记 safeModulePaths；
  //           scriptType 决定是否注入 `?t=` 时间戳与预热。
  // 失败模式：外链 / data URL / 跨 origin / 解析失败时原样返回，不改写。
  const processNodeUrl = (
    url: string,
    useSrcSetReplacer: boolean,
    fetchDest?: string,
    scriptType?: 'module' | 'classic',
  ): string => {
    const replacer = (url: string) => {
      // 第一段：SPA fallback 场景补 base。
      // 页面真实 URL 是 /foo，但磁盘文件是 /index.html；HTML 里写 `./a.js` 在浏览器里会解析成
      // /a.js（相对于 /foo），与 Vite 假设的文档位置不同，所以要显式拼上 base 拉回根。
      // Prefix absolute URLs with base, and relative URLs when serving the SPA
      // fallback so they resolve from the root HTML document.
      if (
        (url[0] === '/' && url[1] !== '/') ||
        ((url[0] === '.' || isBareRelative(url)) &&
          originalUrl &&
          originalUrl !== '/' &&
          htmlPath === '/index.html')
      ) {
        url = path.posix.join(config.base, url)
      }

      // 第二段：按「浏览器会怎么解析这个 URL」算出最终请求路径。
      // htmlUrlToRequestUrl 以 originalUrl（没有则 base+path）作为文档基准；返回 undefined 表示
      // 这是外链 / data URL / 跨 origin / 解析失败，调用方保持原值不动。
      // 注意它不读取 `<base href>`：基准永远是文档 URL，而不是 HTML 自己声明的 base。
      const requestUrl = htmlUrlToRequestUrl(url, base, {
        path: htmlPath,
        originalUrl,
      })
      if (!requestUrl) return url

      // 第三段：只对 <script> 做两件事——HMR 时间戳与非阻塞预热。
      // 静态资源（img/link）注入 `?t=` 只会污染缓存键，没有意义。
      if (scriptType) {
        const decodedUrl = decodeURIIfPossible(requestUrl)
        if (decodedUrl === undefined) return url
        const moduleUrl = browserUrlToModuleUrl(decodedUrl, '')
        // 该模块被 HMR 更新过时，把时间戳写回 HTML，浏览器就会请求到新内容而不是缓存。
        const mod =
          server!.environments.client.moduleGraph.urlToModuleMap.get(moduleUrl)
        if (mod && mod.lastHMRTimestamp > 0) {
          url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
        }
        // 预热：把模块提前塞进 transform 队列，浏览器真正请求时大概率已就绪。
        // 故意不 await：预热失败不影响 HTML 返回，错误由 warmupRequest 自己记日志。
        if (scriptType === 'module' && shouldPreTransform(decodedUrl, config)) {
          preTransformRequest(server!, moduleUrl)
        }
      }

      // 登记「HTML 引用过的模块路径」：加载期文件访问检查会用它放行这些路径。
      // classic script 不是模块，不经过模块图，登记反而会放宽不必要的访问范围。
      if (scriptType !== 'classic') {
        safeModulePathRegistrations.push(
          addHtmlRequestToSafeModulePaths(requestUrl, server!, fetchDest),
        )
      }
      return url
    }

    // srcset 是「URL + 描述符」的逗号分隔列表，必须逐个候选替换，不能整串当 URL 处理。
    return useSrcSetReplacer
      ? processSrcSetSync(url, ({ url }) => replacer(url))
      : replacer(url)
  }

  // 作用：把一个内联 `<script type="module">` 改写成 `<script type="module" src="...?html-proxy&index=N.js">`。
  // 调用点：本文件 devHtmlHook 的 traverseHtml visitor（脚本既无 src、又是 module、且有子节点时）。
  // 关键参数：node 是 parse5 元素；ext 目前恒为 'js'，保留参数是为了与 CSS 侧的 proxy 命名对称。
  // 失败模式：虚拟 HTML（`\0` 开头）跳过 sourcemap；其余情况假定第一个子节点是文本节点。
  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js',
  ) => {
    // 索引自增必须发生在写缓存之前：缓存下标与 URL 里的 index 必须一致。
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    // 只有真实文件才有可信的磁盘位置，才能把内联脚本的行列映射回 HTML；虚拟 HTML 不生成 map。
    let map: SourceMapInput | undefined
    if (proxyModulePath[0] !== '\0') {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset,
        )
        .generateMap({ hires: 'boundary' })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    // 把原始代码与 map 存进缓存，等浏览器请求 ?html-proxy&index=N.js 时由 load 钩子取出。
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    // proxyModuleUrl 是 root 相对路径（或 \0 虚拟 id），拼上固定 query 就是可请求的模块 URL。
    const moduleUrl = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`
    inlineModuleUrls.push(moduleUrl)
    // 写回 HTML 的必须是浏览器 URL：要补 base，而模块图里用的 ModuleURL 不带 base。
    const browserUrl = moduleUrlToBrowserUrl(moduleUrl, decodedBase)

    // 整段替换 <script>…</script>：内联内容被搬走，原位置只留一个 src 引用。
    // 属性值要 escapeHTML，避免 URL 里出现引号把标签截断。
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${escapeHTML(browserUrl)}"></script>`,
    )
    // 预热：HTML 一返回浏览器就会请求这个 proxy 模块，提前开始解析/转换。
    preTransformRequest(server!, moduleUrl)
  }

  // 一次遍历收集所有需要改写的节点，改写动作全部记在 MagicString 上。
  // visitor 里拿到的 location 是原始 HTML 的偏移，后续 s.update/s.overwrite 都基于同一份原文。
  await traverseHtml(html, filename, config.logger.warn, (node) => {
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    // <script> 分四种情况：vite-ignore（只删属性）、外链 src（改 URL）、
    // 内联 module（转 proxy）、内联 classic（只处理可静态识别的 import() 字面量）。
    if (node.nodeName === 'script') {
      const { src, srcSourceCodeLocation, isModule, isIgnored } =
        getScriptInfo(node)

      if (isIgnored) {
        // vite-ignore 是给 Vite 看的标记，本身没有浏览器语义；删掉属性，避免私有标记泄漏到页面。
        removeViteIgnoreAttr(s, node.sourceCodeLocation!)
      } else if (src) {
        // 外链脚本：只归一化 src。type=module 会额外注入 HMR 时间戳并预热，classic 不注入。
        const processedUrl = processNodeUrl(
          src.value,
          /* useSrcSetReplacer */ false,
          'script',
          isModule ? 'module' : 'classic',
        )
        if (processedUrl !== src.value) {
          overwriteAttrValue(s, srcSourceCodeLocation!, processedUrl)
        }
      } else if (isModule && node.childNodes.length) {
        // 内联 module 必须搬进 ?html-proxy 虚拟模块，否则 Vite 无法对它做 import 解析与 HMR。
        addInlineModule(node, 'js')
      } else if (node.childNodes.length) {
        // 内联 classic script：不做模块化改写，只把 import('静态字面量') 里的 URL 改成
        // 浏览器可直接请求的路径；动态表达式无法静态判断，保持原样。
        const scriptNode = node.childNodes.at(
          -1,
        ) as DefaultTreeAdapterMap['textNode']
        for (const {
          url,
          start,
          end,
        } of extractImportExpressionFromClassicScript(scriptNode)) {
          const processedUrl = processNodeUrl(url, false, 'script')
          if (processedUrl !== url) {
            s.update(start, end, processedUrl)
          }
        }
      }
    }

    // style 属性只有含 url()/image-set() 时才需要处理：这些资源引用要交给 CSS 插件改写。
    const inlineStyle = findNeedTransformStyleAttribute(node)
    if (inlineStyle) {
      // 与内联模块共用索引计数器，保证 htmlProxyResult 的键不冲突。
      inlineModuleIndex++
      inlineStyles.push({
        index: inlineModuleIndex,
        location: inlineStyle.location!,
        code: inlineStyle.attr.value,
      })
    }

    // <style> 的文本先暂存，等遍历结束后统一跑 CSS 插件（异步），再覆盖回原位置。
    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      })
    }

    // elements with [href/src] attrs
    // 其它资源属性（img src/srcset、link href、video poster、source src 等）由
    // DEFAULT_HTML_ASSET_SOURCES 描述；html.additionalAssetSources 可以追加用户自定义规则。
    // 注意 `<link rel="stylesheet">` 也走这里：本文件只归一化 href 并登记 safeModulePaths，
    // 不会改成 ?html-proxy；它最终返回 CSS 还是 JS 包装，由 css 插件依据请求的
    // Accept: text/css（transformMiddleware 据此补 ?direct）决定。
    const assetAttributes = getNodeAssetAttributes(
      node,
      config.html?.additionalAssetSources,
    )
    for (const attr of assetAttributes) {
      if (attr.type === 'remove') {
        // 只有 vite-ignore 会产生 remove：它是 HTML 侧的私有标记，必须删掉。
        s.remove(attr.location.startOffset, attr.location.endOffset)
      } else {
        // srcset 要按候选列表处理；fetchDest 用来告诉后续加载权限检查「这个资源会被当什么加载」。
        const processedUrl = processNodeUrl(
          attr.value,
          attr.type === 'srcset',
          getHtmlAssetFetchDest(node.nodeName, attr.key, attr.attributes),
        )
        if (processedUrl !== attr.value) {
          overwriteAttrValue(s, attr.location, processedUrl)
        }
      }
    }
  })

  // 必须等所有路径登记完成再返回 HTML：浏览器拿到响应的瞬间就会并发请求这些资源，
  // 若登记还没写进 safeModulePaths，加载期访问检查可能先把它们判成越权路径。
  await Promise.all(safeModulePathRegistrations)

  // HTML 每次请求都重新生成，内联脚本内容可能已经变了，但 `?html-proxy&index=N.js` 这个 id 没变。
  // 不 invalidate 的话模块图会返回上一次的 transform 结果（HMR 时间戳也不会推进）。
  // invalidate the module so the newly cached contents will be served
  const clientModuleGraph = server?.environments.client.moduleGraph
  if (clientModuleGraph) {
    await Promise.all(
      inlineModuleUrls.map(async (url) => {
        const module = await clientModuleGraph._getUnresolvedUrlToModule(url)
        if (module) {
          clientModuleGraph.invalidateModule(module)
        }
      }),
    )
  }

  // 内联样式的异步转换：<style> 文本走 `?html-proxy&direct&index=N.css`，
  // style 属性走 `?html-proxy&inline-css&style-attr&index=N.css`。
  // 两条路径都必须先 ensureEntryFromUrl 建模块图节点，再调用 client 环境的 pluginContainer.transform，
  // 这样 CSS 预处理（sass/less）、postcss、CSS Modules 等插件才会生效。
  await Promise.all([
    ...styleUrl.map(async ({ start, end, code }, index) => {
      // direct 表示「要的是 CSS 文本，不要 JS 包装」（对应 css 插件的 isDirectCSSRequest 分支）。
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod =
        await server!.environments.client.moduleGraph.ensureEntryFromUrl(
          url,
          false,
        )

      const result =
        await server!.environments.client.pluginContainer.transform(
          code,
          mod.id!,
        )
      let content = ''
      if (result.map && 'version' in result.map) {
        if (result.map.mappings) {
          // 结果带 sourcemap 时把原文件内容塞进 sourcesContent，devtools 里才能看到源码。
          await injectSourcesContent(result.map, proxyModulePath, config.logger)
        }
        content = getCodeWithSourcemap('css', result.code, result.map)
      } else {
        content = result.code
      }
      // 覆盖 <style> 的文本区间，标签本身与其他属性保持不变。
      s.overwrite(start, end, content)
    }),
    ...inlineStyles.map(async ({ index, location, code }) => {
      // will transform with css plugin and cache result with css-post plugin
      // style 属性：css-post 插件会把转换结果写进 htmlProxyResult，键是 `${hash(mod.id)}_${index}`，
      // 这里按同样的键取回。取不到（例如插件链没产出）时用空串清空属性。
      const url = `${proxyModulePath}?html-proxy&inline-css&style-attr&index=${index}.css`

      const mod =
        await server!.environments.client.moduleGraph.ensureEntryFromUrl(
          url,
          false,
        )

      await server?.environments.client.pluginContainer.transform(code, mod.id!)

      const hash = getHash(cleanUrl(mod.id!))
      const result = htmlProxyResult.get(`${hash}_${index}`)
      overwriteAttrValue(s, location, result ?? '')
    }),
  ])

  html = s.toString()

  // @vite/client 用 head-prepend 注入：它必须早于页面里的 module script 执行，
  // 否则 import.meta.hot 还没建立，模块的自接受逻辑会失效。
  // 路径拼上 base 才是浏览器可请求的地址。
  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

// 作用：处理以 .html 结尾的请求——定位文件、做访问控制、dev 下跑 HTML 转换、最后写出响应。
// 调用点：
//   dev —— server/index.ts 的 createServer（`middlewares.use(indexHtmlMiddleware(root, server))`），
//          位于 htmlFallbackMiddleware 与 configureServer post 中间件之后；
//   preview —— preview.ts 的 preview()（`app.use(indexHtmlMiddleware(normalizedDistDir, server))`）。
// 关键参数：
//   root —— dev 下是 config.root，preview 下是产物目录（dist）；
//   server —— 用 isDevServer 区分 ViteDevServer / PreviewServer，两者的响应头、访问控制、是否转换都不同；
//   进入本中间件前会先经过 htmlFallbackMiddleware（dev 与 preview 都挂，且仅 appType 为 spa/mpa 时），
//   它负责把 /foo 补成 /foo.html 或 /index.html。
// 失败模式：文件不存在 → next() 交给后面的 notFoundMiddleware；
//           读取失败 / HTML hook 抛错 → next(e) 交给 errorMiddleware；越权 → 直接 403 结束响应。
export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer,
): Connect.NextHandleFunction {
  // 这两个判定在中间件创建时只算一次，避免每个请求重复读配置。
  // fullBundle 只有 dev + experimental.bundledDev 同时成立时才为真。
  const isDev = isDevServer(server)
  const fullBundle = isDev && server.environments.client.bundledDev

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    // 前面的中间件（典型是 configureServer 的 post hook）可能已经写完响应却又调了 next()，
    // 这里必须先检查，否则会对已结束的 res 再写一次。
    if (res.writableEnded) {
      return next()
    }

    // 去掉 query/hash 再做后缀判断：/index.html?foo=1 依然是 HTML 请求。
    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware appends '.html' to URLs
    // 这里必须再判一次 .html：htmlFallbackMiddleware 只负责「补后缀」，无论补没补成功都会 next()，
    // 所以到这里的 URL 不一定以 .html 结尾（例如 Accept 不含 text/html，或 mpa 下没有同名文件）。
    // 而且后缀是 .html 也不代表文件存在（可能被删或拼错），下面还要再确认一次。
    // sec-fetch-dest: script 说明浏览器把它当模块加载（例如 import './x.html?raw'），
    // 应放行给前面的 transformMiddleware 返回模块代码，而不是返回整页文档。
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      // bundledDev 分支：HTML 来自 rolldown 的内存产物，没有逐模块 transform，
      // 因此也不调用 transformIndexHtml，直接按内存产物自带的 etag 发送。
      if (fullBundle) {
        let pathname
        try {
          pathname = decodeURIComponent(url)
        } catch {
          // ignore malformed URI
          return next()
        }
        // memoryFiles 的键是去掉首个 '/' 的相对路径（与 rolldown 的输出文件名对齐）。
        const filePath = pathname.slice(1) // remove first /

        let file = fullBundle.memoryFiles.get(filePath)
        // 构建产物里没有这个 HTML：说明确实不存在（例如拼错路径），
        // 交给后面的 notFoundMiddleware，而不是拿 fallback 页顶替所有 URL。
        if (!file && fullBundle.hasBuildOutput) {
          return next()
        }
        // 只有文档类请求才允许拿「Bundling in progress」兜底页；
        // 子资源请求（script/style/fetch）拿到 HTML 只会更糟。
        const secFetchDest = req.headers['sec-fetch-dest']
        const isDocumentRequest = [
          'document',
          'iframe',
          'frame',
          'fencedframe',
          '',
          undefined,
        ].includes(secFetchDest)
        // 两种情况要重新生成兜底页：构建产物已过期（triggerBundleRegenerationIfStale 返回 true），
        // 或者内存里压根没有这个文件（初次构建尚未完成）。
        if (
          isDocumentRequest &&
          ((await fullBundle.triggerBundleRegenerationIfStale()) ||
            file === undefined)
        ) {
          file = { source: await generateFallbackHtml(server as ViteDevServer) }
        }
        // 非文档请求且没有文件 → 放行，让后续中间件决定 404。
        if (!file) {
          return next()
        }

        // memoryFiles 的 source 可能是字符串或 Uint8Array，统一成 send 能接受的类型。
        const html =
          typeof file.source === 'string'
            ? file.source
            : Buffer.from(file.source)
        const headers = server.config.server.headers
        // etag 直接复用产物自带的 etag：send() 用它和 If-None-Match 比较，命中就回 304。
        return send(req, res, html, 'html', { headers, etag: file.etag })
      }

      // 非 bundledDev 分支：把 URL 映射到磁盘。
      // dev 用 moduleUrlToFilePath（与 getHtmlFilename 同一套规则，保证 hook 里看到的 filename 一致）；
      // preview 是静态目录，直接 root + url 拼接，并用 normalizePath 统一分隔符。
      let filePath: string
      if (isDev) {
        filePath = moduleUrlToFilePath(decodeURIComponent(url), root)
      } else {
        filePath = normalizePath(
          path.resolve(path.join(root, decodeURIComponent(url))),
        )
      }

      if (isDev) {
        // dev 的访问控制走 client 环境的 server.fs.allow 规则，三态语义：
        //   allowed  —— 放行；
        //   denied   —— 文件存在但不在 allow 列表，返回 403（含 allow 列表提示）；
        //   fallback —— 文件不存在，可能是一个 API 路由，交给后面的中间件。
        const servingAccessResult = checkLoadingAccess(
          server.environments.client,
          filePath,
        )
        if (servingAccessResult === 'denied') {
          return respondWithAccessDenied(filePath, server, res)
        }
        if (servingAccessResult === 'fallback') {
          return next()
        }
        servingAccessResult satisfies 'allowed'
      } else {
        // `server.fs` options does not apply to the preview server.
        // But we should disallow serving files outside the output directory.
        // preview 不应用 server.fs（配置只约束 dev），但仍要禁止跳出产物目录，
        // 否则 /../ 之类的 URL 能读到 dist 之外的文件。
        if (!isParentDirectory(root, filePath)) {
          return next()
        }
      }

      // 最后的兜底确认：上面的 fallback 分支会放行不存在的文件，这里必须真正检查一次。
      if (fs.existsSync(filePath)) {
        // dev 与 preview 的响应头来自不同配置项，不能共用。
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers

        try {
          let html = await fsp.readFile(filePath, 'utf-8')
          if (isDev) {
            // dev 下 HTML 每次都要跑转换（注入 @vite/client、改写 URL）；
            // preview 返回的是构建产物，原样输出。
            // originalUrl 带上 base 与 query，作为 hook 内相对 URL 的解析基准。
            html = await server.transformIndexHtml(url, html, req.originalUrl)
          }
          // send() 默认 Cache-Control: no-cache 并按内容算弱 etag：
          // 不缓存响应体，但允许带 If-None-Match 的请求拿 304，避免重复传输整页 HTML。
          return send(req, res, html, 'html', { headers })
        } catch (e) {
          // 读取失败或任一 HTML hook 抛错都走这里：把错误交给 errorMiddleware
          // （渲染 overlay / 返回 500），不能吞掉当 404，否则用户看不到插件报错。
          return next(e)
        }
      }
    }
    // 不是 .html 请求（或 bundledDev 下没有对应文件）：放行。
    next()
  }
}

// 作用：把一个模块 URL 提前送进 transform 队列，减少浏览器首屏请求的等待。
// 调用点：本文件 devHtmlHook 内两处——processNodeUrl 的 module script 分支、addInlineModule 改写后。
// 关键参数：url 是 ModuleURL（不带 base）；server.config.server.preTransformRequests 关闭时直接返回。
// 失败模式：不返回 Promise，预热里的错误由 warmupRequest 自己记录日志（含 ERR_OUTDATED_OPTIMIZED_DEP 静默）。
/** Warm a decoded ModuleURL for a client-side HTML dependency. */
function preTransformRequest(server: ViteDevServer, url: string) {
  if (!server.config.server.preTransformRequests) return

  server.warmupRequest(url)
}

// 作用：bundledDev 首次构建尚未产出、或产物过期时，给文档请求返回的「打包中」页面。
// 调用点：本文件 indexHtmlMiddleware 的 fullBundle 分支。
// 关键点：内联完整的 HMR runtime，页面就绪后能自动 reload；页面用
//        `globalThis.__vite_is_fallback_page__` 标记自己，client 端据此只接收 ifFallback 的 full-reload。
// 失败模式：getHmrImplementation 依赖配置与插件，抛错会让请求 500。
async function generateFallbackHtml(server: ViteDevServer) {
  // 这个兜底页没有模块图，只能把 HMR runtime 整段内联，才能在产物就绪时收到 reload。
  const hmrRuntime = await getHmrImplementation(server.config)
  // The charset must be declared: the inlined HMR runtime contains non-ASCII
  // characters, and without it browsers may decode this page with a legacy
  // encoding (e.g. GBK), corrupting the inline module script below.
  // 模板里对 hmrRuntime 做的 replaceAll 是把 `</script>` 转义，
  // 否则 runtime 文本会提前闭合外层内联脚本，页面直接语法错误。
  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <script>globalThis.__vite_is_fallback_page__ = true</script>
  <script type="module">
    ${hmrRuntime.replaceAll('</script>', '<\\/script>')}
  </script>
  <style>
    :root {
      --page-bg: #ffffff;
      --text-color: #1d1d1f;
      --spinner-track: #f5f5f7;
      --spinner-accent: #0071e3;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: #1e1e1e;
        --text-color: #f5f5f5;
        --spinner-track: #424242;
      }
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      background-color: var(--page-bg);
      color: var(--text-color);
    }

    .container {
      margin: auto;
      padding: 2rem;
      text-align: center;
      border-radius: 1rem;
    }

    .spinner {
      width: 3rem;
      height: 3rem;
      margin: 2rem auto;
      border: 3px solid var(--spinner-track);
      border-top-color: var(--spinner-accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg) } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Bundling in progress</h1>
    <p>The page will automatically reload when ready.</p>
    <div class="spinner"></div>
  </div>
</body>
</html>
`
}
