/*
 * 文件角色（build 阶段的 import 改写 + preload 注入）：
 * - 上游：build.ts 的 resolveBuildPlugins() 把它放进 post 段（只在 isBuild 时），随 environment.plugins 交给 rolldown。
 * - 与 dev 的区别：dev 阶段由 plugins/importAnalysis.ts 在每次请求时改写 specifier（/@fs、/@id、?t= 时间戳）；
 *   build 阶段的 specifier 已经是 rolldown 生成的最终 chunk 文件名，这里只做三件事：
 *   1) 把 __VITE_IS_MODERN__ 占位符替换成 true/false；
 *   2) 把 __VITE_PRELOAD__ 换成 __vite__mapDeps([...]) 依赖下标；
 *   3) 在产物顶部注入 __vite__mapDeps 与 preload 辅助函数代码。
 * - 占位符谁产生：rolldown 在 viteMode 下于动态 import 处包出 __vitePreload(factory, __VITE_PRELOAD__)；
 *   谁消费：本文件 generateBundle 用 es-module-lexer 重新解析产物，定位每个动态 import 及其 marker。
 * - 关键不变量：marker 与动态 import 的配对必须按嵌套顺序用栈匹配（见 matchImportsToPreloadMarkers），
 *   否则 import('a').then(() => import('b')) 会把 b 的 CSS 错配给 a。
 * - 易误解点：这里不是「rollup 的打包后处理」，而是 rolldown 插件容器里的 generateBundle；返回的第二个插件
 *   （native:import-analysis-build）把主工作交给 rolldown 原生实现，JS 侧只在 chunkImportMap 等场景兜底。
 */
import path from 'node:path'
import type { DecodedSourceMap, RawSourceMap } from '@jridgewell/remapping'
import convertSourceMap from 'convert-source-map'
import type { DynamicImport } from 'es-module-lexer'
import { init, parse as parseImports } from 'es-module-lexer'
import MagicString from 'magic-string'
import type { RenderedChunk, SourceMap } from 'rolldown'
import { viteBuildImportAnalysisPlugin as nativeBuildImportAnalysisPlugin } from 'rolldown/experimental'
import { cleanUrl } from '../../shared/utils'
import type { PartialEnvironment } from '../baseEnvironment'
import { toOutputFilePathInJS } from '../build'
import type { ResolvedConfig } from '../config'
import { perEnvironmentState } from '../environment'
import { type Plugin, perEnvironmentPlugin } from '../plugin'
import { genSourceMapUrl } from '../server/sourcemap'
import {
  combineSourcemaps,
  generateCodeFrame,
  getFileStartIndex,
  normalizePath,
  numberToPos,
} from '../utils'
import { removedPureCssFilesCache } from './css'
import { getImportMap, getImportMapFilename } from './html'

type FileDep = {
  url: string
  runtime: boolean
}

type VitePreloadErrorEvent = Event & { payload: Error }

type ChunkImportMapKeyChunk = Pick<
  RenderedChunk,
  'facadeModuleId' | 'fileName' | 'moduleIds' | 'name'
>

/**
 * Keep signature selection aligned with Rolldown's import-map key selection so
 * changes to preload keys are reflected in chunk hashes.
 * https://github.com/rolldown/rolldown/blob/main/crates/rolldown_plugin_chunk_import_map/src/lib.rs#L39-L66
 * @internal
 */
/**
 * 作用：为每个带 hash 的 chunk 生成「稳定签名」，用于 chunkImportMap 模式下参与 augmentChunkHash。
 * 调用点：本文件 buildImportAnalysisPlugin 的 augmentChunkHash hook。
 * 关键参数：chunks 是本轮完整的 bundle；cwd 影响绝对路径转相对路径的结果（必须与 rolldown 一致）。
 * 失败模式：不抛；签名只用于 hash 计算，不影响产物内容。
 * 规则必须与 rolldown 的 chunk_import_map 保持一致，否则 hash 与 importmap key 会错位。
 */
export function getChunkImportMapKeySignatures(
  chunks: Record<string, ChunkImportMapKeyChunk>,
  cwd: string,
): Map<string, string> {
  // 绝对路径会随机器变化，必须转成相对 cwd 的形式，否则同一份源码在不同机器上 hash 不同。
  const toStableId = (id: string): [boolean, string] =>
    path.isAbsolute(id)
      ? [true, normalizePath(path.relative(cwd, id))]
      : [false, id]
  // 排序规则与 rolldown 完全一致：相对路径优先，再按字典序——用来在多 module 的 chunk 里挑「最小值」。
  const isSmaller = (
    [aIsPath, a]: [boolean, string],
    [bIsPath, b]: [boolean, string],
  ) => (aIsPath !== bIsPath ? !aIsPath : a < b)
  const signatures = new Map<string, string>()
  // usedNames 记录「已被哪个 chunk 占用的 name」：同名 chunk 只有第一个能按 name 生成 key，后续必须退回 module 维度。
  const usedNames = new Set<string>()
  for (const [fileName, chunk] of Object.entries(chunks)) {
    // Rolldown only assigns import-map keys to hashed chunks. Unhashed chunks
    // also do not reserve their name for a later same-named hashed chunk.
    // `!~{` 是 rolldown 尚未替换的 hash 占位符：只有这类 chunk 才会进 importmap。
    if (!chunk.fileName.includes('!~{')) {
      signatures.set(fileName, JSON.stringify(['file', fileName]))
    } else if (chunk.facadeModuleId != null) {
      signatures.set(
        fileName,
        JSON.stringify(['facade', ...toStableId(chunk.facadeModuleId)]),
      )
    } else if (!usedNames.has(chunk.name)) {
      usedNames.add(chunk.name)
      signatures.set(fileName, JSON.stringify(['name', chunk.name]))
    } else {
      // 同名 chunk（无 facadeModuleId）：取所有 module id 里「最小」的那个作为稳定签名，避免受模块顺序影响。
      let moduleId: [boolean, string] | undefined
      for (const id of chunk.moduleIds) {
        const stableId = toStableId(id)
        if (moduleId === undefined || isSmaller(stableId, moduleId)) {
          moduleId = stableId
        }
      }
      if (moduleId !== undefined) {
        signatures.set(fileName, JSON.stringify(['module', ...moduleId]))
      } else {
        // Rolldown leaves duplicate-named chunks without module IDs unmapped.
        signatures.set(fileName, JSON.stringify(['file', fileName]))
      }
    }
  }
  return signatures
}

