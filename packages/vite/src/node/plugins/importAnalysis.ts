import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { makeLegalIdentifier } from '@rollup/pluginutils'
import type {
  Export,
  Import,
  ParseError as EsModuleLexerParseError,
} from 'es-module-lexer'
import { init, parse as parseImports } from 'es-module-lexer'
import MagicString from 'magic-string'
import type { StaticImport } from 'mlly'
import { ESM_STATIC_IMPORT_RE, parseStaticImport } from 'mlly'
import colors from 'picocolors'
import type { PartialResolvedId, RollupError } from 'rolldown'
import { parseAst } from 'rolldown/parseAst'
import type { ESTree } from 'rolldown/utils'
import {
  cleanUrl,
  moduleUrlToBrowserUrl,
  withTrailingSlash,
} from '../../shared/utils'
import type { ResolvedConfig } from '../config'
import {
  CLIENT_DIR,
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  SPECIAL_QUERY_RE,
} from '../constants'
import { shouldExternalize } from '../external'
import {
  optimizedDepInfoFromFile,
  optimizedDepNeedsInterop,
} from '../optimizer'
import type { Plugin } from '../plugin'
import { checkPublicFile } from '../publicDir'
import type { DevEnvironment } from '../server/environment'
import {
  debugHmr,
  handlePrunedModules,
  lexAcceptedHmrDeps,
  lexAcceptedHmrExports,
} from '../server/hmr'
import type { EnvironmentModuleNode } from '../server/moduleGraph'
import {
  browserUrlToModuleUrl,
  resolvedIdToModuleUrl,
} from '../server/moduleUrl'
import type { TransformPluginContext } from '../server/pluginContainer'
import {
  createDebugger,
  generateCodeFrame,
  getFileStartIndex,
  getHash,
  injectQuery,
  isBuiltin,
  isCSSRequest,
  isDataUrl,
  isDefined,
  isExternalUrl,
  isFilePathESM,
  isFilePathFormatExplicit,
  isInNodeModules,
  isJSRequest,
  moduleListContains,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBomTag,
  timeFrom,
  transformStableResult,
  urlRE,
} from '../utils'
import { isDirectCSSRequest } from './css'
import { serializeDefine } from './define'
import { throwOutdatedRequest } from './optimizedDeps'
import { getAliasPatternMatcher } from './preAlias'
import { browserExternalId } from './resolve'
import { WORKER_FILE_ID } from './worker'

// ─────────────────────────── 文件角色 ───────────────────────────
// 本文件是 dev 链路里「把源码中的 import 说明符改成浏览器能直接请求的 URL」的核心插件。
// 位置：plugins/index.ts 的 createPluginHookUtils/内置插件数组末尾（importAnalysisPlugin(config)
//   是数组最后一项），因此它看到的 source 已经过 oxcPlugin 转译（TS/JSX 已降级为纯 JS），
//   前置的 define/css/asset/worker 等插件也都跑完了。
// 上游：pluginContainer.transform 按序调用各插件 transform 钩子（见 server/pluginContainer.ts）。
// 下游它调用：environment.pluginContainer.resolveId（经 this.resolve）做说明符解析、
//   resolve 插件里的 depsOptimizer.registerMissingImport 触发依赖预构建、
//   environment.moduleGraph 记录 import/accept 关系、server/hmr.ts 的 lexer 解析 HMR accept 参数。
// 关键不变量：
//   1) 本插件必须最后运行——它按最终代码里 import 的真实偏移量改写，前面的插件若再改动
//      代码/换行，偏移量就全错了；
//   2) 所有改写都走 MagicString 的 contentOnly，并且用换行数填充保持行号不变（见 getLineBreaks），
//      所以 dev 下不需要为它单独生成 sourcemap（见文件末尾 transformStableResult 的返回）；
//   3) 它不做打包，也不做裸模块路径计算：`foo` → `/node_modules/.vite/deps/foo.js?v=hash`
//      是 resolve 插件调用 depsOptimizer.getOptimizedDepId 得到的结果，这里只负责「拿去用」。
// 最容易误解的点：
//   - 这里拿到的 import 记录来自 es-module-lexer，是「词法区间」而不是 AST，因此位置比 AST 精确；
//   - 同一个 import 会先走 resolveImport（语义判断：external/ssr/public 目录等），
//     再走 getImportModule（ModuleURL 生成 + moduleGraph 登记 + 查询串注入），两者职责不同；
//   - transform 内对 imports 的循环是并发的（Promise.all），靠「按 index 预分配的数组」保序。
const debug = createDebugger('vite:import-analysis')

const clientDir = normalizePath(CLIENT_DIR)

// 可跳过本插件的 id：sourcemap 与 json 不需要 import 改写；直出 CSS（无 ?inline/?raw 等特殊查询）
// 由 css-analysis 插件自己维护依赖图，见本文件后面 `if (!isCSSRequest(importer) || SPECIAL_QUERY_RE.test(importer))`。
// 调用点：本文件 importAnalysisPlugin.transform 开头、getImportModule 计算 _ensureEntryFromUrl 参数时。
const skipRE = /\.(?:map|json)(?:$|\?)/
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id)

// 预构建产物里的「公共 chunk」文件名形如 chunk-XXXXXXXX.js（由 deps optimizer 生成）。
// 这些 chunk 已经是 ESM（内部互相引用），不需要再做 cjs 命名导入 interop，见下面的 isOptimizedDepFile 分支。
const optimizedDepChunkRE = /\/chunk-[A-Z\d]{8}\.js/

// `/* @vite-ignore */` 标记：告诉 Vite 不要尝试静态分析紧随其后的动态 import 表达式。
// 调用点（Grep 确认）：本文件 transform 的动态 import 警告分支、
//   optimizer/rolldownDepPlugin.ts、plugins/assetImportMetaUrl.ts、plugins/dynamicImportVars.ts、
//   plugins/workerImportMetaUrl.ts——它们都要在扫描前跳过被忽略的表达式。
export const hasViteIgnoreRE: RegExp = /\/\*\s*@vite-ignore\s*\*\//

// 动态 import 的实参「整体就是一个字符串字面量」的判定（含引号）。用于决定是否还需要在运行时
// 包一层 __vite__injectQuery，见 specifier 为 undefined 的分支。
const urlIsStringRE = /^(?:'.*'|".*"|`.*`)$/

// 无插值的模板字符串 import(`./a.js`)，es-module-lexer 不会给出 specifier（它不是静态字符串），
// 这里把它还原成普通字符串再参与解析，避免误报「cannot be analyzed」。
const templateLiteralRE = /^\s*`(.*)`\s*$/

interface UrlPosition {
  url: string
  start: number
  end: number
}

// 判断一个 URL 是否必须带 `?import` 才能被当作 JS 模块请求。
// js/css 请求天然会进 transform（见 server/middlewares/transform.ts 的 isTransformRequest），
// 其它扩展名（.png/.svg/.wasm…）只有显式带 `?import` 才会被 transform 插件链处理成 JS 模块导出，
// 否则会被静态文件中间件当普通资源直接吐回去。
// 调用点（Grep 确认）：本文件 getImportModule（给说明符加 ?import）与 transform 的
//   「运行时拼出来的动态 import」分支；server/hmr.ts 计算 update.explicitImportRequired，
//   浏览器端 HMR 客户端按该标志给 acceptedPath 追加 ?import。
export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(url) && !isCSSRequest(url)
}

// 记录「某模块从 id 这个依赖里导入了哪些绑定」，供 experimental.hmrPartialAccept 使用。
// 为什么需要：HMR 默认粒度是「整个模块」，而 partial accept 要判断某个 acceptExports
//   边界是否覆盖了导入方实际用到的全部绑定；只有全部覆盖才能只发 binding 级更新。
// 调用点：本文件 transform 中 enablePartialAccept && importedBindings 时调用；
//   结果写入 moduleGraph.updateModuleInfo 的 importedBindings 参数，
//   最终由 server/hmr.ts 的 areAllImportsAccepted 消费。
// 失败模式：es-module-lexer 给出的 importStart/importEnd 片段若不匹配 ESM_STATIC_IMPORT_RE
//   （例如语法奇特、注释夹在中间），直接 return —— 该依赖不会被登记绑定，
//   保守后果是 partial accept 退化为整模块更新，而不是报错。
function extractImportedBindings(
  id: string,
  source: string,
  importSpec: Import,
  importedBindings: Map<string, Set<string>>,
) {
  let bindings = importedBindings.get(id)
  if (!bindings) {
    bindings = new Set<string>()
    importedBindings.set(id, bindings)
  }

  // 动态 import 与 import.meta.glob 的绑定在静态阶段无法穷举，用 '*' 表示
  // 「该依赖的任何导出变化都可能影响本模块」，让 partial accept 直接放弃精细判断。
  const isDynamic = importSpec.type === 'dynamic'
  const isMeta = importSpec.type === 'import-meta'
  if (isDynamic || isMeta) {
    // this basically means the module will be impacted by any change in its dep
    bindings.add('*')
    return
  }

  // 只截取 import 语句本身（不含前置注释/其它代码）交给 mlly 的静态 import 解析器，
  // 因为 ESM_STATIC_IMPORT_RE 依赖语句形态，偏移必须精确落在语句上。
  const exp = source.slice(importSpec.importStart, importSpec.importEnd)
  ESM_STATIC_IMPORT_RE.lastIndex = 0
  const match = ESM_STATIC_IMPORT_RE.exec(exp)
  if (!match) {
    return
  }

  const staticImport: StaticImport = {
    type: 'static',
    code: match[0],
    start: match.index,
    end: match.index + match[0].length,
    imports: match.groups!.imports,
    specifier: match.groups!.specifier,
  }
  const parsed = parseStaticImport(staticImport)
  if (parsed.namespacedImport) {
    bindings.add('*')
  }
  if (parsed.defaultImport) {
    bindings.add('default')
  }
  if (parsed.namedImports) {
    for (const name of Object.keys(parsed.namedImports)) {
      bindings.add(name)
    }
  }
}

