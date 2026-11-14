// ---------------------------------------------------------------------------
// 文件角色：依赖预构建（optimizeDeps）链路的第一段——「扫描」。
// 上游：optimizer/index.ts 的 discoverProjectDependencies() 调 scanImports()；
//       dev 下 optimizer/optimizer.ts 用 devToScanEnvironment() 包一层真实
//       DevEnvironment 后再交给 discoverProjectDependencies()。
// 下游：computeEntries() 找入口 → prepareRolldownScanner() 组装插件 →
//       `rolldown/experimental` 的 scan() 跑一遍「只解析、不打包」的构建。
//       所有 resolveId 请求都转发给 environment.pluginContainer.resolveId()，
//       也就是复用正常 dev 的插件链（resolve / alias / tsconfig paths 都在那）。
// 产出：deps { 裸包说明符 -> 磁盘绝对路径 }、missing { 解析失败的说明符 -> importer }。
//       这两个表是后续 runOptimizeDeps() 决定「预打包谁」的唯一输入。
// 关键不变量：
//   1) 扫描只关心模块图拓扑，不产出 bundle 代码，也不写任何缓存文件；
//   2) 一旦某个说明符被判定为「依赖」，就 external 掉并停止向下 crawl；
//   3) HTML/Vue/Svelte/Astro 被当作「入口文档」，load 钩子会把它重写成一段 JS。
// 扫什么：从入口出发能到达的、node_modules 之外的 JS/TS/JSX/TSX 与同类文档，
//   目的是找出它们 import 了哪些「裸包」。
// 不扫什么：CDN/data URL、虚拟模块、CSS、json/wasm、静态资源、?worker/?raw，
//   以及 node_modules 内的实现细节（命中即 external，不再深入）。
// 易误解点：
//   - 这里已经没有 esbuild 了：转译走 oxc（transformSync），图遍历走 rolldown 的 scan()；
//   - ScanEnvironment 是受限视图，没有 moduleGraph / depsOptimizer / watcher。
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import colors from 'picocolors'
import type { PartialResolvedId, Plugin } from 'rolldown'
import { scan } from 'rolldown/experimental'
import type { TransformOptions as OxcTransformOptions } from 'rolldown/utils'
import { transformSync } from 'rolldown/utils'
import { glob } from 'tinyglobby'
import { cleanUrl } from '../../shared/utils'
import { BaseEnvironment } from '../baseEnvironment'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import { transformGlobImport } from '../plugins/importMetaGlob'
import { getRollupJsxPresets } from '../plugins/oxc'
import type { DevEnvironment } from '../server/environment'
import type { EnvironmentPluginContainer } from '../server/pluginContainer'
import {
  ERR_CLOSED_SERVER,
  createEnvironmentPluginContainer,
} from '../server/pluginContainer'
import {
  arraify,
  asyncFlatten,
  createDebugger,
  dataUrlRE,
  deepClone,
  externalRE,
  isInNodeModules,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'

// ScanEnvironment 是「扫描专用」的 Environment 子类：
// 作用：只提供扫描需要的环境信息（name/config/plugins/pluginContainer），
//       刻意不暴露 moduleGraph、depsOptimizer、watcher —— 扫描不写模块图、不触发优化。
// 调用点：optimizer/index.ts 的 optimizeDeps() 中 `new ScanEnvironment('client', config)`；
//       dev 路径走 devToScanEnvironment()（见下方），并不 new 这个类。
// 关键参数：mode = 'scan'；它让插件里 `environment.mode === 'dev'` 的分支全部走 else，
//       于是 CSS/asset 等插件会返回「构建期」形态的结果，而不是 dev 的 HMR 版本。
// 失败模式：init() 之前访问 pluginContainer 会抛错；init() 是惰性且幂等的。
export class ScanEnvironment extends BaseEnvironment {
  mode = 'scan' as const

  get pluginContainer(): EnvironmentPluginContainer {
    if (!this._pluginContainer)
      throw new Error(
        `${this.name} environment.pluginContainer called before initialized`,
      )
    return this._pluginContainer
  }
  /**
   * @internal
   */
  _pluginContainer: EnvironmentPluginContainer | undefined

  async init(): Promise<void> {
    // 幂等：optimizeDeps() 与 dev 路径可能重复触发，重复调用直接返回。
    if (this._initiated) {
      return
    }
    this._initiated = true
    // watcher 传 undefined：扫描只读文件，不需要监听；
    // 第 4 个实参 autoStart=false：不在这里触发 buildStart/buildEnd，
    // 而是等第一次 resolveId 时由 pluginContainer 惰性触发（避免扫描没用上插件却跑了 buildStart）。
    this._pluginContainer = await createEnvironmentPluginContainer(
      this,
      this.plugins,
      undefined,
      false,
    )
  }
}

// 作用：把 dev 下真实的 DevEnvironment「降级」成一个只读视图，供扫描器使用。
// 调用点：optimizer/optimizer.ts 的 runOptimizeDeps() 内部，
//       `discoverProjectDependencies(devToScanEnvironment(environment))`。
// 关键参数：没有独立 config/plugins，全部透传给真实 environment，
//       唯独 mode 被覆盖成 'scan'、并隐藏 moduleGraph/depsOptimizer/watcher。
// 失败模式：因为是 `as unknown as ScanEnvironment` 的鸭子类型对象，
//       任何试图访问未列出成员（如 environment.moduleGraph）的代码会在运行时拿到 undefined。
// 为什么要这层：dev 下不能为扫描再建一套插件链（成本高且会重复 buildStart），
//       于是复用已有 pluginContainer，仅通过 mode 区分语义。
// Restrict access to the module graph and the server while scanning
export function devToScanEnvironment(
  environment: DevEnvironment,
): ScanEnvironment {
  return {
    mode: 'scan',
    get name() {
      return environment.name
    },
    getTopLevelConfig() {
      return environment.getTopLevelConfig()
    },
    get config() {
      return environment.config
    },
    get logger() {
      return environment.logger
    },
    get pluginContainer() {
      return environment.pluginContainer
    },
    get plugins() {
      return environment.plugins
    },
  } as unknown as ScanEnvironment
}

const debug = createDebugger('vite:deps')

// 哪些后缀算「入口文档」：它们自身不能被当 JS 解析，必须由 load 钩子拆出 <script>。
// 注意 vue/svelte/astro/imba 与 html 共享同一条处理路径，
// 所以下面 htmlTypeOnLoadCallback 里要按后缀决定 script 的过滤规则。
const htmlTypesRE = /\.(?:html|vue|svelte|astro|imba)$/

// 此正则只服务于「TS 片段里的 import 抽取」（extractImportPaths），不是通用 import 解析器。
// 与 es-module-lexer 的分工（Grep 确认）：
//   - 本文件/扫描阶段完全不用 es-module-lexer —— 模块图遍历由 rolldown 的 scan() 内部完成；
//   - es-module-lexer 只出现在 optimizer/index.ts（分析预打包产物的导出名）与
//     plugins/dynamicImportVars.ts（dev 下改写动态 import 变量）；
//   - 这里需要处理 TS 片段且只求「粗粒度补 import」，所以退化成一条正则最划算。
// 为什么不直接用 es-module-lexer：它不认 TS 语法；
// 为什么不用 oxc 的完整 AST：这里只需要粗粒度地补回可能被裁掉的 import，成本要低。
// 允许误报/漏报：漏掉的 import 运行时仍会被发现，误报的说明符会被后续 resolve 忽略。
// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE: RegExp =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type\b)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

// 作用：扫描阶段的对外入口，返回「可取消句柄 + 结果 Promise」，注意两者分离：
//       调用方可以先拿到 cancel 再 await result（dev 下就是这样在后台跑、关服时取消）。
// 调用点：本文件被 optimizer/index.ts 的 discoverProjectDependencies() 调用；
//       tests 侧由 __tests__/scan.spec.ts 直接调用。
// 关键参数：environment 必须是 ScanEnvironment（mode='scan'），它的 pluginContainer 提供解析能力。
// 失败模式：
//   - entries 为空 → 只 warn 不报错，返回 { deps: {}, missing: {} }；
//   - 解析出的说明符找不到 → 写入 missing，由上层抛「Are they installed?」；
//   - 服务在扫描期间被关闭 → rolldown 抛 ERR_CLOSED_SERVER，这里吞掉并返回 undefined。
export function scanImports(environment: ScanEnvironment): {
  cancel: () => Promise<void>
  result: Promise<{
    deps: Record<string, string>
    missing: Record<string, string>
  }>
} {
  const start = performance.now()
  const { config } = environment

  // 取消是「协作式」的：只置标志位，无法打断 rolldown 内部正在进行的解析，
  // 因此在每个长耗时 await 之后都要重新检查（见下面两处 `scanContext.cancelled`）。
  const scanContext = { cancelled: false }
  async function cancel() {
    scanContext.cancelled = true
  }

  async function scan() {
    const entries = await computeEntries(environment)
    // 没有入口时无法 crawl。若用户也没有显式 include/input，说明预构建大概率没意义，
    // 于是给出可操作的警告；有 include/input 时保持静默（用户已明确指定要打包什么）。
    if (!entries.length) {
      if (
        !config.optimizeDeps.entries &&
        !config.optimizeDeps.include &&
        !config.input
      ) {
        environment.logger.warn(
          colors.yellow(
            '(!) Could not auto-determine entry point from rolldownOptions or html files ' +
              'and there are no explicit optimizeDeps.include patterns. ' +
              'Skipping dependency pre-bundling.',
          ),
        )
      }
      return
    }
    // computeEntries 里可能发生大量 glob 与 resolveId，期间服务可能已关闭。
    if (scanContext.cancelled) return

    debug?.(
      `Crawling dependencies using entries: ${entries
        .map((entry) => `\n  ${colors.dim(entry)}`)
        .join('')}`,
    )
    // 两个表在 prepareRolldownScanner 里被插件闭包捕获并就地写入，
    // 所以 build() 返回后这里读到的就是最终结果，无需再汇总。
    const deps: Record<string, string> = {}
    const missing: Record<string, string> = {}

    const context = await prepareRolldownScanner(
      environment,
      entries,
      deps,
      missing,
    )
    if (scanContext.cancelled) return

    try {
      await context.build()
      return {
        // Ensure a fixed order so hashes are stable and improve logs
        deps: orderedDependencies(deps),
        missing,
      }
    } catch (e) {
      // The scanner runs in the background and may still be crawling when the
      // server is closed. In that case resolutions reject with
      // `ERR_CLOSED_SERVER` and the scan build fails.
      // 这类错误不是真失败：dev 重启/关闭时扫描本就会被丢弃，
      // 上层（optimizer.ts）会把它当作「没有发现依赖」继续走缓存路径。
      if (
        e.errors?.some(
          (error: { pluginCode?: string }) =>
            error.pluginCode === ERR_CLOSED_SERVER,
        )
      ) {
        return
      }
      // 其它错误补上入口列表再抛，便于用户定位是哪个 html/入口把扫描跑挂的。
      const prependMessage = colors.red(`\
  Failed to scan for dependencies from entries:
  ${entries.join('\n')}

  `)
      e.message = prependMessage + e.message
      throw e
    } finally {
      // 只有开启 vite:deps 调试时才构造这份开销不小的字符串（排序 + 逐条着色）。
      if (debug) {
        const duration = (performance.now() - start).toFixed(2)
        const depsStr =
          Object.keys(orderedDependencies(deps))
            .sort()
            .map((id) => `\n  ${colors.cyan(id)} -> ${colors.dim(deps[id])}`)
            .join('') || colors.dim('no dependencies found')
        debug(`Scan completed in ${duration}ms: ${depsStr}`)
      }
    }
  }
  // 不 await：函数立刻返回句柄，实际扫描在微任务里跑。
  // 上层若不关心结果（例如已从缓存命中），直接丢弃这个 Promise 也不会产生未处理拒绝，
  // 因为下面的 result 链总会给出一个兜底值。
  const result = scan()

  return {
    cancel,
    // scan() 提前 return（取消/无入口/关服）时是 undefined，这里统一兜成空表，
    // 避免调用方到处判空。
    result: result.then((res) => res ?? { deps: {}, missing: {} }),
  }
}

// 作用：决定「从哪些文件开始 crawl」。三条来源按优先级互斥：
//       1) optimizeDeps.entries（用户显式 glob）；
//       2) config.input / build.rolldownOptions.input（构建入口复用给扫描）；
//       3) 兜底 `**/*.html`。
// 调用点：本文件 scanImports() 内部的 scan() 第一步。
// 关键参数：entries 会被 resolveId(..., { isEntry: true, scan: true }) 解析成绝对路径，
//       `scan: true` 会一路传到插件 ctx 上，让插件知道当前不是真实构建。
// 失败模式：显式 input 解析不出来时直接抛错；
//       最后统一过滤掉「不可扫描的后缀」与「磁盘上不存在的虚拟文件」，不会报错。
async function computeEntries(environment: ScanEnvironment) {
  let entries: string[] = []

  const explicitEntryPatterns = environment.config.optimizeDeps.entries
  // 注意 input 可能与 config.input 不同：build.rolldownOptions.input 是低层写法。
  const input =
    environment.config.input ?? environment.config.build.rolldownOptions.input

  if (explicitEntryPatterns) {
    // 显式 entries 优先，避免被 autodetermine 出来的一大堆 html 淹掉。
    entries = await globEntries(explicitEntryPatterns, environment)
  } else if (input) {
    const resolvePath = async (p: string) => {
      // 这里走的是完整插件链，因此 alias / tsconfig paths / 虚拟入口都能解析。
      const id = (
        await environment.pluginContainer.resolveId(p, undefined, {
          isEntry: true,
          scan: true,
        })
      )?.id
      if (id === undefined) {
        throw new Error(
          `failed to resolve rolldownOptions.input value: ${JSON.stringify(p)}.`,
        )
      }
      return id
    }
    // input 支持三种形态：单路径字符串、路径数组、{ name: path } 对象（多入口）。
    // 对象形态只取 value，key（chunk 名）在扫描阶段没有意义。
    if (typeof input === 'string') {
      entries = [await resolvePath(input)]
    } else if (Array.isArray(input)) {
      entries = await Promise.all(input.map(resolvePath))
    } else if (isObject(input)) {
      entries = await Promise.all(Object.values(input).map(resolvePath))
    } else {
      throw new Error('invalid rolldownOptions.input value.')
    }
  } else {
    // 兜底策略：把项目里所有 html 当入口。这也是纯静态站能自动发现依赖的原因。
    entries = await globEntries('**/*.html', environment)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  // 虚拟文件（如插件生成的 \0xxx）没有磁盘存在性，扫描器无法 load，必须剔除；
  // 非 JS/HTML 且不在 optimizeDeps.extensions 白名单里的入口同理。
  entries = entries.filter(
    (entry) =>
      isScannable(entry, environment.config.optimizeDeps.extensions) &&
      fs.existsSync(entry),
  )

  return entries
}

// 作用：把用户配置 + Vite 内置的扫描插件合成一份 rolldown input options，
//       并包成 { build() } 交给调用方执行（不在这里直接跑，便于取消前再检查一次）。
// 调用点：本文件 scanImports() 的 scan()。
// 关键参数：
//   - entries 同时作为 scan() 的 input 和 externalUnlessEntry 的「白名单」；
//   - deps/missing 是输出表，被 rolldownScanPlugin 闭包写入；
//   - transformOptions 来自 optimizeDeps.rolldownOptions.transform，会被补上 jsx 默认值。
// 失败模式：用户插件 asyncFlatten 后若不是合法插件，rolldown 会在 build() 阶段报错；
//       扫描插件自身不抛错，只可能因 resolveId 失败把说明符记入 missing。
async function prepareRolldownScanner(
  environment: ScanEnvironment,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
): Promise<{ build: () => Promise<void> }> {
  // plugins 被单独摘出来：rolldown 的 input options 其余字段原样透传（resolve/define 等）。
  const { plugins: pluginsFromConfig = [], ...rolldownOptions } =
    environment.config.optimizeDeps.rolldownOptions ?? {}

  // 扫描要读出 import 关系，必须让 JSX/TSX 能被解析，否则 <div/> 会直接语法报错。
  // 这里对齐正常预打包的 transform 配置，避免「扫描能过、预打包却报 JSX 错误」。
  const transformOptions = deepClone(rolldownOptions.transform) ?? {}
  if (transformOptions.jsx === undefined) {
    transformOptions.jsx = {}
  } else if (
    transformOptions.jsx === 'react' ||
    transformOptions.jsx === 'react-jsx'
  ) {
    // 字符串简写要展开成 oxc 的 presets 对象，否则 transformSync 不认识。
    transformOptions.jsx = getRollupJsxPresets(transformOptions.jsx)
  }
  if (typeof transformOptions.jsx === 'object') {
    // dev 下开启 development 模式（自动注入 jsxDEV），与正常预打包行为一致。
    transformOptions.jsx.development ??= !environment.config.isProduction
  }
  // transformSync 的 jsx 选项不支持 false，显式关掉时传 undefined。
  const transformSyncJsxOptions: OxcTransformOptions['jsx'] =
    transformOptions.jsx === false ? undefined : transformOptions.jsx

  // 用户插件先入队，Vite 的扫描插件后入队 —— rolldown 的 resolveId 按顺序命中，
  // 这样用户的 onResolve/plugin 能优先拦截，符合「用户可覆盖内置行为」的约定。
  const plugins = await asyncFlatten(arraify(pluginsFromConfig))
  plugins.push(
    ...rolldownScanPlugin(
      environment,
      deps,
      missing,
      entries,
      transformSyncJsxOptions,
    ),
  )

  async function build() {
    // 这里就是「scan 阶段」的本体：rolldown/experimental 的 scan() 只做解析+load，
    // 不生成 chunk、不写磁盘，因此比一次完整 build 便宜得多。
    // logLevel: 'silent' —— 扫描是后台行为，警告/错误由 Vite 自己汇总后再呈现。
    await scan({
      ...rolldownOptions,
      transform: transformOptions,
      input: entries,
      logLevel: 'silent',
      plugins,
    })
  }

  return { build }
}

// 作用：把 deps 表按 key 排序后再返回，保证同一组依赖得到相同的键序。
// 调用点：本文件 scanImports() 的成功分支与 debug 输出。
// 为什么要排序：上游 getOptimizedBrowserHash() 会对 deps 做序列化，
//       键序不稳定 → 同样的依赖集算出不同 browserHash → 无谓地重新预打包。
function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

// 作用：按 glob 展开 entry 模式，并做「node_modules 内/外」的分流忽略。
// 调用点：本文件 computeEntries()，两处（显式 entries、兜底 **/*.html）。
// 关键参数：patterns 相对 config.root；返回绝对路径数组。
// 为什么分两批：默认要忽略 **/node_modules/**，但如果用户显式写了含 node_modules 的模式，
//       说明他确实想扫，因此这批模式不能套用同一条 ignore，只能拆开各 glob 一次。
async function globEntries(
  patterns: string | string[],
  environment: ScanEnvironment,
) {
  const nodeModulesPatterns: string[] = []
  const regularPatterns: string[] = []

  for (const pattern of arraify(patterns)) {
    if (pattern.includes('node_modules')) {
      nodeModulesPatterns.push(pattern)
    } else {
      regularPatterns.push(pattern)
    }
  }

  const sharedOptions = {
    absolute: true,
    cwd: environment.config.root,
    // 产物目录必须忽略：否则上一次构建出的 html/js 会被当成源码入口，
    // 导致扫描到已打包的 bundle、把依赖误判成「已内联」。
    ignore: [
      `**/${environment.config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      // 自动探测时额外跳过测试与覆盖率目录，避免把测试夹具里的 import 当成真实依赖。
      ...(environment.config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
  }

  // 两次 glob 并行；返回后 flat 成一个数组，顺序对扫描无影响（只为日志可读）。
  const results = await Promise.all([
    glob(nodeModulesPatterns, sharedOptions),
    glob(regularPatterns, {
      ...sharedOptions,
      ignore: [...sharedOptions.ignore, '**/node_modules/**'],
    }),
  ])

  return results.flat()
}

// 这里限定扫描阶段支持被转译成 JS 的四种 loader；
// 其它后缀（如 .mjs/.cjs）统一按 'js' 处理，见下方 transform 插件里的 ext 归一化。
type Loader = 'js' | 'ts' | 'jsx' | 'tsx'

// 匹配任意 <script ...>...</script> 块（大小写不敏感、跨行）。
// 用正则而不是 HTML parser：扫描只关心 script，容忍畸形 HTML；
// 真正的 HTML 处理（注入、transformIndexHtml）在 dev/build 中间件里，与此无关。
export const scriptRE: RegExp =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis
// 注释要在提取 script 前整体抹掉，否则 <!-- <script>...</script> --> 会被误当成真脚本。
export const commentRE: RegExp = /<!--.*?-->/gs
// 下面几条都是「从开标签里抠单个属性」的小正则，三者共享同一套引号分支写法。
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
// Svelte 4 用 context="module" 标记模块级脚本；Svelte 5 改成裸 module 属性，故两条都要认。
const svelteScriptModuleRE =
  /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const svelteModuleRE = /\smodule\b/i

// 作用：构造「扫描专用」的 rolldown 插件组（vite:dep-scan:*），负责
//       ① 把 HTML 类文档拆成 JS；② 判断每个说明符是依赖还是本地模块；
//       ③ 把命中的依赖写进 depImports / missing；④ 扫描前展开 import.meta.glob。
// 调用点：本文件 prepareRolldownScanner()；插件组随 scan() 一起执行。
// 关键参数：
//   - depImports：{ 说明符 -> 绝对路径 }，只收录「需要预构建」的；
//   - missing：{ 说明符 -> importer }，解析失败但确实是裸包依赖的；
//   - entries：入口白名单，入口本身即使命中 external 规则也不能被 external；
//   - jsxOptions：转译 JSX 时的 oxc 选项。
// 失败模式：load 到无法识别的 script 时抛 oxc transform 错误；
//       resolve 失败不会抛错，只记 missing，由上层统一报「依赖未安装」。
function rolldownScanPlugin(
  environment: ScanEnvironment,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[],
  jsxOptions: OxcTransformOptions['jsx'],
): Plugin[] {
  // 解析结果缓存。key 里用 dirname(importer) 而不是完整 importer：
  // 同一目录下的多个文件对同一 id 往往解析到同一结果，可以显著减少重复 resolve；
  // 但这也意味着「同目录不同文件」必须得到同样结果，否则缓存会串味（见下方 options 参与 key）。
  const seen = new Map<string, string | undefined>()
  // resolveId 的唯一出口：所有解析都落到真实 pluginContainer，并强制带上 scan: true，
  // 让 resolve 插件知道当前是扫描上下文（例如不做 dev 的 /@fs/ 前缀处理）。
  async function resolveId(
    id: string,
    importer?: string,
    options?: Parameters<EnvironmentPluginContainer['resolveId']>[2],
  ): Promise<PartialResolvedId | null> {
    return environment.pluginContainer.resolveId(
      id,
      importer && normalizePath(importer),
      { scan: true, ...options },
    )
  }
  const resolve = async (
    id: string,
    importer?: string,
    options?: Parameters<typeof resolveId>[2],
  ) => {
    // options 也参与 key：同一 id 在「入口(entry)」与「普通 import」下解析结果可能不同，
    // 不区分会拿到错误的缓存（尤其是 isEntry 影响 alias/条件导出）。
    const key = JSON.stringify([
      id,
      importer && path.dirname(importer),
      options,
    ])
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await resolveId(id, importer, options)
    const res = resolved?.id
    // 失败（undefined）也缓存：避免对同一个不存在的说明符反复走完整插件链。
    seen.set(key, res)
    return res
  }

  const optimizeDepsOptions = environment.config.optimizeDeps
  const include = optimizeDepsOptions.include
  // @vite/client 与 @vite/env 是 Vite 自己注入的虚拟依赖，绝不能进预打包。
  const exclude = [
    ...(optimizeDepsOptions.exclude ?? []),
    '@vite/client',
    '@vite/env',
  ]

  // 通用「外部化」返回：入口文件本身不能被 external，否则扫描起点会消失；
  // 其它一律 external —— external 的语义就是「到此为止，不再 load/crawl」。
  const externalUnlessEntry = ({ path }: { path: string }) => ({
    id: path,
    external: !entries.includes(path),
  })

  // 作用：在扫描前把 import.meta.glob 展开成静态 import/动态 import。
  // 为什么必须做：glob 的匹配结果只存在于运行时的 transform 里，
  //       rolldown 的图遍历看不到「将被 glob 匹配到哪些文件」，
  //       不展开就会漏掉这些文件里的依赖（最常见的是组件目录里的第三方包）。
  // 调用点：本文件 htmlTypeOnLoadCallback() 与 vite:dep-scan:transform:js-glob 插件。
  // 关键参数：loader 决定是否需要先转译；transformGlobImport 只接受 JS。
  // 失败模式：oxc 转译报错会抛 AggregateError；glob 展开失败时返回 null，调用方回退原文。
  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader,
  ) => {
    let transpiledContents: string
    // transpile because `transformGlobImport` only expects js
    // tsconfig: false —— 扫描阶段不读用户 tsconfig，避免路径别名/装饰器配置带来的额外 IO 与不可控行为；
    // 别名解析交给下游的 resolve 回调（pluginContainer 里由 resolve 插件统一处理）。
    if (loader !== 'js') {
      const result = transformSync(id, contents, {
        ...(jsxOptions !== undefined ? { jsx: jsxOptions } : {}),
        lang: loader,
        tsconfig: false,
      })
      if (result.errors.length > 0) {
        throw new AggregateError(result.errors, 'oxc transform error')
      }
      transpiledContents = result.code
    } else {
      transpiledContents = contents
    }

    // resolve 回调让 glob 内部也能解析别名/裸包，从而把匹配到的 id 统一成磁盘路径。
    const result = await transformGlobImport(
      transpiledContents,
      id,
      environment.config.root,
      resolve,
    )

    // 没有 glob（返回 null）时原样返回，保证调用方总能拿到可用源码。
    return result?.s.toString() || transpiledContents
  }

  // HTML 文档里每个内联 <script> 都会被抽成一个虚拟模块，
  // 这里就是虚拟模块 id（`id?id=n`）到源码的映射表。
  const scripts: Record<
    string,
    {
      contents: string
      loader: Loader
    }
  > = {}

  // 作用：把一个 HTML/Vue/Svelte/Astro/Imba 文件重写成「只含 import/export 的 JS 模块」。
  // 调用点：本文件插件 vite:dep-scan:load:html 的 load handler。
  // 关键参数：id 是入口文档的绝对路径；返回的 code 会被 rolldown 当作入口模块解析。
  // 失败模式：内联脚本里的 import.meta.glob 展开失败会向上抛；
  //       文件读不到（已被删）会让 fsp.readFile 直接 reject，scan build 失败。
  const htmlTypeOnLoadCallback = async (id: string): Promise<string> => {
    let raw = await fsp.readFile(id, 'utf-8')
    // Avoid matching the content of the comment
    // 先把注释替换成空注释占位（而不是删掉），保持行/列大致不变，便于报错定位。
    raw = raw.replace(commentRE, '<!---->')
    const isHtml = id.endsWith('.html')
    let js = ''
    // scriptId 用于给每个内联脚本生成唯一虚拟模块 id，避免同名变量互相污染。
    let scriptId = 0
    const matches = raw.matchAll(scriptRE)
    for (const [, openTag, content] of matches) {
      const typeMatch = typeRE.exec(openTag)
      const type = typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
      const langMatch = langRE.exec(openTag)
      const lang = langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
      // skip non type module script
      // 纯 HTML 里只有 type="module" 才是 ESM；普通 <script> 是全局脚本，与依赖图无关。
      // 但 .vue/.svelte 的 <script> 默认就是模块，不能用这条规则过滤。
      if (isHtml && type !== 'module') {
        continue
      }
      // skip type="application/ld+json" and other non-JS types
      // 结构化数据、模板片段等即使带 src 也不是 JS 依赖来源。
      if (
        type &&
        !(
          type.includes('javascript') ||
          type.includes('ecmascript') ||
          type === 'module'
        )
      ) {
        continue
      }
      // loader 决定后面是否需要用 oxc 转译（TS/JSX）；
      // Astro 的 frontmatter 脚本没有 lang 属性但内容是 TS，需要特判。
      let loader: Loader = 'js'
      if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
        loader = lang
      } else if (id.endsWith('.astro')) {
        loader = 'ts'
      }
      const srcMatch = srcRE.exec(openTag)
      if (srcMatch) {
        // 外链脚本：只产出一条 import，把真实的解析交给后续 resolveId 处理。
        // 用 JSON.stringify 转义，避免路径里有引号/反斜杠时拼出非法代码。
        const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
        js += `import ${JSON.stringify(src)}\n`
      } else if (content.trim()) {
        // The reason why virtual modules are needed:
        // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
        // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
        // 2. There can be multiple module scripts in html
        // We need to handle these separately in case variable names are reused between them
        // 翻译：一个文件里可能有多个脚本块，且各自作用域独立；
        // 直接拼接到同一个模块里会产生重复声明/作用域串扰，
        // 所以每个脚本块单独注册成虚拟模块，再通过 import/export 挂回入口。

        // append imports in TS to prevent esbuild from removing them
        // since they may be used in the template
        // 现在转译器是 oxc，但问题依旧：TS 会把「看起来未使用」的 import 删掉，
        // 而这些 import 在模板/宏里其实有用，所以先补一份 import 保证图不断。
        const contents =
          content + (loader.startsWith('ts') ? extractImportPaths(content) : '')

        // 虚拟模块 id 必须在同一文件内唯一，跨文件由 id 前缀保证唯一。
        const key = `${id}?id=${scriptId++}`
        if (contents.includes('import.meta.glob')) {
          // 只有含 glob 时才需要「转译 + 展开」；loader 记为 js 因为输出已是 JS。
          scripts[key] = {
            loader: 'js', // since it is transpiled
            contents: await doTransformGlobImport(contents, id, loader),
          }
        } else {
          scripts[key] = {
            loader,
            contents,
          }
        }

        // 虚拟模块前缀 `virtual-module:` 由 utils.ts 定义，
        // 由下面的 vite:dep-scan:local-scripts 插件负责 resolveId/load。
        const virtualModulePath = JSON.stringify(virtualModulePrefix + key)

        let addedImport = false

        // For Svelte files, exports in <script context="module"> or <script module> means module exports,
        // exports in <script> means component props. To avoid having two same export name from the
        // star exports, we need to ignore exports in <script>
        // 翻译：Svelte 里 <script module> 的 export 才是模块导出，
        // 普通 <script> 的 export 是组件 props；若两者都用 `export *` 会重名冲突，
        // 所以组件脚本改成具名 import（只引入副作用），模块脚本才 export *。
        if (id.endsWith('.svelte')) {
          let isModule = svelteModuleRE.test(openTag) // test for svelte5 <script module> syntax
          if (!isModule) {
            // fallback, test for svelte4 <script context="module"> syntax
            const contextMatch = svelteScriptModuleRE.exec(openTag)
            const context =
              contextMatch &&
              (contextMatch[1] || contextMatch[2] || contextMatch[3])
            isModule = context === 'module'
          }
          if (!isModule) {
            addedImport = true
            js += `import ${virtualModulePath}\n`
          }
        }

        if (!addedImport) {
          js += `export * from ${virtualModulePath}\n`
        }
      }
    }

    // This will trigger incorrectly if `export default` is contained
    // anywhere in a string. Svelte and Astro files can't have
    // `export default` as code so we know if it's encountered it's a
    // false positive (e.g. contained in a string)
    // 补一个 default 导出，确保入口模块形态合法（rolldown 会把没有导出的入口当副作用模块，
    // 某些插件形态下可能被摇掉）；Vue 已有默认导出时不重复添加。
    if (!id.endsWith('.vue') || !js.includes('export default')) {
      js += '\nexport default {}'
    }

    return js
  }

  // 与 constants.ts 的 KNOWN_ASSET_TYPES 对齐，但这里只关心「以该后缀结尾」，
  // 不处理 ?query（query 由 SPECIAL_QUERY_RE 分支单独兜住）。
  const ASSET_TYPE_RE = new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`)

  // 插件顺序很重要：resolveId 按数组顺序执行，先命中先返回；
  // 因此 URL/data URL 必须在通用 resolve 之前，虚拟模块必须在 catch-all 之前。
  return [
    // ---------------------------------------------------------------------
    // 插件 1：vite:dep-scan:resolve-external-url
    // 作用：把 http(s)://、//cdn 等绝对 URL 直接标记 external，避免扫描器试图读网络文件。
    // 调用点：rolldown 的 resolve 阶段，filter 命中 externalRE 时调用。
    // 关键参数：filter 用正则做原生过滤，非 JS 实现，命中成本低。
    // 失败模式：无（一律 external）。但 CDN import 里的依赖因此不会被预构建，
    //   这是有意为之：远端 ESM 由浏览器直接加载，不该进本地依赖包。
    // ---------------------------------------------------------------------
    {
      name: 'vite:dep-scan:resolve-external-url',
      resolveId: {
        // external urls
        filter: { id: externalRE },
        handler: (id) => ({ id, external: true }),
      },
    },
    // ---------------------------------------------------------------------
    // 插件 2：vite:dep-scan:resolve-data-url
    // 作用：data: URL（内联 base64 模块）直接 external，扫描器不解析其内容。
    // 调用点：同上，filter 命中 dataUrlRE。
    // 失败模式：无。data URL 里的 import 不会被发现，但这部分内容通常已是打包产物。
    // ---------------------------------------------------------------------
    {
      name: 'vite:dep-scan:resolve-data-url',
      resolveId: {
        // data urls
        filter: { id: dataUrlRE },
        handler: (id) => ({ id, external: true }),
      },
    },
    // ---------------------------------------------------------------------
    // 插件 3：vite:dep-scan:local-scripts
    // 作用：为 htmlTypeOnLoadCallback() 生成的 `virtual-module:<file>?id=n` 提供
    //       resolveId（原样返回，保持虚拟 id）与 load（从 scripts 表取源码）。
    // 调用点：所有 HTML 类文档拆出来的内联脚本，经 vite:dep-scan:load:html 后进入图遍历。
    // 关键参数：filter 用 virtualModuleRE；load 时用 replace 剥掉前缀查表。
    // 失败模式：若 id 不在 scripts 表中（例如重名/前缀被篡改），这里会因读取 undefined.contents
    //       而抛 TypeError —— 正常情况下不会发生，因为 id 由同一函数生成。
    // ---------------------------------------------------------------------
    {
      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      name: 'vite:dep-scan:local-scripts',
      resolveId: {
        filter: { id: virtualModuleRE },
        handler: (id) => ({ id }),
      },
      load: {
        filter: { id: virtualModuleRE },
        handler(id) {
          const script = scripts[id.replace(virtualModulePrefix, '')]
          return {
            code: script.contents,
            moduleType: script.loader,
          }
        },
      },
    },

    // ---------------------------------------------------------------------
    // 插件 4：vite:dep-scan:resolve（核心判定）
    // 作用：扫描器的「大脑」，决定每个说明符是 → 依赖（记入 depImports 并 external）/
    //       本地模块（继续 crawl）/ 直接忽略（external）。
    // 调用点：每次 rolldown 图遍历遇到 import 说明符时。
    // 关键参数：id 是原始说明符，importer 是发起方（可能是虚拟模块 id）。
    // 失败模式：判定为裸包但解析失败 → 写 missing，不抛错；判定过程本身不抛错。
    // 判定流程：
    // 判定顺序（顺序即语义，改动会改变结果）：
    //   a) 还原虚拟模块 importer → b) html 文档 → c) 裸包 → d) 按后缀外置 → e) catch-all。
    //   d 必须在 c 之后：包名本身可能以 .css/.json 等结尾（如 `foo.css`），
    //   先判后缀会把包名误当文件。
    // ---------------------------------------------------------------------
    {
      name: 'vite:dep-scan:resolve',
      async resolveId(id, importer) {
        // Make sure virtual module importer can be resolve
        // 虚拟模块 id（html?id=1）不是真实路径，直接传给 resolve 会让 alias/相对路径
        // 计算错误；这里剥回原始文件路径，相当于「以该脚本所属文档为 importer」。
        importer =
          importer && virtualModuleRE.test(importer)
            ? importer.replace(virtualModulePrefix, '')
            : importer

        // html types: extract script contents -----------------------------------
        if (htmlTypesRE.test(id)) {
          const resolved = await resolve(id, importer)
          if (!resolved) return
          // It is possible for the scanner to scan html types in node_modules.
          // If we can optimize this html type, skip it so it's handled by the
          // bare import resolve, and recorded as optimization dep.
          // 翻译：node_modules 里的 .vue/.svelte 包（组件库）本身应当是「依赖」，
          // 不该被当文档拆开扫描；只有不可优化的才按文档处理。
          if (
            !isInNodeModules(resolved) ||
            !isOptimizable(resolved, optimizeDepsOptions)
          ) {
            // 绝对路径 + 非虚拟 → 作为真实文件继续 load（下面 load:html 会接手）。
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            return resolved
          }
        }

        // bare imports: record and externalize ----------------------------------
        // avoid matching windows volume
        // 正则 `^[\w@][^:]` 排除 `C:` 这类盘符，也顺带排除带协议的 URL（前面已处理）。
        // 命中即「可能是裸包说明符」：a、@scope/pkg、pkg/sub。
        if (/^[\w@][^:]/.test(id)) {
          // 用户显式 exclude 的包：跳过预构建，直接 external，也不继续 crawl。
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          // 已记录过的依赖无需重复解析，直接 external —— 这是「每个包只记一次」的保证。
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          const resolved = await resolve(id, importer)
          if (resolved) {
            // 解析到非绝对路径或虚拟 id：不是可打包的实体文件，external 掉。
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            if (isInNodeModules(resolved) || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              // 记录形态很关键：key 是「原始说明符」（如 `lodash-es`、`vue/dist/vue.esm`），
              // value 是「解析后的磁盘绝对路径」。下游 optimizer/index.ts 的
              // toDiscoveredDependencies() 用 key 生成 optimizedDep 的 id/文件名，
              // 用 value 作为 rolldown 打包输入；两者不可互换。
              // tsconfig paths 的别名也在这条链上：resolve 由 pluginContainer 完成，
              // 别名命中 node_modules 时同样落到这里，但 key 仍是别名说明符。
              // 只有「可优化」的才记入 depImports；例如 .css 文件在 node_modules 里
              // 不会进预打包，但仍要被 external（不能继续 crawl 到它的 @import）。
              if (isOptimizable(resolved, optimizeDepsOptions)) {
                depImports[id] = resolved
              }
              return externalUnlessEntry({ path: id })
            } else if (isScannable(resolved, optimizeDepsOptions.extensions)) {
              // linked package, keep crawling
              // 解析到 node_modules 之外（pnpm link / workspace 源码）：它不是「依赖」，
              // 而是本地源码，需要继续 crawl 以发现其内部真正依赖的第三方包。
              return path.resolve(resolved)
            } else {
              return externalUnlessEntry({ path: id })
            }
          } else {
            // 解析失败：可能是可选依赖/尚未安装，先记 missing 由上层统一报错。
            // importer 理论上一定存在（裸包不可能从入口直接 import），用 ! 断言。
            missing[id] = normalizePath(importer!)
          }
        }

        // Externalized file types -----------------------------------------------
        // these are done on raw ids using esbuild's native regex filter so it
        // should be faster than doing it in the catch-all via js
        // they are done after the bare import resolve because a package name
        // may end with these extensions
        // 注意上游注释仍写 esbuild，实际现在由 rolldown 的 JS 分支执行；
        // 「放在裸包判定之后」的原因见本插件头注释。

        // css
        // 任何 CSS 语言都不预构建，扫描到此为止（@import 链由 CSS 处理链负责）。
        if (CSS_LANGS_RE.test(id)) {
          return externalUnlessEntry({ path: id })
        }

        // json & wasm
        // json5 也要认；wasm 由 wasm 插件在 build 时处理，扫描阶段无关。
        if (/\.(?:json|json5|wasm)$/.test(id)) {
          return externalUnlessEntry({ path: id })
        }

        // known asset types
        // 图片/字体/媒体等静态资源：import 它们只是为了拿 URL，不产生依赖。
        if (ASSET_TYPE_RE.test(id)) {
          return externalUnlessEntry({ path: id })
        }

        // known vite query types: ?worker, ?raw
        // 这些 query 会由 Vite 的 worker/raw 插件转成虚拟模块；
        // 扫描阶段没必要（也无法）深入，external 即可。注意这里不走 externalUnlessEntry，
        // 因为带 query 的 id 永不等于入口路径，external 恒为 true。
        if (SPECIAL_QUERY_RE.test(id)) {
          return {
            id,
            external: true,
          }
        }

        // catch all -------------------------------------------------------------

        // use vite resolver to support urls and omitted extensions
        // 兜底：相对路径、省略扩展名、目录 index、alias、tsconfig paths 全部靠真实解析器。
        const resolved = await resolve(id, importer)
        if (resolved) {
          // 解析结果不是可扫描文件（例如指向 .md、.txt）→ 外部化，不 load。
          if (
            shouldExternalizeDep(resolved, id) ||
            !isScannable(resolved, optimizeDepsOptions.extensions)
          ) {
            return externalUnlessEntry({ path: id })
          }
          // cleanUrl 去掉 ?query，保证交给 rolldown 的是磁盘路径而不是 URL。
          return path.resolve(cleanUrl(resolved))
        }

        // resolve failed... probably unsupported type
        return externalUnlessEntry({ path: id })
      },
    },
    // ---------------------------------------------------------------------
    // 插件 5：vite:dep-scan:load:html
    // 作用：把入口文档 load 成 JS（调用 htmlTypeOnLoadCallback）。
    // 调用点：vite:dep-scan:resolve 对 html 类 id 返回绝对路径后，load 阶段命中此插件。
    // 关键参数：filter 用 htmlTypesRE；moduleType 固定 'js'，因为输出是拼装后的 ESM。
    // 失败模式：见 htmlTypeOnLoadCallback（读文件失败 / glob 转译失败）。
    // ---------------------------------------------------------------------
    {
      name: 'vite:dep-scan:load:html',
      load: {
        // extract scripts inside HTML-like files and treat it as a js module
        filter: { id: htmlTypesRE },
        async handler(id) {
          return {
            code: await htmlTypeOnLoadCallback(id),
            moduleType: 'js',
          }
        },
      },
    },
    // ---------------------------------------------------------------------
    // 插件 6（条件）：vite:dep-scan:transform:jsx-inject
    // 作用：当用户配置了 oxc.jsxInject 时，把注入代码拼到每个 jsx/tsx 前面。
    // 调用点：只在 config.oxc.jsxInject 存在时注册；normal build 里由 oxc 插件做同样的事，
    //       但扫描走的是独立的 rolldown scan 实例，不会经过 oxc 插件，所以要在这里补一遍。
    // 关键参数：filter 只匹配 .jsx/.tsx（.js/.ts 里也能写 JSX，但 jsxInject 主要面向这两类）。
    // 失败模式：无；jsxInject 只是字符串前缀，语法错误会由后续解析报出。
    // ---------------------------------------------------------------------
    // for jsx/tsx, we need to access the content and check for
    // presence of import.meta.glob, since it results in import relationships
    // but isn't crawled by esbuild.
    ...(environment.config.oxc && environment.config.oxc.jsxInject
      ? [
          {
            name: 'vite:dep-scan:transform:jsx-inject',
            transform: {
              filter: {
                id: /\.[jt]sx$/,
              },
              handler(code) {
                const oxcConfig = environment.config.oxc
                if (oxcConfig && oxcConfig.jsxInject) {
                  code = oxcConfig.jsxInject + `\n` + code
                }
                return code
              },
            },
          } satisfies Plugin,
        ]
      : []),
    // ---------------------------------------------------------------------
    // 插件 7：vite:dep-scan:transform:js-glob
    // 作用：对所有 JS 类源码在扫描前展开 import.meta.glob（真正的「扫描前展开」）。
    // 调用点：rolldown scan 的 transform 阶段；filter 用字符串子串 'import.meta.glob'
    //       做廉价预筛，只有出现该子串的模块才进入 handler。
    // 关键参数：扩展名归一化 —— .mjs 当 js；.cjs 之类会被 ext 直接当 loader 传入，
    //       若不在 Loader 联合类型内，doTransformGlobImport 里 loader !== 'js' 会走 oxc 转译并可能报错。
    // 失败模式：转译/展开失败会中断整个 scan build（错误会带入口列表抛给用户）。
    // ---------------------------------------------------------------------
    {
      name: 'vite:dep-scan:transform:js-glob',
      transform: {
        filter: {
          code: 'import.meta.glob',
        },
        async handler(code, id) {
          if (JS_TYPES_RE.test(id)) {
            let ext = path.extname(id).slice(1)
            if (ext === 'mjs') ext = 'js'
            const loader = ext as 'js' | 'ts' | 'jsx' | 'tsx'
            return {
              moduleType: 'js',
              code: await doTransformGlobImport(code, id, loader),
            }
          }
        },
      },
    },
  ]
}

// 作用：用 importsRE 从一段文本里抽出所有 import 的说明符，拼成 `\nimport "x"` 序列。
// 调用点：本文件 htmlTypeOnLoadCallback()，且仅对 lang 以 ts 开头的脚本块调用。
// 关键参数：入参是原始（未转译）片段；返回串被追加在原脚本后面。
// 失败模式：纯正则，不会抛错；漏抽只会少发现依赖，上游注释已说明可接受。
// 注意 importsRE 带 g 标志，是全局共享的有状态正则，所以每次使用前必须重置 lastIndex，
// 否则并发/连续调用会从上次结束位置继续，导致漏匹配。
/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  // 先把注释内容清掉：注释里的 `// import 'x'` 不该被当成真实依赖。
  // 替换成等长（或至少保留块注释边界）的占位符，避免把两行代码粘在一起产生误匹配。
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    // m[1] 已含引号（正则捕获的是带引号的字面量），因此直接拼即可。
    js += `\nimport ${m[1]}`
  }
  return js
}

// 作用：判断一个已解析的 id 是否「无法作为文件继续 crawl」，是则外部化。
// 调用点：本文件 vite:dep-scan:resolve 的多处分支（html / 裸包 / catch-all）。
// 关键参数：resolvedId 是解析结果，rawId 是原始说明符。
// 两条判据：
//   1) 非绝对路径 —— 说明解析器返回的是 URL/虚拟协议，不是磁盘文件；
//   2) 解析结果与原始说明符相同，或包含 \0 —— 说明是插件造的虚拟模块。
// 失败模式：无副作用，纯判断。注意它不关心文件是否真实存在（存在性由后续 load 决定）。
function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

// 作用：判断某个 id 是否值得继续 crawl（扫描）。
// 调用点：本文件 computeEntries() 过滤入口、vite:dep-scan:resolve 的裸包与 catch-all 分支。
// 关键参数：extensions 来自 optimizeDeps.extensions，用于支持用户自定义可扫描后缀。
// 失败模式：无。返回 false 只是「不深入」，不会报错。
// 注意：CSS/资源类型不在此列，它们在 resolve 阶段就被外置了。
function isScannable(id: string, extensions: string[] | undefined): boolean {
  return (
    JS_TYPES_RE.test(id) ||
    htmlTypesRE.test(id) ||
    extensions?.includes(path.extname(id)) ||
    false
  )
}