type PreloadDependency = {
  fileName: string
  js?: string
  imports?: readonly string[]
  css?: Iterable<string>
}

function collectPreloadDependencies(
  fileName: string,
  ownerFileName: string,
  getDependency: (fileName: string) => PreloadDependency | undefined,
): string[] {
  // visited 里预置 owner：避免 importer 自己出现在自己的 preload 列表里（首尾成环）。
  // 返回顺序 = 深度优先 + 依赖先于自身，保证 CSS 层叠顺序：被依赖的 chunk 样式先加载。
  const visited = new Set([ownerFileName])
  const dependencies: string[] = []
  const visit = (fileName: string) => {
    const dependency = getDependency(fileName)
    if (!dependency || visited.has(dependency.fileName)) return
    visited.add(dependency.fileName)
    const { js, imports = [], css = [] } = dependency
    // 先 JS，再递归 imports，最后本 chunk 的 CSS：保证深层依赖先入表，本 chunk 样式最后生效。
    if (js !== undefined) {
      dependencies.push(js)
    }
    imports.forEach(visit)
    // Keep this chunk's CSS after its dependencies so its styles take precedence.
    for (const file of css) {
      dependencies.push(file)
    }
  }
  visit(fileName)
  return dependencies
}

/**
 * A flag for injected helpers. This flag will be set to `false` if the output
 * target is not native es - so that injected helper logic can be conditionally
 * dropped.
 */
export const isModernFlag = `__VITE_IS_MODERN__`
// 下面是注入到产物里的全局名：preloadMethod 是运行时函数名，preloadMarker 是待替换的占位符。
// 这三个名字属于构建产物的公开契约，插件生态会按字符串匹配它们，不能随意改。
export const preloadMethod = `__vitePreload`
export const preloadMarker = `__VITE_PRELOAD__`

// 虚拟模块 id：preload 辅助函数以 `\0vite/preload-helper.js` 的形式被解析（\0 表示虚拟模块，不落盘）。
export const preloadHelperId = '\0vite/preload-helper.js'
// 允许后面跟 32 位 hash 后缀：rolldown 可能对 marker 做内容寻址命名。
const preloadMarkerRE = /__VITE_PRELOAD__(?:[\da-f]{32})?/g

// 作用：判断 preload 目标是不是 CSS —— CSS 用 <link rel=stylesheet>，JS 用 modulepreload/preload。
// 调用点：本文件 preload() 运行时（被 toString 注入产物）。
export function isCssPreloadUrl(url: URL): boolean {
  return url.pathname.endsWith('.css')
}

// 作用：计算产物内两个文件之间的 POSIX 相对路径，并保证以 './' 开头（裸文件名会被当成模块 specifier）。
// 调用点：本文件 generateBundle 中 isRelativeBase / renderBuiltUrl 两个分支。
// 失败模式：无；importer 与 filename 同目录时会得到 './name.js'。
function toRelativePath(filename: string, importer: string) {
  const relPath = path.posix.relative(path.posix.dirname(importer), filename)
  return relPath[0] === '.' ? relPath : `./${relPath}`
}

// 作用：从 pos 开始查找下一个 __VITE_PRELOAD__ marker（用带 g 的正则，需手动重置 lastIndex）。
// 调用点：本文件 matchImportsToPreloadMarkers 与 generateBundle。
// 失败模式：找不到返回 null；调用方必须判空。
export function findPreloadMarker(
  str: string,
  pos: number = 0,
): RegExpExecArray | null {
  preloadMarkerRE.lastIndex = pos
  return preloadMarkerRE.exec(str)
}

/**
 * Pairs each dynamic `import()` with the `__VITE_PRELOAD__` marker that belongs to it.
 *
 * Each import is wrapped as `__vitePreload(factory, __VITE_PRELOAD__)`, so its marker
 * comes right after it. Nested imports nest the wrappers, so the imports and markers
 * form balanced brackets. For example, in `import('a').then(() => import('b'))`, b's
 * marker ends up before a's. Pairing each import with the next marker would give b's
 * marker to both imports and drop a's CSS to `void 0` (#22700). Instead the markers are
 * matched with a stack in one pass, and each marker closes the innermost import that is
 * still open.
 *
 * The returned array is parallel to `imports`. Entry `i` holds the start position of
 * import `i`'s marker, or -1 when the import has no marker.
 */
export function matchImportsToPreloadMarkers(
  code: string,
  imports: readonly DynamicImport[],
): number[] {
  // 算法：按 code 顺序扫 marker，同时把「已经结束、但还没配上 marker」的 import 压栈；
  // 每遇到一个 marker 就弹栈顶——即最内层仍未闭合的 import 拿走这个 marker。
  const importMarkerPos = Array.from<number>({ length: imports.length }).fill(
    -1,
  )
  if (imports.length === 0) return importMarkerPos

  const openImports: number[] = []
  let nextImport = 0
  for (
    let marker = findPreloadMarker(code, imports[0].end);
    marker;
    marker = findPreloadMarker(code, marker.index + marker[0].length)
  ) {
    const markerStartPos = marker.index
    while (
      nextImport < imports.length &&
      imports[nextImport].end <= markerStartPos
    ) {
      openImports.push(nextImport++)
    }
    if (openImports.length) {
      importMarkerPos[openImports.pop()!] = markerStartPos
    }
  }
  // #3051: a lone import whose marker isn't placed after it pairs with the only marker
  // 兜底：只有一个 import 且没配上时，直接取全文第一个 marker（兼容旧版代码形态）。
  if (imports.length === 1 && importMarkerPos[0] === -1) {
    importMarkerPos[0] = findPreloadMarker(code)?.index ?? -1
  }

  return importMarkerPos
}