/**
 * Dev-only plugin that lexes, resolves, rewrites and analyzes url imports.
 *
 * - Imports are resolved to ensure they exist on disk
 *
 * - Lexes HMR accept calls and updates import relationships in the module graph
 *
 * - Bare module imports are resolved (by @rollup-plugin/node-resolve) to
 * absolute file paths, e.g.
 *
 *     ```js
 *     import 'foo'
 *     ```
 *     is rewritten to
 *     ```js
 *     import '/@fs//project/node_modules/foo/dist/foo.js'
 *     ```
 *
 * - CSS imports are appended with `.js` since both the js module and the actual
 * css (referenced via `<link>`) may go through the transform pipeline:
 *
 *     ```js
 *     import './style.css'
 *     ```
 *     is rewritten to
 *     ```js
 *     import './style.css.js'
 *     ```
 */
// ─────────────────────────── 主插件 ───────────────────────────
// 作用：dev 下改写 import 说明符 + 解析 import.meta.hot / import.meta.env 用法 + 更新模块图。
// 调用点：plugins/index.ts 的 createPluginHookUtils（内置插件数组最后一项 importAnalysisPlugin(config)）。
// 关键参数：config 是已 resolve 的配置；base 参与 BrowserURL 拼接，CLIENT_PUBLIC_PATH 指向
//   /@vite/client（HMR 运行时与 injectQuery 的来源）。
// 失败模式：
//   - 解析失败的静态 import 在 client 下直接 this.error（附带代码帧）；ssr 下放行给 Node 运行时；
//   - 已预构建的依赖过期时由 throwOutdatedRequest 抛 504，让浏览器整页刷新兜底；
//   - 源码无法被 lexer 解析（例如 .vue 缺插件）时走 createParseErrorInfo 的提示文案。
// 说明：上面这段英文 JSDoc 是历史描述（提到 @rollup-plugin/node-resolve），
//   现在的裸模块解析由 plugins/resolve.ts + depsOptimizer 完成，本插件只消费解析结果。
export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config
  // clientPublicPath 是 `/@vite/client`（base 前缀后的形态），被用作：HMR 运行时 import 来源、
  // 以及 resolveImport 里「/@vite/client 已在客户端有浏览器 URL，直接视为 external」的快速通道。
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH)
  // experimental.hmrPartialAccept 开启时才收集 importedBindings；关闭时传 null 以省内存。
  const enablePartialAccept = config.experimental.hmrPartialAccept
  // 用 alias 的 pattern 判定是否需要绕过「remote/data URL 直接 external」的快速通道，
  // 即：即使看起来是外部 URL，只要命中 alias 仍要交给解析器改写成本地模块。
  const matchAlias = getAliasPatternMatcher(config.resolve.alias)

  // getEnv：生成 `import.meta.env = {...}` 的前置注入代码。
  // 调用点：本文件 transform 中 hasEnv && !isClassicWorker 时 `str().prepend(getEnv(ssr))`。
  // 关键参数：ssr 决定内联后 import.meta.env.SSR 的值（'true'/'false'）。
  // 为什么要手动拼：dev 不跑 define 插件的静态替换（define 只处理表达式），
  //   而 import.meta.env 需要是一个真实对象供运行时读取；这里把 config.env 与
  //   define 里 import.meta.env.* 的用户定义合并后序列化。
  // 失败模式：无——序列化用 serializeDefine，避免 JSON.stringify 对 __proto__ 等键的语义问题。
  let _env: string | undefined
  let _ssrEnv: string | undefined
  function getEnv(ssr: boolean) {
    // 每个 config 只算一次：client/ssr 两份字符串共用一个模板，
    // 用 __vite_ssr__ 占位后分别替换，避免重复遍历 env/define。
    if (!_ssrEnv || !_env) {
      const importMetaEnvKeys: Record<string, any> = {}
      const userDefineEnv: Record<string, any> = {}
      for (const key in config.env) {
        importMetaEnvKeys[key] = JSON.stringify(config.env[key])
      }
      for (const key in config.define) {
        // non-import.meta.env.* is handled in `clientInjection` plugin
        if (key.startsWith('import.meta.env.')) {
          userDefineEnv[key.slice(16)] = config.define[key]
        }
      }
      const env = `import.meta.env = ${serializeDefine({
        ...importMetaEnvKeys,
        SSR: '__vite_ssr__',
        ...userDefineEnv,
      })};`
      // __vite_ssr__ 只作为字面量占位出现在 SSR 字段里；这里替换掉它，
      // 注意不能用字符串 'true'/'false' 直接参与前面的模板拼接，否则会污染用户 env 值。
      _ssrEnv = env.replace('__vite_ssr__', 'true')
      _env = env.replace('__vite_ssr__', 'false')
    }
    return ssr ? _ssrEnv : _env
  }

  return {
    name: 'vite:import-analysis',

    // isBundled 为真表示该环境由 rolldown 整包处理（生产构建，或 experimental.bundledDev 的
    // 「打包式 dev」）。这时 import 解析/改写由 rolldown 自己的 resolver 完成，
    // 本插件必须整体关闭，否则会对 rolldown 已处理过的代码再改写一遍。
    applyToEnvironment(environment) {
      return !environment.config.isBundled
    },

    // ───────────── transform：dev 的核心路径 ─────────────
    // 入参 source 是前面所有插件处理后的代码；importer 是模块的完整 id（含查询串）。
    // 返回 null 表示「本次不做任何改写」，pluginContainer 会保上一步的 code/map 不变；
    // 返回 source 表示代码没变但模块图已更新；返回 MagicString 结果表示有改写。
    // 失败模式：lexer 解析失败 → this.error；依赖解析失败 → this.error（client）；
    //   模块图里已没有该 id（预构建批次过期）→ throwOutdatedRequest 抛 504。
    async transform(source, importer) {
      // environment 一定是 DevEnvironment：本插件只在 dev（非 isBundled）生效；
      // ssr 由 consumer === 'server' 判定，决定 external 策略与是否注入 HMR/env 代码。
      const environment = this.environment as DevEnvironment
      const ssr = environment.config.consumer === 'server'
      const moduleGraph = environment.moduleGraph

      // .map/.json/直出 CSS 不需要改写，直接返回 null（不覆盖上游结果，也不碰模块图）。
      if (canSkipImportAnalysis(importer)) {
        debug?.(colors.dim(`[skipped] ${prettifyUrl(importer, root)}`))
        return null
      }

      const msAtStart = debug ? performance.now() : 0
      // 第一遍扫描：init() 加载 es-module-lexer 的 WASM（只需一次），parseImports 一次遍历
      // 同时给出 imports（每条含 start/end/importStart/importEnd/type）与 exports。
      // 注意它是词法级扫描：能拿到精确字节区间，但不会构建 AST，也不会解析动态表达式。
      await init()
      let imports!: readonly Import[]
      let exports!: readonly Export[]
      source = stripBomTag(source)
      try {
        ;[imports, exports] = parseImports(source)
      } catch (_e: unknown) {
        // 解析失败通常不是「说明符有问题」，而是源码本身不是合法 JS（例如 .vue 没装插件、
        // JSX 文件后缀写错）。这里只提示根因，不试图容错，因为后续偏移量已不可信。
        const e = _e as EsModuleLexerParseError
        const { message, showCodeFrame } = createParseErrorInfo(
          importer,
          source,
        )
        this.error(message, showCodeFrame ? e.idx : undefined)
      }
      // export * from 与 type-only 导出没有稳定名字，不参与 partial accept 的覆盖比较。
      const exportNames = exports.flatMap((e) =>
        e.type === 'reexport-all' || e.typeOnly ? [] : [e.name],
      )

      // depsOptimizer 可能为 undefined（例如 optimizeDeps.disabled / ssr 环境未启用）。
      // 它在后续承担三件事：判断 id 是否落在 deps 缓存目录、判断排除优化的依赖、
      // 以及查询某个预构建产物是否需要 cjs→esm 的命名导入 interop。
      const depsOptimizer = environment.depsOptimizer

      // since we are already in the transform phase of the importer, it must
      // have been loaded so its entry is guaranteed in the module graph.
      // 模块图里查不到只有一种合理来源：预构建批次已换代，旧 URL 对应的条目被清理。
      // 此时不能继续（否则会把依赖挂到已废弃的模块上），抛错让中间件回 504，
      // 浏览器收到后整页刷新并重新请求新 URL。
      const importerModule = moduleGraph.getModuleById(importer)
      if (!importerModule) {
        // This request is no longer valid. It could happen for optimized deps
        // requests. A full reload is going to request this id again.
        // Throwing an outdated error so we properly finish the request with a
        // 504 sent to the browser.
        throwOutdatedRequest(importer)
      }

      // 没有任何 import 且没有插件通过 addWatchFile 追加依赖时，仍要更新一次模块图：
      // 目的是把「上一轮存在、这一轮已删除」的 import/accept 边清掉，
      // 否则 HMR 会沿着已失效的边去通知更新。这里传全空集合即为清空。
      // _addedImports 是 pluginContainer 的私有字段（见 server/pluginContainer.ts 的
      // TransformPluginContext._addedImports / addWatchFile），代表插件额外关心的依赖，
      // 有值时不能走这条快速路径，需继续往下走完整流程。
      if (
        !imports.length &&
        !(this as unknown as TransformPluginContext)._addedImports
      ) {
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule,
          new Set(),
          null,
          new Set(),
          null,
          false,
        )
        if (prunedImports) {
          handlePrunedModules(prunedImports, environment)
        }
        debug?.(
          `${timeFrom(msAtStart)} ${colors.dim(
            `[no imports] ${prettifyUrl(importer, root)}`,
          )}`,
        )
        return source
      }

      // 下面这组标志是「扫描过程中发现的事实」，扫描结束后统一决定要 prepend/append 什么：
      // hasHMR → 需要注入 createHotContext；hasEnv → 注入 import.meta.env；
      // isSelfAccepting / isPartiallySelfAccepting → 是否自己处理更新、以及能否做 binding 级更新。
      let hasHMR = false
      let isSelfAccepting = false
      let hasEnv = false
      let needQueryInjectHelper = false
      // MagicString 惰性创建：绝大多数模块可能根本不需要改写（例如只有一个已 external 的 import），
      // 不创建就能省一次整串拷贝，也让「无改写」的返回路径保持零成本。
      let s: MagicString | undefined
      const str = () => s || (s = new MagicString(source))
      let isPartiallySelfAccepting = false
      // partial accept 的收集表：key 是依赖 id（解析后 id 或原始说明符），value 是导入的绑定名集合。
      const importedBindings = enablePartialAccept
        ? new Map<string, Set<string>>()
        : null

      // resolveId：对单个说明符跑一遍插件容器的 resolveId 钩子，并统一「解析不到」的策略。
      // 调用点：本文件 resolveImport 末尾、accepted URL 归一化循环、以及 pluginImports 的补充解析。
      // 关键参数：specifier 是源码里写的原始说明符；pos 是它在源码中的偏移，用于报错定位。
      // 失败模式：client 下解析不到直接 this.error（并标记模块解析失败、关闭 self-accept）；
      //   ssr 下返回 null（保留原说明符，让 Node/ModuleRunner 在运行时报错）。
      // 注意：裸模块 → /node_modules/.vite/deps/xxx.js?v=hash 的改写不在这里发生，
      //   而是 resolve 插件（plugins/resolve.ts 的 finalizeBareSpecifier / tryOptimizedResolve）中
      //   调用 depsOptimizer.registerMissingImport 登记缺失依赖、再用 getOptimizedDepId 拼出 URL；
      //   registerMissingImport 会触发一次增量预构建，本插件只是消费解析结果。
      const resolveId = async (
        specifier: string,
        pos: number,
      ): Promise<PartialResolvedId | null> => {
        let importerFile = importer

        // 被 optimizeDeps.exclude 排除的依赖不会进预构建产物，但可能在「已预构建的其它依赖」内部被 import。
        // 此时若仍从 /node_modules/.vite/deps 出发解析，会找不到（该目录下没有未提升的依赖），
        // 所以要回溯到预构建文件的原始源码位置（optimizedModule.src）作为 importer 重新解析。
        if (
          depsOptimizer &&
          moduleListContains(depsOptimizer.options.exclude, specifier)
        ) {
          // 必须等扫描结束，metadata.depInfoList 才是完整且稳定的；
          // 提前读会读到半成品列表，导致 importerFile 换错或不换。
          await depsOptimizer.scanProcessing

          // if the dependency encountered in the optimized file was excluded from the optimization
          // the dependency needs to be resolved starting from the original source location of the optimized file
          // because starting from node_modules/.vite will not find the dependency if it was not hoisted
          // (that is, if it is under node_modules directory in the package source of the optimized file)
          for (const optimizedModule of depsOptimizer.metadata.depInfoList) {
            if (!optimizedModule.src) continue // Ignore chunks
            if (optimizedModule.file === importerModule.file) {
              importerFile = optimizedModule.src
            }
          }
        }

        // this.resolve = pluginContainer.resolveId，会跑 resolve/alias/预构建等所有解析钩子。
        // 这里把 pos 挂到异常上而不是在这里抛：让错误信息落到具体 import 位置。
        const resolved = await this.resolve(specifier, importerFile).catch(
          (e) => {
            if (e instanceof Error) {
              ;(e as RollupError).pos ??= pos
            }
            throw e
          },
        )

        // NOTE: resolved.meta is undefined in dev
        // 空结果，或 alias 插件显式标记 noResolved（说明命中了 @vite-ignore 风格的「不要解析」别名）。
        if (!resolved || resolved.meta?.['vite:alias']?.noResolved) {
          // in ssr, we should let node handle the missing modules
          // SSR 保留原说明符：Node 侧可能通过条件导出/运行时 require 找到它，dev server 不应过早失败。
          if (ssr) {
            return null
          }
          // fix#9534, prevent the importerModuleNode being stopped from propagating updates
          // 解析失败时若仍保持 self-accepting，HMR 会以为该模块自己处理了更新而不再向上传播，
          // 因此显式关掉并把模块记入失败集合（供后续报错/重试逻辑使用）。
          importerModule.isSelfAccepting = false
          moduleGraph._hasResolveFailedErrorModules.add(importerModule)
          return this.error(
            `Failed to resolve import "${specifier}" from "${normalizePath(
              path.relative(process.cwd(), importerFile),
            )}". Does the file exist?`,
            pos,
          )
        }

        // 下面两个兼容分支的顺序很重要：先判「解析结果本身是远程 URL」，
        // 再判插件手工标记的 external，前者要保留 external=true，
        // 后者（dev 插件标 external 但仍希望本插件改写并纳入本地依赖图）要强制改回 false。
        // Compatibility: plugin-resolved remote URLs are rewritten as-is.
        if (isExternalUrl(resolved.id)) {
          return { ...resolved, external: true }
        }
        // Compatibility: dev plugins can mark an ID external while relying on
        // import analysis to rewrite it and track it as a local dependency.
        if (resolved.external) {
          return { ...resolved, external: false }
        }
        return resolved
      }

      // resolveImport：resolveId 之前的「语义闸门」，决定哪些说明符根本不需要走解析器。
      // 调用点：本文件 transform 里每个 import 记录处理时（`await resolveImport(specifier, start)`）。
      // 关键参数：specifier 原始说明符；pos 用于报错定位。
      // 失败模式：命中 /public 下的非资源文件时抛错（提示改用 ?url），其余情况都返回结果或 null。
      const resolveImport = async (
        specifier: string,
        pos: number,
      ): Promise<PartialResolvedId | null> => {
        // Optimization: @vite/client already uses its BrowserURL
        // /@vite/client 是浏览器直接可请求的路径，再走一遍解析既浪费又可能被别名改坏，直接置为 external。
        if (specifier === clientPublicPath) {
          return { id: specifier, external: true }
        }
        // Compatibility: remote and data imports without aliases bypass resolver
        // hooks, even if a plugin could resolve them to local modules.
        // 注意 matchAlias 必须一起判断：只有「不命中别名的 http(s)/data URL」才跳过解析，
        // 否则用户在 alias 里把某个 URL 映射到本地文件时会失效。
        // file:// 也被排除在外：它需要走解析器转成真实文件系统路径。
        if (
          ((isExternalUrl(specifier) && !specifier.startsWith('file://')) ||
            isDataUrl(specifier)) &&
          !matchAlias(specifier)
        ) {
          return { id: specifier, external: true }
        }
        // SSR 环境：交给 Node 条件解析（externalize 的依赖与 node: 内置模块保持原样），
        // 这样 dev 下的 SSR 行为与生产 Node 运行更一致；命中别名的仍要本地解析。
        if (ssr && !matchAlias(specifier)) {
          if (shouldExternalize(environment, specifier, importer)) {
            return { id: specifier, external: true }
          }
          if (isBuiltin(environment.config.resolve.builtins, specifier)) {
            return { id: specifier, external: true }
          }
        }

        // warn imports to non-asset /public files
        // /public 下的文件在生产构建时原样拷贝、不参与模块图，所以 JS/CSS 只能通过
        // <script src>/<link href> 引用；但资源文件（assetsInclude 或 ?url 等查询）允许被 import 取 URL。
        // 这里只拦「非资源」的情况，并给出改成 ?url 的提示。
        if (
          specifier[0] === '/' &&
          !(
            config.assetsInclude(cleanUrl(specifier)) || urlRE.test(specifier)
          ) &&
          checkPublicFile(specifier, config)
        ) {
          throw new Error(
            `Cannot import non-asset file ${specifier} which is inside /public. ` +
              `JS/CSS files inside /public are copied as-is on build and ` +
              `can only be referenced via <script src> or <link href> in html. ` +
              `If you want to get the URL of that file, use ${injectQuery(
                specifier,
                'url',
              )} instead.`,
          )
        }

        return resolveId(specifier, pos)
      }

      // getImportModule：把「解析结果 id」转成 ModuleURL（无 base、虚拟 id 未包裹的中间形态），
      // 同时把它登记进模块图，并按需注入 `?t=`/`?import`/`?v=` 查询串。
      // 调用点：本文件 transform 的每个 import、accepted URL 归一化循环、pluginImports 补充解析。
      // 关键参数：resolved 为 null 时表示「保留原说明符」（常用于 ssr / external）；
      //   forceSkipImportAnalysis 用于插件额外依赖（它们不参与本插件的 import 改写）。
      // 失败模式：_ensureEntryFromUrl 内部解析/加载失败会抛错，这里补上 pos 后继续抛。
      // 重要：这里产出的是 ModuleURL，例如 `/src/a.ts`、`/@fs/D:/x/y.js`、`\0virtual`；
      //   真正给浏览器的 BrowserURL 由调用处的 moduleUrlToBrowserUrl 加 base 并 wrapId（→ `/@id/`）。
      //   所以「相对路径变成 /src/…」和「何时加 /@fs/」都发生在 server/moduleUrl.ts 的
      //   resolvedIdToModuleUrl 里：在 root 内 → 去 root 前缀；root 外绝对路径 → `/@fs/` 前缀；
      //   非绝对、不以 root 开头的（虚拟 id、裸 URL）原样返回，交给 wrapId 变成 `/@id/…`。
      const getImportModule = async (
        specifier: string,
        resolved: PartialResolvedId | null,
        pos: number,
        forceSkipImportAnalysis: boolean = false,
      ): Promise<{
        moduleUrl: string
        module?: EnvironmentModuleNode
      }> => {
        // resolved 为 null 有两种来源：ssr 下解析不到（保留原说明符交给 Node），
        // 或者说明符本身就是浏览器可直接请求的 URL。这里只做 base 剥离得到 ModuleURL。
        if (!resolved) {
          return { moduleUrl: browserUrlToModuleUrl(specifier, base) }
        }
        let moduleUrl = resolvedIdToModuleUrl(environment, resolved.id)

        let depModule: EnvironmentModuleNode
        try {
          // delay setting `isSelfAccepting` until the file is actually used (#7870)
          // We use an internal function to avoid resolving the url again
          // _ensureEntryFromUrl 是「带已解析结果」的版本：避免 ensureEntryFromUrl 内部
          // 再跑一次 resolveId（那会把刚做完的解析重复一遍）。
          // 第二个参数为 true 时把 isSelfAccepting 先置为 false，等该模块自己走完 transform
          // 再确定，避免未使用模块被误标为自接受而截断 HMR 传播链。
          depModule = await moduleGraph._ensureEntryFromUrl(
            moduleUrl,
            canSkipImportAnalysis(moduleUrl) || forceSkipImportAnalysis,
            resolved,
          )
          // check if the dep has been hmr updated. If yes, we need to attach
          // its last updated timestamp to force the browser to fetch the most
          // up-to-date version of this module.
          // lastHMRTimestamp 由 moduleGraph.invalidateModule 在 isHmr 时写入（见 server/moduleGraph.ts）；
          // 只有 client 需要它：浏览器会用 URL 做模块缓存键，不带 `?t=` 会拿到旧模块。
          // 注意它和 `?v=`（预构建批次 hash）是两个维度：t 表示「HMR 后必须重取」。
          if (
            environment.config.consumer === 'client' &&
            depModule.lastHMRTimestamp > 0
          ) {
            moduleUrl = injectQuery(
              moduleUrl,
              `t=${depModule.lastHMRTimestamp}`,
            )
          }
        } catch (e: any) {
          // it's possible that the dep fails to resolve (non-existent import)
          // attach location to the missing import
          e.pos = pos
          throw e
        }

        // make the URL browser-valid
        // 下面整段只对 client 生效：ssr 的模块由 ModuleRunner 按 id 加载，不需要
        // `?import` 之类的浏览器约定查询串，也不该继承 `?v=`。
        if (environment.config.consumer === 'client') {
          const isRelative = moduleUrl[0] === '.'
          // 自引用：例如 .vue 的虚拟块 import 回自己的 .vue 文件，需要和自己的版本号对齐。
          const isSelfImport = cleanUrl(resolved.id) === cleanUrl(importer)

          // mark non-js/css imports with `?import`
          // 非 js/css（.png/.svg/.wasm 等）加 `?import`，浏览器请求时 transform 中间件才会把它
          // 当 JS 模块处理；消费方见 server/middlewares/transform.ts isTransformRequest 与
          // static.ts 的 public 中间件（带 ?import 时跳过静态直出）。
          // 各类资源的后续处理由各自插件完成：图片/字体由 assetPlugin 的 transform 转成
          // `export default "<url>"`（正是 ?import 让它进入 transform 链）；
          // wasm 由 plugins/wasm.ts 的 wasmHelperPlugin 处理（`?init` 生成 initWasm 调用，
          // 无查询串的 .wasm 则作为 URL 资源导出），本插件只负责补查询串与改 URL。
          if (isExplicitImportRequired(moduleUrl)) {
            moduleUrl = injectQuery(moduleUrl, 'import')
          } else if (
            (isRelative || isSelfImport) &&
            !DEP_VERSION_RE.test(moduleUrl)
          ) {
            // If the ModuleURL isn't a request for a pre-bundled common chunk,
            // for relative js/css imports, or self-module virtual imports
            // (e.g. vue blocks), inherit importer's version query
            // do not do this for unknown type imports, otherwise the appended
            // query can break 3rd party plugin's extension checks.
            // 为什么必须排除预构建产物：预构建文件的版本是 optimzier 的 browserHash，
            // 继承 importer 的 v 会让同一文件出现两个版本键，甚至导致旧批次被复用。
            const versionMatch = DEP_VERSION_RE.exec(importer)
            if (versionMatch) {
              moduleUrl = injectQuery(moduleUrl, versionMatch[1])
            }
          }
        }

        return {
          moduleUrl,
          module: depModule,
        }
      }

      // 下面三个数组按 import 的索引位置预分配：主循环用 Promise.all 并发解析，
      // 完成顺序不确定，但「模块图的依赖顺序」和「accept 的书写顺序」必须是确定的，
      // 因此每个异步任务只写自己的槽位，最后再统一合并。
      // 每个 import 记录单独一个 Set：同一文件里可能有多处 import.meta.hot.accept，
      // 分开收集才能正确处理各自的位置与覆盖范围。
      const orderedImportedUrls: Array<string | undefined> = Array.from({
        length: imports.length,
      })
      const orderedAcceptedUrls: Array<Set<UrlPosition> | undefined> =
        Array.from({ length: imports.length })
      const orderedAcceptedExports: Array<Set<string> | undefined> = Array.from(
        { length: imports.length },
      )

      // isNodeMode 决定 cjs 依赖的 default 互操作语义（见 transformCjsImport）：
      // 导入方是 ESM 时按 Node 语义把 module.exports 直接当 default；
      // 否则退回到「看 __esModule」的旧工具链语义。
      // legacy.inconsistentCjsInterop 强制 false，用来兼容历史行为。
      // 用 ??= 缓存：同一个 importer 在循环里会被问很多次，而 pkg 查找要走文件系统。
      let _isNodeModeResult = config.legacy?.inconsistentCjsInterop
        ? false
        : undefined
      const isNodeMode = () => {
        _isNodeModeResult ??= isFilePathESM(importer, config.packageCache)
        return _isNodeModeResult
      }
      // 动态 import 单独用另一种判定：只有「显式声明了格式」（.mjs/.cjs 或 package.json type）
      // 才认为走 Node 的 ESM 互操作，因为 Node 对未声明格式的 .js 在动态 import 下的行为不同。
      let _isNodeModeForDynamicImportResult = config.legacy
        ?.inconsistentCjsInterop
        ? false
        : undefined
      const isNodeModeForDynamicImport = () => {
        _isNodeModeForDynamicImportResult ??= isFilePathFormatExplicit(
          importer,
          config.packageCache,
        )
        return _isNodeModeForDynamicImportResult
      }

      // ───────────── 第二遍扫描：逐条 resolve + 改写 ─────────────
      // 每条记录的两组偏移量含义不同，改写时必须区分，否则会把引号吞掉或留下引号：
      //   start/end  —— 说明符本身。静态 import 的区间不含引号，动态 import 的区间含引号；
      //                 所以静态改写用 start-1..end+1、动态直接用 start..end（见下方 overwrite）。
      //   expStart/expEnd —— 整条语句/表达式的区间：静态是整个 import 语句（用于删 import attributes、
      //                 做命名导入 interop 的整体替换），动态是整个 import(...) 表达式。
      await Promise.all(
        imports.map(async (importSpecifier, index) => {
          const {
            start,
            end,
            importStart: expStart,
            importEnd: expEnd,
          } = importSpecifier

          // #2083 User may use escape path, so use the decoded specifier.
          // glob 形式的动态 import（import.meta.glob 未被处理时的形态）没有单一说明符，
          // 统一置 undefined，后面走「无法分析」的告警分支。
          let specifier =
            importSpecifier.type === 'dynamic' && importSpecifier.glob
              ? undefined
              : (importSpecifier.specifier ?? undefined)

          const rawUrl = source.slice(start, end)

          // import.meta 是独立的一类记录：它不是「导入某个模块」，而是要在源码里
          // 找出 .hot / .env 的用法，决定是否注入 HMR 运行时与 env 对象。
          // check import.meta usage
          if (importSpecifier.type === 'import-meta') {
            const prop = source.slice(end, end + 4)
            if (prop === '.hot') {
              hasHMR = true
              // 兼容 `import.meta.hot?.accept`：可选链多一个 '?'，跳过它才能对齐 .accept 的位置。
              const endHot = end + 4 + (source[end + 4] === '?' ? 1 : 0)
              if (source.slice(endHot, endHot + 7) === '.accept') {
                // further analyze accepted modules
                // acceptExports 必须在 accept 之前判断：'.acceptExports' 的前缀也是 '.accept'，
                // 顺序颠倒会把 acceptExports 误判成 accept。
                if (source.slice(endHot, endHot + 14) === '.acceptExports') {
                  const importAcceptedExports = (orderedAcceptedExports[index] =
                    new Set<string>())
                  // 从 '(' 之后开始词法扫描，收集 acceptExports('a','b') 中的字符串字面量。
                  // lexAcceptedHmrExports 内部复用 lexAcceptedHmrDeps，只取 url 部分。
                  lexAcceptedHmrExports(
                    source,
                    source.indexOf('(', endHot + 14) + 1,
                    importAcceptedExports,
                  )
                  isPartiallySelfAccepting = true
                } else {
                  const importAcceptedUrls = (orderedAcceptedUrls[index] =
                    new Set<UrlPosition>())
                  // 注意返回值语义容易读反：返回 true 表示「第一个实参是回调或没有实参」，
                  // 即 accept(cb) / accept() —— 模块自己处理更新，等价于 self-accepting；
                  // 返回 false 表示实参是字符串或字符串数组（依赖级 accept）。
                  if (
                    lexAcceptedHmrDeps(
                      source,
                      source.indexOf('(', endHot + 7) + 1,
                      importAcceptedUrls,
                    )
                  ) {
                    isSelfAccepting = true
                  }
                }
              }
            } else if (prop === '.env') {
              hasEnv = true
            }
            return
          } else if (templateLiteralRE.test(rawUrl)) {
            // If the import has backticks but isn't transformed as a glob import
            // (as there's nothing to glob), check if it's simply a plain string.
            // If so, we can replace the specifier as a plain string to prevent
            // an incorrect "cannot be analyzed" warning.
            // 只有「不含 ${} 插值」的模板串才安全降级为普通字符串；
            // 含插值的必须保持 undefined，否则会把运行时才能确定的路径当成静态路径解析。
            if (!(rawUrl.includes('${') && rawUrl.includes('}'))) {
              specifier = rawUrl.replace(templateLiteralRE, '$1')
            }
          }

          const isDynamicImport = importSpecifier.type === 'dynamic'

          // strip import attributes as we can process them ourselves
          // 例：import data from './a.json' with { type: 'json' }
          // json 由 nativeJsonPlugin 处理，attributes 若留在代码里会让浏览器再次校验并报错；
          // 这里删掉说明符之后到语句结束之间的部分（含 with 子句），注意在改写说明符之前执行也可以，
          // 因为两段区间相邻但不重叠（end+1..expEnd 与 start-1..end+1）。
          if (!isDynamicImport && importSpecifier.attributesStart > -1) {
            str().remove(end + 1, expEnd)
          }

          // static import or valid string in dynamic import
          // If resolvable, let's resolve it
          if (specifier !== undefined) {
            const resolved = await resolveImport(specifier, start)
            // external 的说明符一般保持原样；只有解析器把它改写成了别的形式（例如别名指向远程 URL、
            // 或 ssr 下被标记为 external 的包名 → 实际 id）才覆盖，且要整体带上引号：
            // 静态 import 覆盖 start-1..end+1（含两侧引号），动态 import 的 start..end 本就含引号。
            // contentOnly: true 让 MagicString 只替换内容、不改动已记录的原始映射/换行信息。
            if (resolved?.external) {
              if (resolved.id !== specifier) {
                str().overwrite(
                  isDynamicImport ? start : start - 1,
                  isDynamicImport ? end : end + 1,
                  JSON.stringify(resolved.id),
                  { contentOnly: true },
                )
              }
              return
            }
            const id = resolved?.id
            // moduleUrl 是 ModuleURL；browserUrl 才是写进代码的形态（加 base、虚拟 id 包成 /@id/）。
            // ssr 不加 base：服务端按 URL 取模块时用的是无 base 的 ModuleURL。
            const { moduleUrl } = await getImportModule(
              specifier,
              resolved,
              start,
            )
            const browserUrl = resolved
              ? moduleUrlToBrowserUrl(moduleUrl, ssr ? '' : base)
              : specifier
            // 把「由 import 解析出来的真实 id」登记到 safeModulePaths，
            // 供静态文件中间件判断「这个路径是模块系统认可的」从而放行 fs 访问
            // （见 server/middlewares/static.ts 的 isFileLoadingAllowed 与 SafeModulePaths）。
            if (id != null) {
              environment.safeModulePaths.addId(id)
            }

            // 只有 URL 真的变了才写 MagicString；没变就完全不动，避免无谓的映射开销。
            if (browserUrl !== specifier) {
              let rewriteDone = false
              // optimizer-emitted imports resolve to the sibling file they
              // name; imports injected by plugins (e.g. @rollup/plugin-inject)
              // still need interop
              // 预构建产物内部的相对 import 指向同目录的 sibling 文件，这些文件本身已是 ESM 中间格式，
              // 不需要再做 cjs 命名导入 interop；但「插件注入到预构建文件里的 import」仍需 interop。
              // 用「importer 是预构建文件 且 说明符以 . 开头」来区分这两种来源。
              const isOptimizerEmittedImport =
                depsOptimizer?.isOptimizedDepFile(importer) &&
                specifier[0] === '.'
              if (
                !isOptimizerEmittedImport &&
                id != null &&
                depsOptimizer?.isOptimizedDepFile(id) &&
                !optimizedDepChunkRE.test(id)
              ) {
                // for optimized cjs deps, support named imports by rewriting named imports to const assignments.
                // internal optimized chunks don't need es interop and are excluded

                // The browserHash in the resolved ID could be stale in which case there will be a full
                // page reload. We could return a 404 in that case but it is safe to return the request
                // 用 cleanUrl 去掉 ?v=hash 再查 metadata：metadata 的 key 是磁盘文件路径，
                // 带 hash 的 id 查不到（hash 只是浏览器缓存键）。
                const file = cleanUrl(id) // Remove ?v={hash}

                const depInfo = optimizedDepInfoFromFile(
                  depsOptimizer.metadata,
                  file,
                )
                // needsInterop 由 optimizer 在预构建时扫描 cjs 的导出形态得到：
                // true = 该依赖是 CJS 且需要把 named import 改写成属性访问；
                // undefined = metadata 里没有它的记录（通常是依赖内部的动态入口）。
                const needsInterop = await optimizedDepNeedsInterop(
                  environment,
                  depsOptimizer.metadata,
                  file,
                )

                if (needsInterop === undefined) {
                  // Non-entry dynamic imports from dependencies will reach here as there isn't
                  // optimize info for them, but they don't need es interop. If the request isn't
                  // a dynamic import, then it is an internal Vite error
                  // 这里只记录错误日志、不改写代码：静态 import 缺 metadata 属于 Vite 内部错误；
                  // 但为了不让 dev 直接崩溃，仍继续走普通 URL 改写。
                  if (depInfo?.isDynamicEntry) {
                    config.logger.error(
                      colors.red(
                        `Vite Error, ${browserUrl} optimized info should be defined`,
                      ),
                    )
                  }
                } else if (needsInterop) {
                  debug?.(`${browserUrl} needs interop`)
                  // 把 import { a, b } from 'cjs' 改写成「先 import 整个对象，再取属性」，
                  // 并标记 rewriteDone，避免后面再按普通字符串覆盖同一个区间。
                  interopNamedImports(
                    str(),
                    importSpecifier,
                    browserUrl,
                    index,
                    importer,
                    isDynamicImport
                      ? isNodeModeForDynamicImport()
                      : isNodeMode(),
                    config,
                  )
                  rewriteDone = true
                }
              }
              // If source code imports builtin modules via named imports, the stub proxy export
              // would fail as it's `export default` only. Apply interop for builtin modules to
              // correctly throw the error message.
              // 客户端里 node: 内置模块被 resolve 成 browserExternalId 开头的空壳模块（export default），
              // 若源码写了命名导入，直接用会得到 undefined；先做一次 interop 让运行时报出清晰错误。
              // `source.slice(expStart, start).includes('{')` 即判断「有没有花括号形式的命名导入」。
              else if (
                id?.startsWith(browserExternalId) &&
                source.slice(expStart, start).includes('{')
              ) {
                interopNamedImports(
                  str(),
                  importSpecifier,
                  browserUrl,
                  index,
                  importer,
                  isNodeMode(),
                  config,
                )
                rewriteDone = true
              }
              if (!rewriteDone) {
                // 兜底路径：把说明符整段替换成新的 BrowserURL。
                // 依然保持 ±1 的引号规则，并用 contentOnly 保住原格式，便于行号/映射稳定。
                const rewrittenUrl = JSON.stringify(browserUrl)
                const s = isDynamicImport ? start : start - 1
                const e = isDynamicImport ? end : end + 1
                str().overwrite(s, e, rewrittenUrl, {
                  contentOnly: true,
                })
              }
            }

            // record for HMR import chain analysis
            // This check is needed until all remote and data URLs are marked
            // external during resolution and skipped before reaching here.
            // 只把本地模块记入依赖图：远程 URL/data URL 不在模块图里，也不应触发 HMR 回溯。
            // 注意记录的是 moduleUrl（可能带 ?t=/?import），用于后续 ensureEntryFromUrl 查回模块节点。
            const isLocalImport =
              !isExternalUrl(moduleUrl) && !isDataUrl(moduleUrl)
            if (isLocalImport) {
              orderedImportedUrls[index] = moduleUrl
            }

            // partial accept 需要知道「从该依赖导入了哪些名字」，这里顺手收集。
            if (enablePartialAccept && importedBindings) {
              extractImportedBindings(
                id ?? specifier,
                source,
                importSpecifier,
                importedBindings,
              )
            }

            // 静态本地 import 提前预热：让 deps optimizer 在浏览器真正请求前就开始 transform，
            // 从而在首个页面请求时已完成（warmupRequest 会登记到 transformRequest 等待集合）。
            // 必须去掉 ?import：那是给浏览器/中间件看的，文件系统与 transform 缓存键不该包含它。
            if (
              !isDynamicImport &&
              isLocalImport &&
              environment.config.dev.preTransformRequests
            ) {
              // pre-transform known direct imports
              // These requests will also be registered in transformRequest to be awaited
              // by the deps optimizer
              const url = removeImportQuery(moduleUrl)
              environment.warmupRequest(url)
            }
          } else if (!importer.startsWith(withTrailingSlash(clientDir))) {
            // 走到这里说明 specifier 为 undefined：说明符在运行时才能拼出来（或 glob 未展开）。
            // /@vite/client 自身与 node_modules 里的代码不做告警（客户端代码里本就有大量运行时 import）。
            if (!isInNodeModules(importer)) {
              const dynamicIndex = isDynamicImport
                ? importSpecifier.dynamicStart
                : -1
              // check @vite-ignore which suppresses dynamic import warning
              // 注意注释检查的范围是「括号内整个表达式」，不是说明符本身：
              // `import(/* @vite-ignore */ foo)` 的注释位于说明符之前。
              const hasViteIgnore = hasViteIgnoreRE.test(
                // complete expression inside parens
                source.slice(dynamicIndex + 1, end),
              )
              if (!hasViteIgnore) {
                // 这条告警不是错误：运行时拼接的 URL 依然可用，只是 Vite 无法预解析它
                // （不会进入模块图，也不会触发依赖发现/预构建）。
                this.warn(
                  `\n` +
                    colors.cyan(importerModule.file) +
                    `\n` +
                    colors.reset(generateCodeFrame(source, start, end)) +
                    colors.yellow(
                      `\nThe above dynamic import cannot be analyzed by Vite.\n` +
                        `See ${colors.blue(
                          `https://vite.dev/guide/features#dynamic-import`,
                        )} ` +
                        `for supported dynamic import formats. ` +
                        `If this is intended to be left as-is, you can use the ` +
                        `/* @vite-ignore */ comment inside the import() call to suppress this warning.\n`,
                    ),
                )
              }
            }

            // 客户端才需要补 ?import：
            //  - 实参不是纯字符串（运行时才确定）→ 无法在上面的解析路径里加查询串，只能运行时包一层；
            //  - 实参是纯字符串但类型非 js/css（例如 .png）→ 同样需要 ?import 才会被 transform。
            // 覆盖区间是 start..end（动态 import 的区间含引号），所以 rawUrl 可以直接作为实参复用。
            // 标记 needQueryInjectHelper，稍后统一注入 helper（classic worker 内联实现，其余从 /@vite/client 导入）。
            if (!ssr) {
              if (
                !urlIsStringRE.test(rawUrl) ||
                isExplicitImportRequired(rawUrl.slice(1, -1))
              ) {
                needQueryInjectHelper = true
                str().overwrite(
                  start,
                  end,
                  `__vite__injectQuery(${rawUrl}, 'import')`,
                  { contentOnly: true },
                )
              }
            }
          }
        }),
      )

      // 合并并发收集的结果。两套集合的差别只在时间戳：
      //   importedUrls —— 带 `?t=`，用于让浏览器拿到 HMR 后的新版本；
      //   staticImportedUrls —— 去掉 `?t=`，因为模块图里比较的是 mod.url（无时间戳），
      //   见 moduleGraph.invalidateModule 里 `importer.staticImportedUrls?.has(mod.url)` 的软失效判断。
      const _orderedImportedUrls = orderedImportedUrls.filter(isDefined)
      const importedUrls = new Set(_orderedImportedUrls)
      // `importedUrls` will be mixed with watched files for the module graph,
      // `staticImportedUrls` will only contain the static top-level imports and
      // dynamic imports
      const staticImportedUrls = new Set(
        _orderedImportedUrls.map((url) => removeTimestampQuery(url)),
      )
      // 一个文件里可能有多处 accept/acceptExports，这里扁平化成全局集合；
      // 位置信息（start/end）保留下来，后面要把 accept('x') 里的字符串改写成 ModuleURL。
      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls)
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports)

      // While we always expect to work with ESM, a classic worker is the only
      // case where it's not ESM and we need to avoid injecting ESM-specific code
      // classic worker（worker.ts 生成的 `?worker_file&type=classic`）不支持 import 语句/
      // import.meta，因此下面所有 prepend/append 的 ESM 注入都要跳过，改用内联实现。
      const isClassicWorker =
        importer.includes(WORKER_FILE_ID) && importer.includes('type=classic')

      if (hasEnv && !isClassicWorker) {
        // inject import.meta.env
        // 前置注入：放在文件最前面，保证后续代码读取 import.meta.env 时对象已就绪。
        // prepend 不影响源码原有偏移量的映射（MagicString 会分别记录两段）。
        str().prepend(getEnv(ssr))
      }

      if (hasHMR && !ssr && !isClassicWorker) {
        // HMR 只在 client 注入；ssr 下 import.meta.hot 无意义，classic worker 用不了 import 语句。
        // createHotContext 来自 /@vite/client（clientPublicPath），并把 importerModule.url（ModuleURL，
        // 不带 base/时间戳）作为该模块的 HMR 身份，服务端推送更新时按这个 url 匹配。
        debugHmr?.(
          `${
            isSelfAccepting
              ? `[self-accepts]`
              : isPartiallySelfAccepting
                ? `[accepts-exports]`
                : acceptedUrls.size
                  ? `[accepts-deps]`
                  : `[detected api usage]`
          } ${prettifyUrl(importer, root)}`,
        )
        // inject hot context
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              importerModule.url,
            )});`,
        )
      }

      if (needQueryInjectHelper) {
        // classic worker 不能 import，直接把 helper 的函数源码 append 到文件末尾
        // （函数声明有提升，运行时调用没问题）；普通模块则从 /@vite/client 导入，避免重复代码。
        if (isClassicWorker) {
          str().append('\n' + __vite__injectQuery.toString())
        } else {
          str().prepend(
            `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}";`,
          )
        }
      }

      // normalize and rewrite accepted urls
      // 这一步是 HMR 的「第二遍改写」：前面主循环只收集了 accept('...') 里的原始字符串，
      // 这里才真正解析它们，并把字符串替换成模块图里的 ModuleURL（mod.url）。
      // 为什么不用 browserUrl：HMR 客户端与服务端都用 ModuleURL 作为模块身份
      // （/@vite/client 的 createHotContext 收到的也是 importerModule.url），
      // 写成带 base 的浏览器 URL 会导致服务端推送更新时匹配不上。
      // 失败模式：解析不到或解析成 external 时直接报错——HMR 无法跟踪远程模块。
      const normalizedAcceptedUrls = new Set<string>()
      for (const { url, start, end } of acceptedUrls) {
        const resolved = await resolveId(url, start).catch(() => null)
        if (!resolved || resolved.external) {
          this.error({
            message: `Failed to resolve ${JSON.stringify(url)} from ${importer}.`,
            pos: start,
          })
        }
        const { module: mod } = await getImportModule(url, resolved, start)
        if (!mod) {
          this.error(
            `module was not found for ${JSON.stringify(resolved.id)}`,
            start,
          )
        }
        normalizedAcceptedUrls.add(mod.url)
        str().overwrite(start, end, JSON.stringify(mod.url), {
          contentOnly: true,
        })
      }

      // update the module graph for HMR analysis.
      // node CSS imports does its own graph update in the css-analysis plugin so we
      // only handle js graph updates here.
      // note that we want to handle .css?raw and .css?url here
      // 为什么排除 CSS：css-analysis 插件会把 @import/url() 解析成模块依赖，两处都改会重复/冲突；
      // 但 ?raw / ?url 等特殊查询的 CSS 被当作 JS 模块处理，仍归本插件管。
      if (!isCSSRequest(importer) || SPECIAL_QUERY_RE.test(importer)) {
        // attached by pluginContainer.addWatchFile
        // 插件可以通过 this.addWatchFile(specifier) 声明「额外依赖」，pluginContainer 会把它记进
        // _addedImports（见 server/pluginContainer.ts）。它们不是源码里的 import，
        // 但必须进模块图/importedUrls，否则文件变化时无法触发该模块的 HMR。
        // forceSkipImportAnalysis=true：这些依赖不需要再被本插件改写一遍。
        const pluginImports = (this as unknown as TransformPluginContext)
          ._addedImports
        if (pluginImports) {
          const modules = await Promise.all(
            [...pluginImports].map(async (specifier) => {
              const resolved = await resolveId(specifier, 0)
              if (resolved?.external) return
              const { moduleUrl } = await getImportModule(
                specifier,
                resolved,
                0,
                true,
              )
              return moduleUrl
            }),
          )
          for (const mod of modules) {
            if (mod != null) importedUrls.add(mod)
          }
        }
        // HMR transforms are no-ops in SSR, so an `accept` call will
        // never be injected. Avoid updating the `isSelfAccepting`
        // property for our module node in that case.
        // 但 SSR 下若模块此前已被标记为 self-accepting，要继承下来，否则模块图会把状态改坏。
        if (ssr && importerModule.isSelfAccepting) {
          isSelfAccepting = true
        }
        // a partially accepted module that accepts all its exports
        // behaves like a self-accepted module in practice
        // 只有当 acceptExports 覆盖了该模块的全部导出名时，才等价于自接受；
        // 覆盖不全是「部分自接受」，HMR 仍需把更新继续往外传播。
        if (
          !isSelfAccepting &&
          isPartiallySelfAccepting &&
          acceptedExports.size >= exportNames.length &&
          exportNames.every((name) => acceptedExports.has(name))
        ) {
          isSelfAccepting = true
        }
        // updateModuleInfo 的七个参数依次是：模块、importedUrls（含 ?t=）、
        // importedBindings（partial accept 用）、acceptedUrls（accept 依赖）、
        // acceptedExports、isSelfAccepting、staticImportedUrls（软失效用）。
        // 返回的 prunedImports 是「本次不再被任何模块 import」的节点，
        // 交给 handlePrunedModules 清理（可能是释放内存/移除监听，见 server/hmr.ts）。
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule,
          importedUrls,
          importedBindings,
          normalizedAcceptedUrls,
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting,
          staticImportedUrls,
        )
        if (prunedImports) {
          handlePrunedModules(prunedImports, environment)
        }
      }

      debug?.(
        `${timeFrom(msAtStart)} ${colors.dim(
          `[${importedUrls.size} imports rewritten] ${prettifyUrl(
            importer,
            root,
          )}`,
        )}`,
      )

      // 返回值的两种形态：
      //   s 存在 —— 有改写，交给 transformStableResult：dev 下 map 为 null（行号未变，无需映射），
      //     其内部对 build.sourcemap 的处理只为兼容极端情况；上游插件的 map 由 pluginContainer
      //     收集进 sourcemapChain 并用 combineSourcemaps 合并（见 server/pluginContainer.ts 的
      //     TransformPluginContext.getCombinedSourcemap），本插件不参与 map 串联。
      //   s 不存在 —— 说明一条 import 都没被改写，直接返回原文（模块图已经更新过）。
      if (s) {
        return transformStableResult(s, importer, config)
      } else {
        return source
      }
    },
  }
}

// 把「按 import 索引收集的多组集合」拍平成一个集合。
// 调用点：本文件 transform 中合并 orderedAcceptedUrls / orderedAcceptedExports。
// 之所以要分组合并而不是共享一个 Set：并发任务写共享 Set 会丢失「位置+来源」的对应关系，
// 且 accept 的重复项只有在这里才方便去重。
function mergeAcceptedUrls<T>(orderedUrls: Array<Set<T> | undefined>) {
  const acceptedUrls = new Set<T>()
  for (const urls of orderedUrls) {
    if (!urls) continue
    for (const url of urls) acceptedUrls.add(url)
  }
  return acceptedUrls
}

// 解析失败时生成「人话」提示：区分 .vue 缺插件 / JSX 后缀写错 / 资源未加入 assetsInclude。
// 调用点：本文件 transform 的 parseImports catch 分支。
// 关键参数：返回 showCodeFrame 表示是否展示代码帧——源码里出现 U+FFFD 替换字符时通常是二进制文件，
//   展示帧没有意义且会打印乱码，所以关闭。
// 注意：这里的文案是「诊断建议」，不是精确根因；例如 tsconfig 的 jsx: preserve 也会导致 JSX 未被转译。
export function createParseErrorInfo(
  importer: string,
  source: string,
): { message: string; showCodeFrame: boolean } {
  const isVue = importer.endsWith('.vue')
  const isJsx = importer.endsWith('.jsx') || importer.endsWith('.tsx')
  const maybeJSX = !isVue && isJSRequest(importer)
  const probablyBinary = source.includes(
    '\ufffd' /* unicode replacement character */,
  )

  const msg = isVue
    ? `Install @vitejs/plugin-vue to handle .vue files.`
    : maybeJSX
      ? isJsx
        ? `If you use tsconfig.json, make sure to not set jsx to preserve.`
        : `If you are using JSX, make sure to name the file with the .jsx or .tsx extension.`
      : `You may need to install appropriate plugins to handle the ${path.extname(
          importer,
        )} file format, or if it's an asset, add "**/*${path.extname(
          importer,
        )}" to \`assetsInclude\` in your configuration.`

  return {
    message:
      `Failed to parse source for import analysis because the content ` +
      `contains invalid JS syntax. ` +
      msg,
    showCodeFrame: !probablyBinary,
  }
}

// interopHelper 的唯一用途是「被 toString() 序列化后内联进浏览器代码」，因此：
//   - 不能引用任何外部变量/import（序列化后它们不存在）；
//   - 不能写 TS 注解/可选链等需要额外转译的语法（这里直接原样输出）；
//   - 参数名保持极短，减少生成代码体积。
// 语义：isNodeMode（导入方是 ESM）时直接返回 module.exports 并补一个 default；
//   否则若模块已有 __esModule 就原样返回，避免把 babel/esbuild 产物再包一层。
// interopHelperStr 预先去掉换行，保证内联到 `.then(m => ...)` 的单行表达式里不会破坏语句结构。
const interopHelper = (m: any, n: boolean) =>
  n || !m?.__esModule
    ? {
        ...((typeof m === 'object' && !Array.isArray(m)) ||
        typeof m === 'function'
          ? m
          : {}),
        default: m,
      }
    : m
const interopHelperStr = interopHelper.toString().replaceAll('\n', '')

// 对「需要 interop 的预构建 CJS 依赖」做说明符/语句级改写。
// 调用点：本文件 transform 里两处（optimized dep 需要 interop、node 内置模块的命名导入），
//   以及 __tests__/plugins/import.spec.ts 直接调用。
// 关键参数：importIndex 用于生成唯一的临时变量名（同一文件多次 import 同一依赖时避免重名）；
//   isNodeMode 决定 default 取值语义（见 transformCjsImport）。
// 失败模式：transformCjsImport 返回 undefined（如 export * from）时退化成只改写 URL 字符串，
//   并在 serve 阶段给出「可能丢失导出」的警告。
export function interopNamedImports(
  str: MagicString,
  importSpecifier: Import,
  rewrittenUrl: string,
  importIndex: number,
  importer: string,
  isNodeMode: boolean,
  config: ResolvedConfig,
): void {
  const source = str.original
  const {
    start,
    end,
    importStart: expStart,
    importEnd: expEnd,
  } = importSpecifier
  const exp = source.slice(expStart, expEnd)
  if (importSpecifier.type === 'dynamic') {
    // rewrite `import('package')` to expose the default directly
    // 动态 import 用整表达式替换：先拿到预构建模块的 default（即 CJS 的 module.exports），
    // 再用 interopHelper 归一化成 { ...exports, default }，让 `const m = await import('pkg')`
    // 同时能用 m.default 和 m.xxx。getLineBreaks 补回原表达式的换行数，保持行号。
    str.overwrite(
      expStart,
      expEnd,
      `import(${JSON.stringify(rewrittenUrl)}).then(m => (${interopHelperStr})(m.default, ${+isNodeMode}))` +
        getLineBreaks(exp),
      { contentOnly: true },
    )
  } else {
    const rawUrl = source.slice(start, end)
    const rewritten = transformCjsImport(
      exp,
      rewrittenUrl,
      rawUrl,
      importIndex,
      importer,
      isNodeMode,
      config,
    )
    if (rewritten) {
      // 整条 import 语句替换成「默认导入整个模块」的一行；
      // 依赖的取值语句（const x = __vite__cjsImport0_[...]）不能就地插在 import 位置，
      // 因为 ES 的 import 声明会提升到模块顶部，就地插入会让「先使用后赋值」的代码改变语义，
      // 所以统一放到文件最前面（hoistedAssignments）。
      str.overwrite(
        expStart,
        expEnd,
        rewritten.importLine + getLineBreaks(exp),
        { contentOnly: true },
      )
      if (rewritten.hoistedAssignments) {
        // getFileStartIndex 会跳过 shebang（#!/usr/bin/env node），
        // 否则插入的语句会跑到 #! 行之前导致语法错误。
        str.appendLeft(
          getFileStartIndex(source),
          rewritten.hoistedAssignments + ';',
        )
      }
    } else {
      // #1439 export * from '...'
      // export * 无法安全拆解（不知道具体导出名），只改写 URL；此时可能丢失导出，
      // 警告已在 transformCjsImport 内发出。
      str.overwrite(
        start - 1,
        end + 1,
        JSON.stringify(rewrittenUrl) + getLineBreaks(source.slice(start, end)),
        {
          contentOnly: true,
        },
      )
    }
  }
}

// get line breaks to preserve line count for not breaking source maps
// 用等量换行填充被替换文本，保证替换前后行号一致；
// 这是本插件「dev 下可以不生成 sourcemap」的前提，缺少它会使错误堆栈/断点行号错位。
function getLineBreaks(str: string) {
  return str.includes('\n') ? '\n'.repeat(str.split('\n').length - 1) : ''
}

type ImportNameSpecifier = { importedName: string; localName: string }

/**
 * Detect import statements to a known optimized CJS dependency and provide
 * ES named imports interop. We do this by rewriting named imports to a variable
 * assignment to the corresponding property on the `module.exports` of the cjs
 * module. Note this doesn't support dynamic re-assignments from within the cjs
 * module.
 *
 * Note that es-module-lexer treats `export * from '...'` as an import as well,
 * so, we may encounter ExportAllDeclaration here, in which case `undefined`
 * will be returned.
 *
 * Credits \@csr632 via #837
 */
// transformCjsImport：把一条静态 import/export 语句改写成「默认导入 + 取值赋值」。
// 调用点：本文件 interopNamedImports 的静态分支；测试 __tests__/plugins/import.spec.ts 直接调用。
// 关键参数：importExp 是原始语句文本；url 是已改写的 BrowserURL；rawUrl 是原始说明符（用于生成变量名与告警）；
//   importIndex 保证同一文件多条语句的临时变量名不冲突。
// 实现变化：这里用 rolldown 的 parseAst 只解析这一条语句（不是整个文件，也不是 esbuild/acorn），
//   因为此刻只需要 specifiers 结构，AST 结果用完即弃。
// 失败模式：语句类型不是 Import/ExportNamed（典型是 export * from）时返回 undefined，
//   调用方退化为「只改 URL」，并在 serve 下提示可能丢失导出。
export function transformCjsImport(
  importExp: string,
  url: string,
  rawUrl: string,
  importIndex: number,
  importer: string,
  isNodeMode: boolean,
  config: ResolvedConfig,
): { importLine: string; hoistedAssignments?: string } | undefined {
  // 只解析这一条语句，body[0] 即目标声明节点；用 rolldown 的 parseAst 而不是
  // es-module-lexer：后者给不出 specifier 结构（谁 import 了哪个名字）。
  const node = parseAst(importExp).body[0]

  // `export * from '...'` may cause unexpected problem, so give it a warning
  // export * 无法枚举导出名，只能保留 URL（见调用方的退化分支）；这里在 dev 明确提示用户。
  // 条件是 node.exported 为空：`export * as ns from` 有 exported，可以按命名空间处理。
  if (
    config.command === 'serve' &&
    node.type === 'ExportAllDeclaration' &&
    !node.exported
  ) {
    config.logger.warn(
      colors.yellow(
        `\nUnable to interop \`${importExp}\` in ${importer}, this may lose module exports. Please export "${rawUrl}" as ESM or use named exports instead, e.g. \`export { A, B } from "${rawUrl}"\``,
      ),
    )
  } else if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration'
  ) {
    if (!node.specifiers.length) {
      // 无 specifier 的裸 import（`import './a.css'` / 副作用导入）只需改 URL，不需要取值语句。
      return { importLine: `import ${JSON.stringify(url)}` }
    }

    // 逐个 specifier 拆成「要从 cjs 模块取哪个属性」和「本地绑定叫什么」。
    // 同一个 import 语句里可能同时出现默认/命名/命名空间导入，甚至 re-export（export { a } from 'cjs'），
    // 所以下面的分支要按 ESTree 的 specifier 类型分别处理，不能只考虑 ImportSpecifier。
    const importNames: ImportNameSpecifier[] = []
    const exportNames: string[] = []
    let defaultExports: string = ''
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        const importedName = getIdentifierNameOrLiteralValue(spec.imported)
        const localName = spec.local.name
        importNames.push({ importedName, localName })
      } else if (spec.type === 'ImportDefaultSpecifier') {
        importNames.push({
          importedName: 'default',
          localName: spec.local.name,
        })
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        importNames.push({ importedName: '*', localName: spec.local.name })
      } else if (spec.type === 'ExportSpecifier') {
        // for ExportSpecifier, local name is same as imported name
        // prefix the variable name to avoid clashing with other local variables
        // 这里是 `export { a } from 'cjs'` 的形态：没有本地绑定，所以要自己造一个中转变量名。
        // 默认导出（export { default } from）必须给一个可引用的名字，用 importIndex 保证唯一；
        // 字符串形式的导出名（export { "a-b" }）不能作为标识符，改用 getHash 生成 `L_<hash>`，
        // 否则生成的代码会直接语法错误（这也是 exportNames 里 Literal 要 JSON.stringify 的原因）。
        const importedName = getIdentifierNameOrLiteralValue(spec.local)
        // we want to specify exported name as variable and re-export it
        const exportedName = getIdentifierNameOrLiteralValue(spec.exported)
        if (exportedName === 'default') {
          defaultExports = makeLegalIdentifier(
            `__vite__cjsExportDefault_${importIndex}`,
          )
          importNames.push({ importedName, localName: defaultExports })
        } else {
          const localName = `__vite__cjsExport${
            spec.exported.type === 'Literal'
              ? `L_${getHash(spec.exported.value)}`
              : 'I_' + spec.exported.name
          }`
          importNames.push({ importedName, localName })
          exportNames.push(
            `${localName} as ${spec.exported.type === 'Literal' ? JSON.stringify(exportedName) : exportedName}`,
          )
        }
      }
    }

    // If there is multiple import for same id in one file,
    // importIndex will prevent the cjsModuleName to be duplicate
    // makeLegalIdentifier 负责把 `./foo-bar.js`、`lodash/fp` 这类字符转成合法标识符；
    // importIndex 不可省：同一文件里两次 import 同一个包时，仅靠 rawUrl 会生成同名变量。
    const cjsModuleName = makeLegalIdentifier(
      `__vite__cjsImport${importIndex}_${rawUrl}`,
    )
    const importLine = `import ${cjsModuleName} from ${JSON.stringify(url)}`
    // 取值语句的语义要点：
    //   - 命名空间导入用 interopHelper 包装，保证 `import * as ns` 既有 ns.xxx 也有 ns.default；
    //   - 默认导入分两种：node 模式（导入方是 ESM）直接取 module.exports；
    //     非 node 模式则尊重 __esModule，兼容 babel/esbuild 产物的默认导出约定；
    //   - 命名导入直接按属性访问：预构建产物已把 CJS 的 module.exports 属性原样暴露。
    const lines: string[] = []
    importNames.forEach(({ importedName, localName }) => {
      if (importedName === '*') {
        lines.push(
          `const ${localName} = (${interopHelperStr})(${cjsModuleName}, ${+isNodeMode})`,
        )
      } else if (importedName === 'default') {
        if (isNodeMode) {
          lines.push(`const ${localName} = ${cjsModuleName}`)
        } else {
          lines.push(
            `const ${localName} = !${cjsModuleName}.__esModule ? ${cjsModuleName} : ${cjsModuleName}.default`,
          )
        }
      } else {
        lines.push(
          `const ${localName} = ${cjsModuleName}[${JSON.stringify(importedName)}]`,
        )
      }
    })
    if (defaultExports) {
      lines.push(`export default ${defaultExports}`)
    }
    if (exportNames.length) {
      lines.push(`export { ${exportNames.join(', ')} }`)
    }

    // 返回的两个片段职责不同：importLine 替换原 import 语句，hoistedAssignments 由调用方
    // 插到文件最前面。两者都在模块顶层，配合 ESM「先建立 import 绑定、再执行语句」的语义，
    // 保证变量在被任何代码使用前完成赋值。
    return { importLine, hoistedAssignments: lines.join('; ') }
  }
}

