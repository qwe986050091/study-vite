import fsp from 'node:fs/promises'
import colors from 'picocolors'
import type { ExistingRawSourceMap } from 'rolldown'
import type { Connect } from '#dep-types/connect'
import type { ViteDevServer } from '..'
import {
  ERR_OUTDATED_OPTIMIZED_DEP,
  NULL_BYTE_PLACEHOLDER,
} from '../../../shared/constants'
import { cleanUrl, unwrapId, withTrailingSlash } from '../../../shared/utils'
import {
  DEP_VERSION_RE,
  ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR,
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
} from '../../constants'
import { isDirectCSSRequest, isDirectRequest } from '../../plugins/css'
import { isHTMLProxy } from '../../plugins/html'
import {
  createDebugger,
  injectQuery,
  isCSSRequest,
  isImportRequest,
  isJSRequest,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
} from '../../utils'
import type { DevEnvironment } from '../environment'
import { moduleUrlToFilePath } from '../moduleUrl'
import { ERR_CLOSED_SERVER } from '../pluginContainer'
import { send } from '../send'
import { applySourcemapIgnoreList } from '../sourcemap'
import { ERR_DENIED_ID, ERR_LOAD_URL } from '../transformRequest'
import { checkLoadingAccess, respondWithAccessDenied } from './static'

// ============================================================================
// 文件角色：浏览器「模块请求」进入 Vite 的第一个真正处理者。

// 一条请求在这里被判定成三类之一：
//   1. sourcemap 请求（xxx.js.map）——直接读内存/磁盘，不跑 transform；
//   2. 静态/HTML 请求——next()，交给后面的 static / htmlFallback / indexHtml；
//   3. 模块请求（JS、CSS、?import、html proxy、worker、wasm）——交给
//      environment.transformRequest()，即 server/transformRequest.ts。

// 它之前的 cachedTransformMiddleware 只负责用 etag 回 304，不产出内容；
// 它之后的 serveStatic 只处理「不是模块」的文件。
// ============================================================================
const debugCache = createDebugger('vite:cache')

const knownIgnoreList = new Set(['/', '/favicon.ico'])

const documentFetchDests = new Set([
  // sec-fetch-dest 为 document/iframe/frame 的请求，说明浏览器要的是「文档」而不是模块。
  // SPA 里直接刷新 /src/main.ts 时浏览器会发 document 请求，此时绝不能被当成模块返回，
  // 否则 HTML 里会出现一段 JS 源码。
  'document',
  'iframe',
  'frame',
  'fencedframe',
])
function isDocumentFetchDest(fetchDest: string | undefined) {
  return fetchDest !== undefined && documentFetchDests.has(fetchDest)
}

export function isTransformRequest(url: string, fetchDest?: string): boolean {
  // 模块请求判定。注意接口约定：
  //   - 显式声明 fetchDest === 'script' 的一律是模块请求（<script src> 或动态 import）；
  //   - 不看 fetchDest 的兜底规则覆盖 CSS / ?import / html proxy —— 这些请求
  //     在 fetch 里可能没有 sec-fetch-dest（例如 JS 里 fetch 一个 CSS 文本）。
  // document 类请求优先级最高，先排除。
  return (
    !isDocumentFetchDest(fetchDest) &&
    (fetchDest === 'script' ||
      isJSRequest(url) ||
      isImportRequest(url) ||
      isCSSRequest(url) ||
      isHTMLProxy(url))
  )
}