/**
 * Helper for preloading CSS and direct imports of async chunks in parallel to
 * the async chunk itself.
 */

// 作用：探测浏览器是否支持 modulepreload，不支持则退回普通 preload。
// 调用点：本文件 getPreloadCode（会被 toString 成字符串注入产物）。
// 注意：这个函数体最终也会被序列化进产物，不能引用模块作用域的变量。
function detectScriptRel() {
  const relList =
    typeof document !== 'undefined' && document.createElement('link').relList
  return relList && relList.supports && relList.supports('modulepreload')
    ? 'modulepreload'
    : 'preload'
}

type PreloadSeen = Record<string, Promise<unknown> | undefined>

// 作用：同一 href 的 preload 只发起一次——把 Promise 缓存进 seen，避免并行动态 import 重复插 <link>。
// 调用点：本文件 preload() 运行时；preloadOnce 自身也会被序列化进产物。
// 失败模式：resolve 后把缓存置回 undefined（允许后续重新 preload），reject 时删除缓存并继续抛。
export function preloadOnce(
  seen: PreloadSeen,
  href: string,
  preload: () => Promise<unknown> | undefined,
): Promise<unknown> | undefined {
  // 命中缓存直接返回同一个 Promise：并发的多个动态 import 不会重复插入 <link>。
  if (href in seen) return seen[href]

  const promise = preload()
  if (!promise) {
    seen[href] = undefined
    return
  }

  const preloadPromise = promise.then(
    () => {
      seen[href] = undefined
    },
    (err) => {
      delete seen[href]
      throw err
    },
  )
  seen[href] = preloadPromise
  return preloadPromise
}

declare const scriptRel: string
declare const seen: PreloadSeen
declare const failedCssLinks: Record<string, HTMLLinkElement | undefined>
// 作用：产物运行时的 __vitePreload —— 先并行 preload 依赖（CSS/直接 import 的 chunk），再执行真正的动态 import。
// 调用点：rolldown 在产物中生成 __vitePreload(() => import(...), __vite__mapDeps([...]))。
// 关键约束：这个函数会被 preload.toString() 序列化后注入产物，函数体内不能引用本模块的外部变量；
//   它只能使用 getPreloadCode 里声明的 scriptRel / seen / failedCssLinks / assetsURL 等注入常量。
// 失败模式：依赖 preload 失败或基础模块加载失败时，派发可取消的 vite:preloadError 事件；未被 preventDefault 则重新抛出。
function preload(
  baseModule: () => Promise<unknown>,
  deps?: string[],
  importerUrl?: string,
) {
  let promise: Promise<PromiseSettledResult<unknown>[] | void> =
    Promise.resolve()
  // @ts-expect-error __VITE_IS_MODERN__ will be replaced with boolean later
  // 非 modern 产物（legacy）里 __VITE_IS_MODERN__ 被替换成 false，整段 preload 逻辑随之被裁剪掉。
  if (__VITE_IS_MODERN__ && deps && deps.length > 0) {
    let preloadedHrefs: { all: Set<string>; styles: Set<string> } | undefined
    const cspNonceMeta = document.querySelector<HTMLMetaElement>(
      'meta[property=csp-nonce]',
    )
    // `.nonce` should be used to get along with nonce hiding (https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/nonce#accessing_nonces_and_nonce_hiding)
    // Firefox 67-74 uses modern chunks and supports CSP nonce, but does not support `.nonce`
    // in that case fallback to getAttribute
    const cspNonce = cspNonceMeta?.nonce || cspNonceMeta?.getAttribute('nonce')

    // Promise.allSettled is not supported by Chrome 64-75, Firefox 67-70, Safari 11.1-12.1
    function allSettled<T>(
      promises: Array<T | PromiseLike<T>>,
    ): Promise<PromiseSettledResult<T>[]> {
      return Promise.all(
        promises.map((p) =>
          Promise.resolve(p).then(
            (value: T) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          ),
        ),
      )
    }

    function importMetaResolve(specifier: string): URL {
      // @ts-expect-error import.meta.resolve is not supported by all browsers we support
      // But `import.meta.resolve` is only needed when build.chunkImportMap is enabled,
      // and that option requires `import.meta.resolve` support.
      // chunkImportMap:true 时 specifier 是 importmap 里的裸键，必须靠 import.meta.resolve 解析成真实 URL。
      if (import.meta.resolve) {
        return new URL(import.meta.resolve(specifier))
      }
      return new URL(specifier, /** #__KEEP__ */ import.meta.url)
    }

    promise = allSettled(
      deps
        .map((depString) => {
          // @ts-expect-error assetsURL is declared before preload.toString()
          // assetsURL 是注入的常量函数：base 为绝对路径时补 base 前缀，相对 base 时用 importerUrl 还原。
          depString = assetsURL(depString, importerUrl)
          const dep = importMetaResolve(depString)
          const isCss = isCssPreloadUrl(dep)

          return preloadOnce(seen, dep.href, () => {
            // 首次调用时懒扫描页面已有的 <link>：SSR 直出的 HTML 可能已经预加载过这些资源，避免重复插入。
            if (preloadedHrefs === undefined) {
              preloadedHrefs = { all: new Set(), styles: new Set() }
              const links = document.getElementsByTagName('link')
              for (let i = links.length - 1; i >= 0; i--) {
                const link = links[i]
                // The `links[i].href` is an absolute URL thanks to browser doing the work
                // for us. See https://html.spec.whatwg.org/multipage/common-dom-interfaces.html#reflecting-content-attributes-in-idl-attributes:idl-domstring-5
                preloadedHrefs.all.add(link.href)
                if (link.rel === 'stylesheet') {
                  preloadedHrefs.styles.add(link.href)
                }
              }
            }

            // check if the file is already preloaded by SSR markup
            // `importMetaResolve` converts `dep` to an absolute URL
            // 已存在且没失败过就直接跳过；失败过的 CSS link 需要重新插入（failedCssLink 优先于已预加载判断）。
            const preloadedHrefSet = isCss
              ? preloadedHrefs.styles
              : preloadedHrefs.all
            const failedCssLink = isCss ? failedCssLinks[dep.href] : undefined
            if (!failedCssLink && preloadedHrefSet.has(dep.href)) {
              return
            }

            const link = document.createElement('link')
            // CSS 用 stylesheet（会阻塞渲染、保证样式先于脚本）；JS 用 modulepreload 或 preload+as=script。
            link.rel = isCss ? 'stylesheet' : scriptRel
            if (!isCss) {
              link.as = 'script'
            }
            link.crossOrigin = ''
            link.href = dep.href
            if (cspNonce) {
              link.setAttribute('nonce', cspNonce)
            }
            if (failedCssLink) {
              delete failedCssLinks[dep.href]
            }
            if (failedCssLink?.isConnected) {
              failedCssLink.replaceWith(link)
            } else {
              document.head.appendChild(link)
            }
            if (isCss) {
              // CSS 必须等 load 事件才算 preload 完成（JS 的 modulepreload 无需等待也可由浏览器保证顺序）。
              // 同时监听 error：把失败的 link 记进 failedCssLinks，下次动态 import 时替换重试。
              return new Promise((res, rej) => {
                const handleSettle = (e: Event) => {
                  link.removeEventListener('load', handleSettle)
                  link.removeEventListener('error', handleSettle)
                  if (e.type === 'error') {
                    failedCssLinks[dep.href] = link
                    rej(new Error(`Unable to preload CSS for ${dep}`))
                  } else {
                    res(e)
                  }
                }
                link.addEventListener('load', handleSettle)
                link.addEventListener('error', handleSettle)
              })
            }
          })
        })
        // skip undefined to be converted to Promise.resolve for performance
        .filter((p) => p !== undefined),
    )
  }

  function handlePreloadError(err: Error) {
    // 抛出前先派发可取消事件：应用可以监听 vite:preloadError 做「版本已更新，自动刷新」之类的兜底。
    // 只有在没人 preventDefault 时才真正抛错（避免把可控的加载失败变成未捕获异常）。
    const e = new Event('vite:preloadError', {
      cancelable: true,
    }) as VitePreloadErrorEvent
    e.payload = err
    window.dispatchEvent(e)
    if (!e.defaultPrevented) {
      throw err
    }
  }

  return promise.then((res) => {
    // 先用 allSettled 收集依赖结果：某个 preload 失败不应阻止后续依赖继续加载，但最终要报错。
    for (const item of res || []) {
      if (item.status !== 'rejected') continue
      handlePreloadError(item.reason)
    }
    return baseModule().catch(handlePreloadError)
  })
}