// 读取导出名：标识符取 name，字符串字面量导出名（export { x as "a-b" }）取 value。
// 调用点：本文件 transformCjsImport 内部；只服务于 CJS 命名导入的改写。
function getIdentifierNameOrLiteralValue(node: ESTree.ModuleExportName) {
  return node.type === 'Identifier' ? node.name : node.value
}

// Copied from `client/client.ts`. Only needed so we can inline inject this function for classic workers.
// 作用：给 URL 追加查询串（如 import），同时保留原有 query/hash。
// 调用点：普通模块从 /@vite/client 导入同名实现（本文件 needQueryInjectHelper 的 prepend 分支）；
//   classic worker 则由本文件 append 这个函数的源码，运行时通过 __vite__injectQuery(...) 使用。
// 关键点：
//   - 以 . 或 / 开头以外的 URL（裸模块名、http(s)）直接返回，Vite 不会处理它们；
//   - 不能直接用 new URL(url).pathname，因为 url 可能是 `../a.png` 这类相对路径，
//     单独解析会失败或得到错误路径，所以先用正则剥掉 ?/# 再自行拼接；
//   - 该函数会被 toString 内联到 worker 产物里，因此不能引用任何外部变量。
function __vite__injectQuery(url: string, queryToInject: string): string {
  // skip urls that won't be handled by vite
  if (url[0] !== '.' && url[0] !== '/') {
    return url
  }

  // can't use pathname from URL since it may be relative like ../
  const pathname = url.replace(/[?#].*$/, '')
  const { search, hash } = new URL(url, 'http://vite.dev')

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ''}${
    hash || ''
  }`
}