// TODO: consolidate this regex pattern with the url, raw, and inline checks in plugins
const urlRE = /[?&]url\b/
const rawRE = /[?&]raw\b/
const inlineRE = /[?&]inline\b/
const svgRE = /\.svg\b/
const wasmRE = /(?<![?#].*)\.wasm$/
const wasmInstanceRE = /[?&]vite-wasm-instance(?:&|$)/

  // 「加载期文件访问」比「服务期文件访问」更严格：
  // 默认只检查少数危险形态（?raw/?url/?inline/svg/wasm），
  // 因为正常模块的访问控制在 serveStatic 那一层做；
  // fs.strict='extended' 时才对所有 id 都做检查。
  // 这两个检查点分别对应「读文件前」与「返回文件时」，后文 ERR_DENIED_ID 会再复用。
export function isServerAccessDeniedForTransform(
  environment: DevEnvironment,
  id: string,
): boolean {
  const { config } = environment
  if (
    config.server.fs.strict === 'extended' ||
    rawRE.test(id) ||
    urlRE.test(id) ||
    inlineRE.test(id) ||
    svgRE.test(id) ||
    wasmRE.test(id) ||
    wasmInstanceRE.test(id)
  ) {
    return (
      checkLoadingAccess(environment, cleanUrl(id)) !== 'allowed' ||
      checkLoadingAccess(environment, id) !== 'allowed'
    )
  }
  return false
}

/**
 * A middleware that short-circuits the middleware chain to serve cached transformed modules
 */
  // 缓存中间件：只处理 If-None-Match，命中就 304 结束，不产出任何内容。
  // 它比 transformMiddleware 早挂，是为了让「浏览器已有最新副本」的请求完全跳过解析。
  // 注意 304 必须同时满足三件事：etag 能反查到模块、模块当前 etag 相同、URL 完全一致
  // （同一 etag 可能对应多个 URL，比如带不同查询参数的同一文件）。
export function cachedTransformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteCachedTransformMiddleware(req, res, next) {
    const environment = server.environments.client

    if (isDocumentFetchDest(req.headers['sec-fetch-dest'])) {
      // 文档请求不参与 etag 快路径：HTML 的响应依赖 Vary: Sec-Fetch-Dest，
      // 同一个 URL 在 document 与 script 两种语义下内容不同，缓存必须分开。
      res.appendHeader('Vary', 'Sec-Fetch-Dest')
      return next()
    }

    // check if we can return 304 early
    const ifNoneMatch = req.headers['if-none-match']
    // 请求带 If-None-Match：拿它当 key 反查 moduleGraph 的 etagToModuleMap。
    if (ifNoneMatch) {
      const moduleByEtag = environment.moduleGraph.getModuleByEtag(ifNoneMatch)
      if (
        moduleByEtag?.transformResult?.etag === ifNoneMatch &&
        moduleByEtag.url === req.url
      ) {
        // For CSS requests, if the same CSS file is imported in a module,
        // the browser sends the request for the direct CSS request with the etag
        // from the imported CSS module. We ignore the etag in this case.
        const maybeMixedEtag = isCSSRequest(req.url!)
        // CSS 的 etag 不能在这里判定：同一个 CSS 文件可能既被 JS import（模块身份），
        // 又被 <link> 直接请求（资源身份），两者的 etag 来源不同，混用会 304 出错误内容。
        // 直接请求的 CSS 在下面 transformMiddleware 里单独判。
        if (!maybeMixedEtag) {
          debugCache?.(`[304] ${prettifyUrl(req.url!, server.config.root)}`)
          res.statusCode = 304
          return res.end()
        }
      }
    }

    next()
  }
}

  // 主 transform 中间件。整体是「判定 → 规范化 URL → 交给 environment.transformRequest → 按类型回包」，
  // 异常分支承担了协议职责：不同错误码决定浏览器该重试、该刷新还是该报错。
export function transformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`

  // check if public dir is inside root dir
  const { root, publicDir } = server.config
  // public 目录可能位于 root 之外（vite 允许），这里预先算出两种路径形态：
  // publicDirInRoot 决定要不要检查「URL 误用了 public 前缀」，publicPath 是提示文案用的。
  const publicDirInRoot = publicDir.startsWith(withTrailingSlash(root))
  const publicPath = `${publicDir.slice(root.length)}/`

  return async function viteTransformMiddleware(req, res, next) {
    const environment = server.environments.client

      // 只处理 GET/HEAD；/ 与 /favicon.ico 直接放行（前者交给 indexHtml，后者多数项目没有）。
      // document 类请求也放行：它们是 HTML 入口，不是模块。
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      knownIgnoreList.has(req.url!) ||
      isDocumentFetchDest(req.headers['sec-fetch-dest'])
    ) {
      return next()
    }

    let url: string
    try {
        // 解码 URL 并把占位符换回 \0。
        // \0 直接出现在 HTTP URL 里会被某些代理/浏览器吞掉，所以 importAnalysis 用
        // NULL_BYTE_PLACEHOLDER 编码虚拟模块 id，在这里还原。
        // 解码失败说明 URL 本身畸形（非法百分号编码），只告警并放行，不让整个 server 500。
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0',
      )
    } catch (e) {
      if (e instanceof URIError) {
        server.config.logger.warn(
          colors.yellow(
            `Malformed URI sequence in request URL: ${removeTimestampQuery(req.url!)}`,
          ),
        )
        return next()
      }
      return next(e)
    }

    const withoutQuery = cleanUrl(url)

    try {
      const isSourceMap = withoutQuery.endsWith('.map')
      // ---- sourcemap 请求 ----
      // 浏览器开发者工具会根据 sourceMappingURL 拉 xxx.js.map，这些请求不该进 transform 管线。
      // 两类来源分开处理：优化过的依赖（预构建产物目录里的 .map 文件）与普通模块（内存里的 map）。
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const depsOptimizer = environment.depsOptimizer
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          // 优化依赖的 map 是预构建时落盘的真实文件，直接读。
          // 但 URL 里可能有 ../，所以先用 isOptimizedDepFile 确认最终路径仍在 deps 目录内，
          // 防止路径穿越读到任意文件。
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const sourcemapPath = moduleUrlToFilePath(
            withoutQuery,
            server.config.root,
          )
          // url may contain relative path that may resolve outside of the optimized deps directory
          if (!depsOptimizer.isOptimizedDepFile(sourcemapPath)) {
            return next()
          }
          try {
            const map = JSON.parse(
              await fsp.readFile(sourcemapPath, 'utf-8'),
            ) as ExistingRawSourceMap

            applySourcemapIgnoreList(
              map,
              sourcemapPath,
              server.config.server.sourcemapIgnoreList,
              server.config.logger,
            )

            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } catch {
            // Outdated source map request for optimized deps, this isn't an error
            // 读不到 map 不是错误：重新预构建后旧的 map 请求必然失效。
            // 回一个空 map，避免浏览器控制台刷 "Could not load content" 警告。
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            const dummySourceMap = {
              version: 3,
              file: sourcemapPath.replace(/\.map$/, ''),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ';;;;;;;;;',
            }
            return send(req, res, JSON.stringify(dummySourceMap), 'json', {
              cacheControl: 'no-cache',
              headers: server.config.server.headers,
            })
          }
        } else {
          // 普通模块的 map 存在 moduleGraph 的 transformResult 里（transform 时算出的合并 map）。
          // 找不到就放行，让后续中间件按静态文件处理。
          const originalUrl = url.replace(/\.map($|\?)/, '$1')
          const map = (
            await environment.moduleGraph.getModuleByUrl(originalUrl)
          )?.transformResult?.map
          if (map) {
            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } else {
            return next()
          }
        }
      }

      if (publicDirInRoot && url.startsWith(publicPath)) {
        warnAboutExplicitPublicPathInUrl(url)
      }

      if (isTransformRequest(url, req.headers['sec-fetch-dest'])) {
        // ---- 模块请求主路径 ----
        // strip ?import
        url = removeImportQuery(url)
        // ?import 是 importAnalysis 给「非 JS 资源被 JS import」加的标记，
        // 用来区分「<link> 直接请求 CSS」与「JS 里 import 了 CSS」。转发给插件前先剥掉。
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        url = unwrapId(url)
        // /@id/ 前缀用于把「不是合法浏览器说明符」的 id（绝对路径、虚拟模块、带特殊字符）
        // 塞进 URL。这里还原成插件认识的 id。

        // for CSS, we differentiate between normal CSS requests and imports
        if (isCSSRequest(url)) {
          // CSS 的两种身份：
          //   - <link rel=stylesheet> 直接请求：Accept 含 text/css，无需 ?direct；
          //   - JS import 触发的 CSS 请求：加 ?direct，让 css 插件走「直接返回 CSS 文本」而不是注入 HMR 代码。
          // 这个 query 是 css 插件与中间件之间的约定。
          if (
            req.headers.accept?.includes('text/css') &&
            !isDirectRequest(url)
          ) {
            url = injectQuery(url, 'direct')
          }

          // check if we can return 304 early for CSS requests. These aren't handled
          // CSS 的 304 判定只能在这里做（缓存中间件排除了 CSS）。
          // 注意这里按 URL（含 ?direct）查模块，保证两种身份各自的 etag 不串。
          // by the cachedTransformMiddleware due to the browser possibly mixing the
          // etags of direct and imported CSS
          const ifNoneMatch = req.headers['if-none-match']
          if (
            ifNoneMatch &&
            (await environment.moduleGraph.getModuleByUrl(url))?.transformResult
              ?.etag === ifNoneMatch
          ) {
            debugCache?.(`[304] ${prettifyUrl(url, server.config.root)}`)
            res.statusCode = 304
            return res.end()
          }
        }

        // resolve, load and transform using the plugin container
        // 交给 environment（默认 client）的 transformRequest。
        // 返回值 null 表示「插件没声明处理这个 URL」，继续往下走静态文件链。
        const result = await environment.transformRequest(url)
        if (result) {
          const depsOptimizer = environment.depsOptimizer
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          // 直接请求的 CSS 以 text/css 返回，其余都按 JS 返回。
          // 依赖产物用长缓存：URL 里带 ?v=hash，内容变化时 URL 一定变，可以 immutable。
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url)
          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            headers: server.config.server.headers,
            map: result.map,
          })
        }
      }
    } catch (e) {
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        // ---- 错误码 → HTTP 语义 ----
        // 504 是 Vite 的约定：告诉浏览器「这个请求已经过期/依赖正在重建」，
        // 客户端收到后通常由注入的 HMR 客户端触发整页刷新，而不是把错误渲染给用户。
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Optimize Deps Processing Error'
          res.end()
        }
        // This timeout is unexpected
        server.config.logger.error(e.message)
        return
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        // 依赖预构建发现新依赖后会整体重打包，旧 URL 里的 hash 失效。
        // 这不是错误，属于正常的 missing-dep 流程，因此不打日志。
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Optimize Dep'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_CLOSED_SERVER) {
        // server 正在 restart/close：当前请求已经不可能被正确满足，回 504。
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Request'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR) {
        // 预构建产物目录里确实没有这个文件（依赖被移除或构建中断），回 404 并告警。
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 404
          res.end()
        }
        server.config.logger.warn(colors.yellow(e.message))
        return
      }
      if (e?.code === ERR_LOAD_URL) {
        // 插件没有 load 出内容：交给后面的 static / htmlFallback 处理。
        // 这是「一条 URL 既可能是模块也可能是静态文件」的兜底分叉点。
        // Let other middleware handle if we can't load the url via transformRequest
        return next()
      }
      if (e?.code === ERR_DENIED_ID) {
        // 加载期被判定为越权访问：这里再做一次「服务期」判定，
        // 因为两个检查点的 allow/deny 规则不完全相同（?raw 等形态会被更严格地拦）。
        // 'fallback' 表示放宽到静态文件层再判一次，于是 next()。
        const id: string = e.id
        let servingAccessResult = checkLoadingAccess(environment, cleanUrl(id))
        if (servingAccessResult === 'allowed') {
          servingAccessResult = checkLoadingAccess(environment, id)
        }
        if (servingAccessResult === 'denied') {
          respondWithAccessDenied(id, server, res)
          return true
        }
        if (servingAccessResult === 'fallback') {
          next()
          return true
        }
        servingAccessResult satisfies 'allowed'
        throw new Error(`Unexpected access result for id ${id}`)
      }
      return next(e)
    }

    next()
  }

  function warnAboutExplicitPublicPathInUrl(url: string) {
    // public 目录里的文件约定只能通过根路径引用，不能 import。
    // 这里只做提示（不改变行为），因为路径确实能取到内容，硬拦会破坏存量项目。
    let warning: string

    if (isImportRequest(url)) {
      const rawUrl = removeImportQuery(url)
      if (urlRE.test(url)) {
        warning =
          `Assets in the public directory are served at the root path.\n` +
          `Instead of ${colors.cyan(rawUrl)}, use ${colors.cyan(
            rawUrl.replace(publicPath, '/'),
          )}.`
      } else {
        warning =
          'Assets in public directory cannot be imported from JavaScript.\n' +
          `If you intend to import that asset, put the file in the src directory, and use ${colors.cyan(
            rawUrl.replace(publicPath, '/src/'),
          )} instead of ${colors.cyan(rawUrl)}.\n` +
          `If you intend to use the URL of that asset, use ${colors.cyan(
            injectQuery(rawUrl.replace(publicPath, '/'), 'url'),
          )}.`
      }
    } else {
      warning =
        `Files in the public directory are served at the root path.\n` +
        `Instead of ${colors.cyan(url)}, use ${colors.cyan(
          url.replace(publicPath, '/'),
        )}.`
    }

    server.config.logger.warn(colors.yellow(warning))
  }
}