/**
 * 作用：拼出注入产物的 preload 辅助代码字符串（scriptRel/assetsURL/seen/failedCssLinks + 三个函数）。
 * 调用点：本文件 buildImportAnalysisPlugin 的 perEnvironmentPlugin('native:import-analysis-build') 分支。
 * 关键参数：renderBuiltUrlBoolean / isRelativeBase 决定 deps 是「相对当前 chunk」还是「相对 outDir + base」。
 * 失败模式：不抛；但 preload/preloadOnce/isCssPreloadUrl 一旦引用外部变量，产物会在运行时 ReferenceError。
 */
function getPreloadCode(
  environment: PartialEnvironment,
  renderBuiltUrlBoolean: boolean,
  isRelativeBase: boolean,
) {
  const { modulePreload } = environment.config.build

  const scriptRel =
    // modulePreload.polyfill 打开时直接写死 'modulepreload'（此时页面已注入 polyfill）；
    // 关闭时必须运行时探测（detectScriptRel 会被序列化成表达式内联进产物）。
    modulePreload && modulePreload.polyfill
      ? `'modulepreload'`
      : `/* @__PURE__ */ (${detectScriptRel.toString()})()`

  // There are two different cases for the preload list format in __vitePreload
  // 第一种形态：依赖数组直接内联在调用处（旧格式）。
  // __vitePreload(() => import(asyncChunk), [ ...deps... ])
  // 第二种形态：依赖改为 __vite__mapDeps([...]) 的下标表（当前格式）。
  // This is maintained to keep backwards compatibility as some users developed plugins
  // using regex over this list to workaround the fact that module preload wasn't
  // configurable.
  // 分支一：相对 base 或 renderBuiltUrl —— deps 相对当前 chunk，运行时用 importerUrl 解析。
  // 分支二：绝对 base —— deps 只含 outDir 内路径，base 前缀由运行时一次性拼上。
  const assetsURL =
    renderBuiltUrlBoolean || isRelativeBase
      ? // If `experimental.renderBuiltUrl` is used, the dependencies might be relative to the current chunk.
        // If relative base is used, the dependencies are relative to the current chunk.
        // The importerUrl is passed as third parameter to __vitePreload in this case
        `function(dep, importerUrl) { return new URL(dep, importerUrl).href }`
      : // If the base isn't relative, then the deps are relative to the projects `outDir` and the base
        // is appended inside __vitePreload too.
        `function(dep) { return ${JSON.stringify(environment.config.base)}+dep }`
  // replace `import` as a workaround for stackblitz: https://stackblitz.com/edit/node-vqfvv8dy?file=index.js
  // StackBlitz 的转换器会误处理函数源码里的 import 关键字，这里把全角占位符还原回普通 import。
  const preloadMethodCode = preload.toString().replaceAll('𝐢𝐦𝐩𝐨𝐫𝐭', 'import')
  // 注意注入顺序：常量先声明再被函数体引用；export 出去的只有 __vitePreload，其余在模块作用域内可见。
  const preloadCode = `const scriptRel = ${scriptRel};const assetsURL = ${assetsURL};const seen = {};const failedCssLinks = {};const isCssPreloadUrl = ${isCssPreloadUrl.toString()};const preloadOnce = ${preloadOnce.toString()};export const ${preloadMethod} = ${preloadMethodCode}`
  return preloadCode
}

/**
 * Build only. During serve this is performed as part of ./importAnalysis.
 */
/**
 * 作用：构建阶段的 import 分析插件工厂，返回「JS 侧兜底实现 + rolldown 原生实现」两个插件。
 * 调用点：build.ts 的 resolveBuildPlugins()（isBuild 时放进 post 段）。
 * 关键参数：config 是顶层配置；真正的环境差异通过 this.environment 在 hook 内读取。
 * 失败模式：generateBundle 里 es-module-lexer 解析产物失败时，会用 this.error 抛带 code frame 的错误。
 * 顺序：renderStart 清空每环境状态 → renderChunk 记录 chunk 信息/替换 modern 标记 →
 *   augmentChunkHash 在定 hash 前把 preload 依赖纳入 → generateBundle 真正替换 marker。
 */
export function buildImportAnalysisPlugin(config: ResolvedConfig): Plugin[] {
  // 只有 client、非 worker、非 lib 构建才注入 preload：SSR/worker 没有 <link> 预加载语义，lib 由使用方决定。
  const getInsertPreload = (environment: PartialEnvironment) =>
    environment.config.consumer === 'client' &&
    !config.isWorker &&
    !config.build.lib

  const renderBuiltUrl = config.experimental.renderBuiltUrl
  const isRelativeBase = config.base === './' || config.base === ''

  // With chunkImportMap: true, stable import specifiers can hide changes to the
  // preload dependencies injected in generateBundle after hashing. Keep the graph
  // per environment so augmentChunkHash includes those changes before hashing.
  // With chunkImportMap: false, imports use hashed filenames, so dependency
  // changes already propagate into the importing chunk's hash.
  // chunkImportMap:true 时 specifier 是稳定 key，preload 依赖的变化不会体现在文件名里，
  // 因此必须在 hash 计算前用 augmentChunkHash 把依赖签名并进去；false 时文件名自带 hash，天然会变。
  const getPreloadHashGraph = perEnvironmentState(() => ({
    chunks: {} as Record<string, RenderedChunk>,
    chunkImportMapKeySignatures: new Map<string, string>(),
    chunkInfo: new Map<
      string,
      { importedCssCount: number; isPureCss: boolean }
    >(),
  }))

  const plugin: Plugin = {
    name: 'vite:build-import-analysis',

    renderStart() {
      // 每轮构建开始清空图：watch 下不能复用上一轮的 chunk 信息，否则会算出过期的 preload 依赖。
      const graph = getPreloadHashGraph(this)
      graph.chunks = {}
      graph.chunkImportMapKeySignatures.clear()
      graph.chunkInfo.clear()
    },

    renderChunk(code, chunk, { format }, { chunks }) {
      // chunkImportMap 模式需要提前知道「哪些 chunk 是纯 CSS、各自引了多少 CSS」，供 augmentChunkHash 用。
      // 这里拿到的 chunks 是渲染态（preliminaryFileName 还没换成最终 hash 名）。
      if (
        format === 'es' &&
        getInsertPreload(this.environment) &&
        this.environment.config.build.chunkImportMap
      ) {
        const graph = getPreloadHashGraph(this)
        graph.chunks = chunks
        const importedCssCount = chunk.viteMetadata?.importedCss.size ?? 0
        graph.chunkInfo.set(chunk.fileName, {
          importedCssCount,
          isPureCss: code === '' && importedCssCount > 0,
        })
      }

      // make sure we only perform the preload logic in modern builds.
      // 这里替换 __VITE_IS_MODERN__：ES 产物为 true，其它格式为 false；补空格是为了不改变列号、保住 sourcemap。
      if (code.includes(isModernFlag)) {
        const re = new RegExp(isModernFlag, 'g')
        const isModern = String(format === 'es')
        const isModernWithPadding =
          isModern + ' '.repeat(isModernFlag.length - isModern.length)
        return {
          code: code.replace(re, isModernWithPadding),
          map: null,
        }
      }
      return null
    },

    augmentChunkHash(chunk) {
      // 只在 chunkImportMap + 需要注入 preload 的场景参与 hash；其余情况返回 undefined 表示不加料。
      const environment = this.environment
      if (!getInsertPreload(environment)) return
      const { chunkImportMap, modulePreload } = environment.config.build
      if (!chunkImportMap) return

      const graph = getPreloadHashGraph(this)
      const owner = graph.chunks[chunk.fileName]
      if (!owner) return

      if (graph.chunkImportMapKeySignatures.size === 0) {
        // 签名单次构建只算一次（懒初始化）：依赖整张 chunk 表，逐 chunk 重算会 O(n²)。
        // cwd 必须与 rolldown 生成 importmap key 时一致，否则绝对路径的稳定 id 会不同。
        graph.chunkImportMapKeySignatures = getChunkImportMapKeySignatures(
          graph.chunks,
          path.resolve(
            environment.config.build.rolldownOptions.cwd ?? process.cwd(),
          ),
        )
      }
      const getKey = (fileName: string) =>
        graph.chunkImportMapKeySignatures.get(fileName)!

      // 纯 CSS chunk 会被 Vite 从 bundle 里删除，但它仍出现在 imports 列表里；
      // 这些「幽灵 import」必须计入 hash，否则删除/恢复纯 CSS chunk 时 importer 的 hash 不变，浏览器会命中旧缓存。
      const pureCssImports = [...owner.imports, ...owner.dynamicImports]
        .filter((fileName) => graph.chunkInfo.get(fileName)?.isPureCss)
        .map(getKey)

      // 对每个动态 import 递归收集 preload 依赖，并把「稳定 key + 是否 JS + CSS 数量」组成签名。
      // CSS 数量也要进签名：同一 chunk 的 CSS 集合变了，preload 列表就变了，hash 必须跟着变。
      const preloadSignatures = owner.dynamicImports.map((dynamicImport) =>
        collectPreloadDependencies(
          dynamicImport,
          chunk.fileName,
          (fileName) => {
            const dependency = graph.chunks[fileName]
            if (!dependency) return
            const key = getKey(fileName)
            const { importedCssCount = 0, isPureCss = false } =
              graph.chunkInfo.get(fileName) ?? {}
            return {
              fileName,
              js:
                modulePreload !== false && !isPureCss ? `js:${key}` : undefined,
              imports: dependency.imports,
              css:
                importedCssCount > 0
                  ? [`css:${key}:${importedCssCount}`]
                  : undefined,
            }
          },
        ),
      )

      if (
        pureCssImports.length ||
        preloadSignatures.some((dependencies) => dependencies.length)
      ) {
        return JSON.stringify([pureCssImports, preloadSignatures])
      }
    },

    async generateBundle(opts, bundle) {
      // 只处理 ES 产物：__vitePreload/importmap 都依赖原生 ESM 语义，umd/iife 不适用。
      const { format } = opts
      if (format !== 'es') {
        return
      }

      // es-module-lexer 需要先 init（wasm），否则 parseImports 会抛。
      await init()

      // importmap（chunkImportMap:true 时 importMap 插件产出的资产）：先剔除指向已删除纯 CSS chunk 的条目。
      const importMap = getImportMap(bundle, this.environment.config)
      if (importMap) {
        const removedPureCssFiles = removedPureCssFilesCache.get(config)
        if (removedPureCssFiles?.size) {
          const base = this.environment.config.base
          for (const [specifier, fileName] of Object.entries(
            importMap.content.imports,
          )) {
            if (removedPureCssFiles.has(fileName.slice(base.length))) {
              delete importMap.content.imports[specifier]
            }
          }
          importMap.asset.source = JSON.stringify(importMap.content)
        }
      }

      // If preload is not enabled, we parse through each imports and remove any imports to pure CSS chunks
      // as they are removed from the bundle
      // 不注入 preload 的分支（SSR/worker/lib）：没有 __vitePreload 帮忙兜底，只能把指向已删除 CSS chunk 的
      // 动态 import 原地改写成 Promise.resolve({})，保持模块能加载且 sourcemap 列宽不变。
      if (!getInsertPreload(this.environment)) {
        const removedPureCssFiles = removedPureCssFilesCache.get(config)
        if (removedPureCssFiles && removedPureCssFiles.size > 0) {
          for (const file in bundle) {
            const chunk = bundle[file]
            if (chunk.type === 'chunk' && chunk.code.includes('import')) {
              const code = chunk.code
              let imports!: DynamicImport[]
              try {
                imports = parseImports(code)[0].filter(
                  (i): i is DynamicImport => i.type === 'dynamic',
                )
              } catch (e: any) {
                // 解析失败时把 es-module-lexer 的字节偏移换算成行列号，并附带 code frame，方便定位产物问题。
                const loc = numberToPos(code, e.idx)
                this.error({
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                  cause: e.cause,
                  pos: e.idx,
                  loc: { ...loc, file: chunk.fileName },
                  frame: generateCodeFrame(code, loc),
                })
              }

              for (const imp of imports) {
                const {
                  specifier: name,
                  start,
                  end,
                  importStart: expStart,
                  importEnd: expEnd,
                  glob,
                } = imp
                let url = glob ? undefined : name
                // glob（import.meta.glob 的动态形式）没有单个 specifier，只能从源码切片里取字符串字面量。
                if (!url) {
                  const rawUrl = code.slice(start, end)
                  if (
                    (rawUrl[0] === `"` && rawUrl.at(-1) === `"`) ||
                    (rawUrl[0] === '`' && rawUrl.at(-1) === '`')
                  )
                    url = rawUrl.slice(1, -1)
                }
                if (!url) continue

                const normalizedFile = path.posix.join(
                  path.posix.dirname(chunk.fileName),
                  cleanUrl(url),
                )
                const fileName =
                  importMap?.mapping[normalizedFile] ?? normalizedFile
                if (removedPureCssFiles.has(fileName)) {
                  // remove with Promise.resolve({}) while preserving source map location
                  chunk.code =
                    chunk.code.slice(0, expStart) +
                    `Promise.resolve({${''.padEnd(expEnd - expStart - 19, ' ')}})` +
                    chunk.code.slice(expEnd)
                }
              }
            }
          }
        }
        return
      }
      const buildSourcemap = this.environment.config.build.sourcemap
      const { modulePreload } = this.environment.config.build

      // chunkImportMap 模式下 specifier 是稳定 key（非真实文件名），这里建双向映射：
      // 正向把 bundle 内的真实文件名换回 key；反向把 deps 里的 key 换成真实文件名。
      let importMapMapping: Record<string, string> | undefined
      let importMapReverseMapping: Record<string, string> | undefined
      if (importMap) {
        importMapMapping = importMap.mapping
        importMapReverseMapping = Object.fromEntries(
          Object.entries(importMapMapping).map(([k, v]) => [v, k]),
        )

        if (config.isOutputOptionsForLegacyChunks?.(opts)) {
          // legacy 产物单独输出一份 importmap（legacy chunk 的 key 与 modern 不同），
          // 同时从 bundle 里移除默认的 importmap 资产，避免两份同名文件互相覆盖。
          this.emitFile({
            type: 'asset',
            fileName: 'importmap.legacy.json',
            source: importMap.asset.source,
          })
          delete bundle[getImportMapFilename(this.environment.config)]
        }
      }

      for (const file in bundle) {
        const chunk = bundle[file]
        // can't use chunk.dynamicImports.length here since some modules e.g.
        // dynamic import to constant json may get inlined.
        // 不能用 chunk.dynamicImports 判断：内联掉的动态 import 不会留下 marker，反之也可能有 marker 但无 dynamicImports。
        if (chunk.type === 'chunk' && chunk.code.includes(preloadMarker)) {
          const code = chunk.code
          let imports!: DynamicImport[]
          try {
            imports = parseImports(code)[0].filter(
              (i): i is DynamicImport => i.type === 'dynamic',
            )
          } catch (e: any) {
            const loc = numberToPos(code, e.idx)
            this.error({
              name: e.name,
              message: e.message,
              stack: e.stack,
              cause: e.cause,
              pos: e.idx,
              loc: { ...loc, file: chunk.fileName },
              frame: generateCodeFrame(code, loc),
            })
          }

          const s = new MagicString(code)
          const rewroteMarkerStartPos = new Set() // position of the leading double quote

          // fileDeps 是产物的「依赖 URL 表」：marker 里只放下标，运行时由 __vite__mapDeps 查表。
          // 这样同一个依赖在多个动态 import 中只出现一次（按 url 去重）。
          const fileDeps: FileDep[] = []
          const addFileDep = (
            url: string,
            runtime: boolean = false,
          ): number => {
            const index = fileDeps.findIndex((dep) => dep.url === url)
            if (index === -1) {
              return fileDeps.push({ url, runtime }) - 1
            } else {
              return index
            }
          }

          if (imports.length) {
            // 先把「第 i 个动态 import」与「第 i 个 marker 的起始下标」配对，再逐个改写。
            const importMarkerPos = matchImportsToPreloadMarkers(code, imports)

            for (let index = 0; index < imports.length; index++) {
              // Use the decoded specifier to handle escape sequences.
              const {
                specifier: name,
                start,
                end,
                importStart: expStart,
                importEnd: expEnd,
                glob,
              } = imports[index]
              // check the chunk being imported
              let url = glob ? undefined : name
              if (!url) {
                const rawUrl = code.slice(start, end)
                if (
                  (rawUrl[0] === `"` && rawUrl.at(-1) === `"`) ||
                  (rawUrl[0] === '`' && rawUrl.at(-1) === '`')
                )
                  url = rawUrl.slice(1, -1)
              }
              let deps = new Set<string>()
              let hasRemovedPureCssChunk = false

              let normalizedFile: string | undefined = undefined

              if (url) {
                // specifier 是相对当前 chunk 的产物文件名；先归一化成 bundle 的 key（posix 相对路径）。
                normalizedFile = path.posix.join(
                  path.posix.dirname(chunk.fileName),
                  cleanUrl(url),
                )

                let shouldRewriteImport = false
                // 递归遍历被 import 的 chunk 及其静态 imports，收集出「需要 preload 的 URL」集合。
                // 返回值里包含被 import 的主 chunk 自身（所以后面用 deps.size > 1 判断是否还有额外依赖）。
                deps = new Set(
                  collectPreloadDependencies(
                    normalizedFile,
                    chunk.fileName,
                    (rawFilename) => {
                      // chunkImportMap 下 specifier 是 key，先映射回真实文件名再查 bundle。
                      const fileName =
                        importMapMapping?.[rawFilename] ?? rawFilename
                      const dependency = bundle[fileName]
                      if (dependency?.type === 'chunk') {
                        return {
                          fileName,
                          js: dependency.fileName,
                          imports: dependency.imports,
                          // importedCss 由 Vite 的 CSS 插件写入 viteMetadata，是「本 chunk 关联的 CSS」的唯一来源。
                          css: dependency.viteMetadata!.importedCss,
                        }
                      }
                      if (dependency) {
                        return { fileName, js: dependency.fileName }
                      }
                      // 已从 bundle 删除的纯 CSS chunk：仍要 preload 它的 CSS，同时把原 import 改写成空模块。
                      const removedPureCssChunk = removedPureCssFilesCache
                        .get(config)!
                        .get(fileName)
                      if (removedPureCssChunk) {
                        const css =
                          removedPureCssChunk.viteMetadata!.importedCss
                        if (css.size) hasRemovedPureCssChunk = true
                        shouldRewriteImport = true
                        return { fileName, css }
                      }
                    },
                  ),
                )
                if (shouldRewriteImport) {
                  // 纯 CSS chunk 已被删除，动态 import 它只应触发 CSS，因此替换成已 resolve 的空对象。
                  s.update(expStart, expEnd, 'Promise.resolve({})')
                }
              }

              // marker 为 -1 表示这个 import 没配上 marker（例如内联掉了），后面统一清成 void 0。
              const markerStartPos = importMarkerPos[index]

              if (markerStartPos > 0) {
                const marker = findPreloadMarker(code, markerStartPos)!
                // the dep list includes the main chunk, so only need to reload when there are actual other deps.
                // deps 至少含主 chunk 自己：size===1 说明没有额外依赖，不必让 __vitePreload 去插 <link>。
                let depsArray =
                  deps.size > 1 ||
                  // main chunk is removed
                  (hasRemovedPureCssChunk && deps.size > 0)
                    ? modulePreload === false
                      ? // CSS deps use the same mechanism as module preloads, so even if disabled,
                        // we still need to pass these deps to the preload helper in dynamic imports.
                        [...deps].filter((d) => d.endsWith('.css'))
                      : [...deps]
                    : []

                const resolveDependencies = modulePreload
                  ? modulePreload.resolveDependencies
                  : undefined
                if (resolveDependencies && normalizedFile) {
                  // 用户的 resolveDependencies 只能增删真正的 preload 依赖；CSS 必须保留（它是样式，不是优化项）。
                  // 注意传入的是 URL 而不是 importmap specifier。
                  // We can't let the user remove css deps as these aren't really preloads, they are just using
                  // the same mechanism as module preloads for this chunk
                  const cssDeps: string[] = []
                  const otherDeps: string[] = []
                  for (const dep of depsArray) {
                    ;(dep.endsWith('.css') ? cssDeps : otherDeps).push(dep)
                  }
                  depsArray = [
                    // NOTE: deps are URLs, not specifiers using the import map mapping
                    ...resolveDependencies(normalizedFile, otherDeps, {
                      hostId: file,
                      hostType: 'js',
                    }),
                    ...cssDeps,
                  ]
                }

                // deps 前面可能还是 importmap key，这里换回真实文件名（产物里必须写真实 URL）。
                depsArray = depsArray.map(
                  (dep) => importMapReverseMapping?.[dep] ?? dep,
                )

                let renderedDeps: number[]
                if (renderBuiltUrl) {
                  // 走 renderBuiltUrl 时结果可能是 { runtime } 表达式：以 runtime=true 记进 fileDeps，
                  // 生成表项时不再 JSON.stringify，而是原样拼进代码。
                  renderedDeps = depsArray.map((dep) => {
                    const replacement = toOutputFilePathInJS(
                      this.environment,
                      dep,
                      'asset',
                      chunk.fileName,
                      'js',
                      toRelativePath,
                    )

                    if (typeof replacement === 'string') {
                      return addFileDep(replacement)
                    }

                    return addFileDep(replacement.runtime, true)
                  })
                } else {
                  // 相对 base：依赖写成相对当前 chunk 的路径；绝对 base：保留 outDir 内相对路径，
                  // base 前缀由运行时 assetsURL 统一补（避免每个 chunk 都重复写一遍 base）。
                  renderedDeps = depsArray.map((d) =>
                    // Don't include the assets dir if the default asset file names
                    // are used, the path will be reconstructed by the import preload helper
                    isRelativeBase
                      ? addFileDep(toRelativePath(d, file))
                      : addFileDep(d),
                  )
                }

                // marker 最终变成一个下标数组表达式；空数组表示「不需要 preload 额外依赖」。
                s.update(
                  markerStartPos,
                  markerStartPos + marker[0].length,
                  renderedDeps.length > 0
                    ? `__vite__mapDeps([${renderedDeps.join(',')}])`
                    : `[]`,
                )
                // 记录已改写的 marker，后面清理循环要跳过它们。
                rewroteMarkerStartPos.add(markerStartPos)
              }
            }
          }

          if (fileDeps.length > 0) {
            // runtime 项原样拼接（已是 JS 表达式），静态项 JSON.stringify；两者混在一张表里。
            const fileDepsCode = `[${fileDeps
              .map((fileDep) =>
                fileDep.runtime ? fileDep.url : JSON.stringify(fileDep.url),
              )
              .join(',')}]`

            // __vite__mapDeps 做成「首次调用时初始化 m.f 缓存」的形式：同一模块后续调用直接复用数组。
            const mapDepsCode = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${fileDepsCode})))=>i.map(i=>d[i]);\n`

            // inject extra code at the top or next line of hashbang
            // 有 hashbang（#!/usr/bin/env node）时不能插到第一行之前，否则 shebang 失效。
            if (code.startsWith('#!')) {
              s.prependLeft(getFileStartIndex(code), mapDepsCode)
            } else {
              s.prepend(mapDepsCode)
            }
          }

          // there may still be markers due to inlined dynamic imports, remove
          // all the markers regardless
          // 兜底清理：被内联掉的动态 import 不会走到上面的改写分支，但它们留下的 marker 必须清掉，
          // 否则产物里残留 __VITE_PRELOAD__ 标识符，运行时报错。替换成 void 0 保持列宽。
          let marker = findPreloadMarker(code)
          while (marker) {
            const markerStartPos = marker.index
            if (!rewroteMarkerStartPos.has(markerStartPos)) {
              s.update(
                markerStartPos,
                markerStartPos + marker[0].length,
                'void 0',
              )
            }
            marker = findPreloadMarker(code, markerStartPos + marker[0].length)
          }

          if (s.hasChanged()) {
            chunk.code = s.toString()
            if (buildSourcemap && chunk.map) {
              // MagicString 只知道自己对 code 做的改动；把它与 rolldown 原始的 map 依次合并（nextMap 在前）。
              const nextMap = s.generateDecodedMap({
                source: chunk.fileName,
                hires: 'boundary',
              })
              const originalFile = chunk.map.file
              const map = combineSourcemaps(chunk.fileName, [
                nextMap as DecodedSourceMap,
                chunk.map as RawSourceMap,
              ]) as SourceMap
              map.toUrl = () => genSourceMapUrl(map)
              if (originalFile) {
                map.file = originalFile
              }

              const originalDebugId = chunk.map.debugId
              chunk.map = map

              if (buildSourcemap === 'inline') {
                // inline：先删掉旧的 sourceMappingURL 注释，再追加新的 data URI，避免出现两条注释。
                chunk.code = chunk.code.replace(
                  convertSourceMap.mapFileCommentRegex,
                  '',
                )
                chunk.code += `\n//# sourceMappingURL=${genSourceMapUrl(map)}`
              } else {
                // 外置 map：直接改写 bundle 里已经存在的 .map 资产（不能新 emit，否则 hash/文件名会错位）。
                if (originalDebugId) {
                  map.debugId = originalDebugId
                }
                const mapAsset = bundle[chunk.fileName + '.map']
                if (mapAsset && mapAsset.type === 'asset') {
                  mapAsset.source = map.toString()
                }
              }
            }
          }
        }
      }
    },
  }

  return [
    plugin,
    // 第二个插件是 rolldown 的原生实现（Rust）：真正生产环境的 marker 替换/依赖收集由它完成，
    // JS 侧 plugin 负责 chunkImportMap、多格式与 sourcemap 合并等边界情况，两者靠同样的 marker 契约协作。
    perEnvironmentPlugin('native:import-analysis-build', (environment) => {
      const preloadCode = getPreloadCode(
        environment,
        !!renderBuiltUrl,
        isRelativeBase,
      )
      return nativeBuildImportAnalysisPlugin({
        preloadCode,
        insertPreload: getInsertPreload(environment),
        // this field looks redundant, put a dummy value for now
        optimizeModulePreloadRelativePaths: false,
        renderBuiltUrl: !!renderBuiltUrl,
        isRelativeBase,
      })
    }),
  ]
}
