// ─────────────────────────── 文件角色 ───────────────────────────
// Vite 8 起，TS/JSX 的转译从 esbuild 换成了 oxc（Rust 实现，通过 rolldown 的 NAPI 暴露）。
// 本文件提供两套能力：
//   1) 通用函数 transformWithOxc：给任意 id 做一次同步转译，附带 tsconfig 解析缓存与 watch 登记；
//   2) oxcPlugin：dev（非 isBundled）环境的 transform 插件，负责按 include/exclude 过滤、
//      JSX refresh 边界判断、jsxInject 前缀注入，并把 oxc 的告警转成 Vite 的告警。
// 上游：plugins/index.ts 的 createPluginHookUtils 在 `config.oxc !== false` 时注册 oxcPlugin；
//   它排在内置插件数组中部，因此后面还有 importAnalysis 等插件会消费它输出的纯 JS。
// 下游：本文件调用 rolldown/utils 的 transformSync、rolldown/experimental 的 viteTransformPlugin
//   （isBundled 环境用原生插件代替 JS 插件），以及 plugins/esbuild.ts 的 getTSConfigResolutionCache。
// 关键不变量：
//   - include/exclude 默认值是 /\.(m?ts|[jt]sx)$/ 与 /\.js$/，即「转译 TS/JSX、跳过普通 JS」；
//   - refresh 注入必须只发生在浏览器 consumer 且确实是 JSX 的文件上，否则会给普通 .js 注入
//     react-refresh 运行时，导致生产/dev 行为不一致；
//   - esbuild 选项没有消失：用户配置 config.esbuild 时由 convertEsbuildConfigToOxcConfig 翻译成 oxc 选项。
// 容易误解的点：`config.oxc === false` 才是「关闭默认转译」；`config.esbuild === false` 已无效
//   （config.ts 会给出告警），因为默认转译现在由 oxc 承担。
import path from 'node:path'
import colors from 'picocolors'
import type { RolldownError, RolldownLog, SourceMap } from 'rolldown'
import { viteTransformPlugin as nativeTransformPlugin } from 'rolldown/experimental'
import type {
  TransformOptions as OxcTransformOptions,
  TransformResult as OxcTransformResult,
} from 'rolldown/utils'
import { transformSync } from 'rolldown/utils'
import type { FSWatcher } from '#dep-types/chokidar'
import type { Environment } from '..'
import { cleanUrl } from '../../shared/utils'
import type { ResolvedConfig } from '../config'
import { JS_TYPES_RE } from '../constants'
import type { Logger } from '../logger'
import type { Plugin } from '../plugin'
import type { ViteDevServer } from '../server'
import { createFilter, ensureWatchedFile, normalizePath } from '../utils'
import { type ESBuildOptions, getTSConfigResolutionCache } from './esbuild'

// 下面两个正则用于在「已经打包成 iife/umd 的产物」里定位函数体起始位置，
// 以便把内联 CSS 注入到包装函数内部。调用点（Grep 确认）：plugins/css.ts 的 injectInlinedCSS，
// 按 format 选择 IIFE_BEGIN_RE 或 UMD_BEGIN_RE 并取 match 结束位置作为注入点。
// 这也是从 esbuild.ts 迁移过来的（esbuild.ts 里还留有同名旧副本用于旧路径）。
// IIFE content looks like `var MyLib = (function() {` or `this.nested.myLib = (function() {`.
export const IIFE_BEGIN_RE: RegExp =
  /(?:(?:(?:const|var)\s+[^.\s]+|[^.\s]+\.[^.\s]+\.[^.\s]+)\s*=\s*|^|\n)\(?function\([^()]*\)\s*\{(?:\s*"use strict";)?/
// UMD content looks like `})(this, function(exports, external1, external2) {`.
export const UMD_BEGIN_RE: RegExp =
  /\}\)\((?:this,\s*)?function\([^()]*\)\s*\{(?:\s*"use strict";)?/

// 判断 id 是否为 JSX/TSX 扩展名（用于决定是否注入 jsxInject 前缀）。
const jsxExtensionsRE = /\.(?:j|t)sx\b/
// 判断 id 是否以「文件扩展名」结尾：Vue 等插件的虚拟块 id 形如
// `Comp.vue?vue&type=script&lang.tsx`，此类 query 末尾就带语言后缀，可直接取 ext；
// 否则（如 `a.ts?raw`、`a.ts?v=hash`）需要先 cleanUrl 再取 ext。
const validExtensionRE = /\.\w+$/

// OxcOptions = rolldown 的 TransformOptions 减去 Vite 自己要接管的字段，再加上 Vite 特有的过滤项。
// 为什么 Omit：cwd/sourceType/lang/sourcemap/tsconfig/inputMap 由 transformWithOxc 按 id 与当前配置
//   计算（不能让用户从 config.oxc 里覆盖，否则同一份配置在不同文件上会得到错误语言）；
//   helpers/inject 由 oxc 运行时插件（oxcRuntimePlugin）在打包阶段处理，不在单文件转译里开启。
export interface OxcOptions extends Omit<
  OxcTransformOptions,
  | 'cwd'
  | 'sourceType'
  | 'lang'
  | 'sourcemap'
  | 'helpers'
  | 'inject'
  | 'tsconfig'
  | 'inputMap'
> {
  // include/exclude：决定哪些 id 进入本插件的 transform（默认 ts/tsx/jsx）。
  include?: string | RegExp | ReadonlyArray<string | RegExp>
  exclude?: string | RegExp | ReadonlyArray<string | RegExp>
  // jsxInject：给每个 JSX/TSX 文件前置注入的代码（典型是 `import React from 'react'`）。
  jsxInject?: string
  // jsxRefreshInclude/Exclude：在 include/exclude 之外，单独控制 react-refresh 的注入范围；
  // 两者都没配置时 refresh 是否注入完全由文件内容/consumer 判断（见 getModifiedOxcTransformOptions）。
  jsxRefreshInclude?: string | RegExp | ReadonlyArray<string | RegExp>
  jsxRefreshExclude?: string | RegExp | ReadonlyArray<string | RegExp>
}

// 作用：把 rolldown 的 JSX 预设简写展开成显式选项。
// 调用点（Grep 确认）：optimizer/scan.ts 的 prepareRolldownScanner，
//   在 deepClone 用户 optimizeDeps.rolldownOptions.transform 后，把 jsx: 'react' | 'react-jsx' 展开，
//   以便在展开结果上继续补 development 等字段。
// 关键参数：preset 只接受两个字符串字面量。
// 失败模式：其它值不会进入函数体；函数末尾的 `preset satisfies never` 是编译期穷尽性检查，
//   将来 rolldown 新增预设时这里会直接类型报错而不是静默返回 undefined。
export function getRollupJsxPresets(
  preset: 'react' | 'react-jsx',
): OxcJsxOptions {
  switch (preset) {
    // classic：保留 JSX.createElement 风格，必须给出 pragma/pragmaFrag，
    // 否则产物里会引用未定义的工厂函数（源码里也没有对应的 import）。
    case 'react':
      return {
        runtime: 'classic',
        pragma: 'React.createElement',
        pragmaFrag: 'React.Fragment',
        importSource: 'react',
      }
    // automatic：由编译器自动插入 `react/jsx-runtime` 的导入，pragma 只影响显式的
    // /** @jsx */ 注释语义，因此不需要 pragmaFrag。
    case 'react-jsx':
      return {
        runtime: 'automatic',
        pragma: 'React.createElement',
        importSource: 'react',
      }
  }
  preset satisfies never
}

// 作用：拼接两段错误文本，并保证中间恰好一个换行（去掉前段尾部/后段头部的多余空行）。
// 调用点：本文件 getErrorMessage 内部，拼接 message / frame / stack / cause。
// 之所以要规整：rolldown 返回的 frame 与 stack 自带首尾换行，直接拼接会出现空行，
// 让终端里的错误信息可读性变差。
// Copy from rolldown's packages/rolldown/src/utils/errors.ts
function joinNewLine(s1: string, s2: string): string {
  // ensure single new line in between
  return s1.replace(/\n+$/, '') + '\n' + s2.replace(/^\n+/, '')
}

// 作用：把 rolldown 的结构化错误对象渲染成可读的多行字符串。
// 调用点：本文件 transformWithOxc 的错误聚合（最多取前 5 条，其余折叠成 '...'）。
// 关键分支：带 `kind` 字段说明是 rolldown Rust 侧自定义的错误，message 已包含全部信息，
//   再加 `[plugin] id:line:col` 和 stack 反而重复，因此直接返回。
// 失败模式：无——纯字符串拼接；但 cause 链过深时输出会很长，这里只做一层层缩进、不截断。
// Copy from rolldown's packages/rolldown/src/utils/errors.ts
function getErrorMessage(e: RolldownError): string {
  // If the `kind` field is present, we assume it represents
  // a custom error defined by rolldown on the Rust side.
  if (Object.hasOwn(e, 'kind')) {
    return e.message
  }

  let s = ''
  if (e.plugin) {
    s += `[plugin ${e.plugin}]`
  }
  const id = e.id ?? e.loc?.file
  if (id) {
    s += ' ' + id
    if (e.loc) {
      s += `:${e.loc.line}:${e.loc.column}`
    }
  }
  if (s) {
    s += '\n'
  }
  const message = `${e.name ?? 'Error'}: ${e.message}`
  s += message
  if (e.frame) {
    s = joinNewLine(s, e.frame)
  }
  // copy stack since it's important for js plugin error
  if (e.stack) {
    s = joinNewLine(s, e.stack.replace(message, ''))
  }
  if (e.cause) {
    s = joinNewLine(s, 'Caused by:')
    s = joinNewLine(
      s,
      getErrorMessage(e.cause as any)
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n'),
    )
  }
  return s
}

// ─────────────── 通用转译入口 ───────────────
// 作用：对单个 id 做一次 oxc 转译（TS/JSX → JS），并处理 tsconfig 缓存、watch 登记与错误聚合。
// 调用点（Grep 确认）：
//   - 本文件 oxcPlugin 的 transform 钩子（核心链路）；
//   - optimizer/index.ts 的 extractExportsData（入口文件无法被 lexer 解析时先转译再扫描导出）；
//   - 公共 API：src/node/index.ts 重新导出 transformWithOxc；
//   - 测试：__tests__/plugins/oxc.spec.ts、ssrTransform.spec.ts、importGlob/fixture 等。
// 关键参数：filename 是完整 id（含 query），它同时决定 lang 推断与 oxc 的 tsconfig 查找起点；
//   inMap 用于把上一步的 sourcemap 接到本次转译上；config 用于 tsconfig 缓存键（dev 插件与 optimizer 都会传）；
//   watcher 只有 dev 插件会传（用于登记 tsconfig 监听）。
// 失败模式：oxc 报错时抛出一个聚合 Error（message 最多含 5 条错误，errors 属性保留原始数组），
//   由 pluginContainer 捕获并补上 plugin 名与代码帧。
export async function transformWithOxc(
  code: string,
  filename: string,
  options?: OxcTransformOptions,
  inMap?: object,
  config?: ResolvedConfig,
  watcher?: FSWatcher,
): Promise<Omit<OxcTransformResult, 'errors'>> {
  let lang = options?.lang
  if (!lang) {
    // if the id ends with a valid ext, use it (e.g. vue blocks)
    // otherwise, cleanup the query before checking the ext
    // 扩展名推断的三段逻辑：
    //   1) Vue 块的 id 以 `?lang.tsx` 结尾（整串以 .tsx 结尾）→ 直接取 path.extname；
    //   2) 其它带 query 的 id（`a.ts?raw`）→ 先 cleanUrl 去掉查询串；
    //   3) 取不到 ext 时 lang 为 ''，交给 oxc 按内容报错（调用方通常已用 include 过滤掉这类 id）。
    const ext = path
      .extname(validExtensionRE.test(filename) ? filename : cleanUrl(filename))
      .slice(1)

    // oxc 的 lang 只有 js/jsx/ts/tsx 四值，.cjs/.mjs/.cts/.mts 需要归一化；
    // 遗漏这一步会让 oxc 把 cjs 当未知语言而报错或跳过转译。
    if (ext === 'cjs' || ext === 'mjs') {
      lang = 'js'
    } else if (ext === 'cts' || ext === 'mts') {
      lang = 'ts'
    } else {
      lang = ext as 'js' | 'jsx' | 'ts' | 'tsx'
    }
  }

  // 注意展开顺序：sourcemap 默认 true（上层要拿 map 合并），但允许 options.sourcemap 覆盖；
  // inputMap 与 lang 放在最后，确保它们是本次调用计算出的值，不会被 options 里的旧值盖掉。
  const resolvedOptions = {
    sourcemap: true,
    ...options,
    inputMap: inMap as SourceMap | undefined,
    lang,
  }

  // 第四个参数是 tsconfig 解析缓存：只有当调用方没有指定 tsconfig，或指定的正是 config 里的那份时，
  // 才能复用按 config 缓存的解析器；否则（例如插件传入自定义 tsconfig）必须传 undefined，
  // 让 oxc 自己解析，避免拿到另一份 tsconfig 的缓存结果。
  // transformSync 是同步的原生调用；外层 async 只为让调用方统一 await（未来实现也可替换成异步）。
  const result = transformSync(
    filename,
    code,
    resolvedOptions,
    options?.tsconfig === undefined || options.tsconfig === config?.tsconfig
      ? getTSConfigResolutionCache(config)
      : undefined,
  )
  // rolldown 会回报本次转译实际用到的 tsconfig 文件（含 extends 链上的每一个），
  // 因为它们会影响产物；dev 下必须加入 watcher，否则用户改 tsconfig 后模块不会失效。
  // 消费方：server 侧的 reloadOnTsconfigChange（plugins/esbuild.ts）根据 watcher 事件做缓存清理/重启。
  // 注意 ensureWatchedFile 只登记「root 之外」的文件（root 内的由 chokidar 目录监听覆盖）。
  if (
    watcher &&
    config &&
    result.tsconfigFilePaths &&
    result.tsconfigFilePaths.length > 0
  ) {
    for (const tsconfigFile of result.tsconfigFilePaths) {
      ensureWatchedFile(watcher, normalizePath(tsconfigFile), config.root)
    }
  }

  // 错误聚合：oxc 一次转译可能返回多条错误（例如多个语法问题），全部抛会让终端刷屏，
  // 因此 message 只保留前 5 条，其余折叠成 '...'；完整数组仍挂在 errors 属性上供上层处理。
  // 注意第 6 条起才 break，所以实际展示 5 条 + 省略号。
  if (result.errors.length > 0) {
    // Copy from rolldown's packages/rolldown/src/utils/errors.ts
    let summary = `Transform failed with ${result.errors.length} error${result.errors.length < 2 ? '' : 's'}:\n`
    for (let i = 0; i < result.errors.length; i++) {
      summary += '\n'
      if (i >= 5) {
        summary += '...'
        break
      }
      summary += getErrorMessage(result.errors[i])
    }

    const wrapper = new Error(summary)
    // expose individual errors as getters so that
    // `console.error(wrapper)` doesn't expand unnecessary details
    // when they are already presented in `wrapper.message`
    // 用 accessor 而非普通字段：util.inspect 默认不调用 getter（显示为 [Getter]），
    // 因此打印 wrapper 时不会把每条错误的完整结构再展开一遍；
    // 而 set 一旦被调用就把 accessor 换成普通属性，方便上层直接替换 errors 数组。
    Object.defineProperty(wrapper, 'errors', {
      configurable: true,
      enumerable: true,
      get: () => result.errors,
      set: (value) => {
        Object.defineProperty(wrapper, 'errors', {
          configurable: true,
          enumerable: true,
          value,
        })
      },
    })
    throw wrapper
  }
  return result
}

// 告警去重表：同一个 tsconfig 会被成百上千个文件命中，若不按 message 去重，
// 一条「不支持某 tsconfig 选项」的提示会把终端刷满。
// 调用点：本文件 oxcPlugin.transform 中 `if (!shouldSkipWarning(warning)) this.warn(warning)`。
// 只对 UNSUPPORTED_TSCONFIG_OPTION 去重；其它告警每次都要报（可能来自不同文件/不同原因）。
const warnedMessages = new Set<string>()
function shouldSkipWarning(warning: RolldownLog): boolean {
  if (warning.code === 'UNSUPPORTED_TSCONFIG_OPTION') {
    if (warnedMessages.has(warning.message)) return true
    warnedMessages.add(warning.message)
  }
  return false
}

// ─────────────── dev 转译插件 ───────────────
// 作用：在 dev（非 isBundled）环境把 TS/JSX 转成纯 JS，并按需注入 react-refresh 边界与 jsxInject 前缀。
// 调用点：plugins/index.ts 的 createPluginHookUtils（`config.oxc !== false ? oxcPlugin(config) : null`）。
// 关键参数：config.oxc 已由 config.ts 归一化（用户写 esbuild 时会被翻译成 oxc 选项）。
//   这里用 `as OxcOptions` 断言，因为注册点已排除 false/undefined 两种情况。
// 失败模式：
//   - 转译失败 → transformWithOxc 抛聚合错误，pluginContainer 补插件名与代码帧后上报；
//   - 未通过 include/exclude → transform 返回 undefined，代码原样传给下一个插件。
// 执行顺序：本插件必须早于 importAnalysis（后者要求源码已是纯 JS），见 plugins/index.ts 的数组顺序。
export function oxcPlugin(config: ResolvedConfig): Plugin {
  const options = config.oxc as OxcOptions
  // 把 Vite 特有字段（过滤/注入）摘出来，剩下的才是可以直接透传给 oxc 的转译选项。
  const {
    jsxInject,
    include,
    exclude,
    jsxRefreshInclude,
    jsxRefreshExclude,
    ...oxcTransformOptions
  } = options

  // 默认只处理 TS/JSX，跳过普通 .js：JS 无需转译，走一遍 oxc 只会浪费时间和 map。
  // createFilter 内部用 picomatch 生成匹配函数（见 ../utils）。
  const filter = createFilter(include || /\.(m?ts|[jt]sx)$/, exclude || /\.js$/)
  // refresh 的过滤器只在用户显式配置时创建：undefined 表示「不给额外白名单，完全按文件内容判断」。
  const jsxRefreshFilter =
    jsxRefreshInclude || jsxRefreshExclude
      ? createFilter(jsxRefreshInclude, jsxRefreshExclude)
      : undefined

  // jsx.importSource 可能是字符串（预设 'react'/'react-jsx'）或对象；对象才有 importSource 字段。
  // 这两个运行时模块名用于判断「该文件是否已经在使用 jsx-runtime」，是 refresh 注入的必要条件之一。
  const jsxImportSource =
    (typeof oxcTransformOptions.jsx === 'object' &&
      oxcTransformOptions.jsx.importSource) ||
    'react'
  const jsxImportRuntime = `${jsxImportSource}/jsx-runtime`
  const jsxImportDevRuntime = `${jsxImportSource}/jsx-dev-runtime`

  // 作用：为单个文件计算最终的 oxc 选项（主要处理 sourcemap 与 refresh 两个动态开关）。
  // 调用点：本文件 oxcPlugin.transform，转译前调用。
  // 关键参数：id 含 query，按需 split；code 用于判断是否已引用 jsx runtime。
  // 失败模式：无——纯对象计算；非法 jsx 配置由 oxc 自己报错。
  const getModifiedOxcTransformOptions = (
    oxcTransformOptions: OxcTransformOptions,
    id: string,
    code: string,
    environment: Environment,
  ): OxcTransformOptions => {
    const result: OxcTransformOptions = {
      ...oxcTransformOptions,
      // dev 一律要 map（调试需要）；build 只在用户开启 build.sourcemap 时生成，
      // 否则构建产物既不需要 map，也会拖慢 rolldown 的 map 串联。
      sourcemap:
        environment.mode !== 'build' || !!environment.config.build.sourcemap,
    }

    const jsxOptions = result.jsx

    // disable refresh based by the same condition as @vitejs/plugin-react
    // https://github.com/vitejs/vite-plugin-react/blob/c8ecad052001b6fc42e508f18433e6b305bca641/packages/plugin-react/src/index.ts#L261-L269
    // 用「文件名去 query 后是否以 x 结尾」判断 JSX/TSX；不能直接用 JS_TYPES_RE，
    // 因为 Vue 的虚拟块 id 以 `?lang.tsx` 结尾，实际文件并非 .tsx。
    // 三个关闭条件任一命中就不注入 refresh：
    //   a) server consumer —— refresh 是浏览器端 HMR 运行时，SSR 注入只会出错；
    //   b) 用户配了 jsxRefreshFilter 且该 id 不匹配 —— 显式排除；
    //   c) 文件既不是 .jsx/.tsx、代码里也没有 jsx-runtime 引用 —— 说明它根本不产出 JSX 组件，
    //      强行注入会改变模块边界并让 react-refresh 误判边界。
    const [filepath] = id.split('?')
    const isJSX = filepath.endsWith('x')

    if (
      typeof jsxOptions === 'object' &&
      jsxOptions.refresh &&
      (environment.config.consumer === 'server' ||
        (jsxRefreshFilter && !jsxRefreshFilter(id)) ||
        !(
          isJSX ||
          code.includes(jsxImportRuntime) ||
          code.includes(jsxImportDevRuntime)
        ))
    ) {
      result.jsx = { ...jsxOptions, refresh: false }
    }
    // 反向情况：用户显式要求对某类非 JS 文件注入 refresh（例如 MDX/markdown 插件已把内容
    // 转成 JSX），此时 oxc 不能按 id 的扩展名推断语言，必须强制 lang='js'。
    // 判断条件是「JS_TYPES_RE 对原始 id 和 cleanUrl(id) 都不匹配」——即确实不是 JS 类文件。
    if (
      jsxRefreshFilter?.(id) &&
      !JS_TYPES_RE.test(id) &&
      !JS_TYPES_RE.test(cleanUrl(id))
    ) {
      result.lang = 'js'
    }

    return result
  }

  // server 只用于拿 watcher：transform 钩子只有 environment 可用，而 watcher 挂在 dev server 上。
  let server: ViteDevServer

  return {
    name: 'vite:oxc',
    // applyToEnvironment 可以返回 true（沿用本插件）或一个插件对象（替换本插件）。
    // 这里在 isBundled（生产构建 / bundledDev）时替换成 rolldown 的原生 oxc 插件：
    // 整包场景下转译由 rolldown 内部完成，用原生插件可避免 JS↔Rust 往返，
    // 同时保证 include/exclude/jsx refresh 判定与 JS 版语义一致。
    applyToEnvironment(environment) {
      if (environment.config.isBundled) {
        // 注意这里读的是 environment.config.oxc 而不是闭包里的 options：
        // bundled 环境可能有环境级覆盖（environments[name].oxc）。
        const {
          jsxInject,
          include = /\.(m?ts|[jt]sx)$/,
          exclude = /\.js$/,
          jsxRefreshInclude,
          jsxRefreshExclude,
          ..._transformOptions
        } = environment.config.oxc as Exclude<OxcOptions, false | undefined>

        const transformOptions: OxcTransformOptions = _transformOptions
        // 与 JS 版保持同一规则：dev 要 map，build 看 build.sourcemap。
        transformOptions.sourcemap =
          environment.config.mode !== 'build' ||
          !!environment.config.build.sourcemap

        return nativeTransformPlugin({
          root: environment.config.root,
          tsconfig: environment.config.tsconfig,
          include,
          exclude,
          jsxRefreshInclude,
          jsxRefreshExclude,
          isServerConsumer: environment.config.consumer === 'server',
          jsxInject,
          transformOptions,
        })
      }
      return true
    },
    // 只做一件事：把 server 存起来，供 transformWithOxc 登记 tsconfig watch 时使用。
    configureServer(_server) {
      server = _server
    },
    // transform：三个入口条件的 OR 关系——
    //   filter(id)            —— 常规 .ts/.tsx/.jsx（含带 query 的虚拟 id）；
    //   filter(cleanUrl(id))  —— `a.ts?raw` 这类 query 不是语言后缀的情况，去掉 query 再匹配；
    //   jsxRefreshFilter?.(id)—— 用户显式要求注入 refresh 的非 JS 文件（见上文的 lang='js' 强制）。
    async transform(code, id) {
      if (filter(id) || filter(cleanUrl(id)) || jsxRefreshFilter?.(id)) {
        const modifiedOxcTransformOptions = getModifiedOxcTransformOptions(
          oxcTransformOptions,
          id,
          code,
          this.environment,
        )
        const result = await transformWithOxc(
          code,
          id,
          modifiedOxcTransformOptions,
          undefined,
          config,
          server?.watcher,
        )
        // jsxInject 只注入 JSX/TSX：给 .ts 或不含 JSX 的文件注入 `import React` 会产生无用导入。
        // 前置的 `;` 是防御 ASI：若注入内容是 `import ...` 之外的语句（或后续拼接），
        // 没有分号可能与原有的首行代码粘连成一次函数调用。
        if (jsxInject && jsxExtensionsRE.test(id)) {
          result.code = jsxInject + ';' + result.code
        }
        // 把 oxc 的结构化告警转成 Vite 告警（带 plugin 名与当前文件上下文），
        // 并跳过重复的 tsconfig 选项提示。
        for (const warning of result.warnings) {
          if (!shouldSkipWarning(warning)) {
            this.warn(warning)
          }
        }
        return {
          code: result.code,
          map: result.map,
          // moduleType 会传给后续插件的 transform(code, id, options)：告诉它们这段代码是 JS，
          // 影响 filter 的第三个参数与 rolldown 的 module type 推断。
          moduleType: 'js',
        }
      }
    },
  }
}

type OxcJsxOptions = Exclude<OxcOptions['jsx'], string | undefined>

// 作用：把旧的 `config.esbuild`（esbuild TransformOptions 子集）翻译成 OxcOptions，
// 让升级到 Vite 8 的用户不必立刻改写配置。
// 调用点（Grep 确认）：config.ts 的 resolveConfig 里，仅当用户设置了 config.esbuild 且未设置 config.oxc 时调用；
//   两者同时设置时只告警并以 oxc 为准（config.ts 处理）。
// 关键参数：logger 用于 banner/footer 的弃用提示。
// 失败模式：不抛错。无法一一对应的选项（loader/target/minify/tsconfigRaw 等）被静默丢弃，
//   因为语言由 id 决定、tsconfig 由 rolldown 读取、target 由 build.target 统一控制。
export function convertEsbuildConfigToOxcConfig(
  esbuildConfig: ESBuildOptions,
  logger: Logger,
): OxcOptions {
  // include/exclude/jsxInject 是 Vite 自己的字段，直接搬运；其余是 esbuild 的转译字段。
  const { jsxInject, include, exclude, ...esbuildTransformOptions } =
    esbuildConfig

  const oxcOptions: OxcOptions = {
    jsxInject,
    include,
    exclude,
  }

  // 'preserve' 表示完全不转换 JSX（留给下游工具），oxc 用同名取值直接透传即可。
  if (esbuildTransformOptions.jsx === 'preserve') {
    oxcOptions.jsx = 'preserve'
  } else {
    const jsxOptions: OxcJsxOptions = {}

    switch (esbuildTransformOptions.jsx) {
      // esbuild 的 'automatic' ↔ oxc 的 runtime: 'automatic'，importSource 同名对应。
      case 'automatic':
        jsxOptions.runtime = 'automatic'
        if (esbuildTransformOptions.jsxImportSource) {
          jsxOptions.importSource = esbuildTransformOptions.jsxImportSource
        }
        break
      // esbuild 的 'transform' ↔ oxc 的 runtime: 'classic'；
      // jsxFactory/jsxFragment 分别对应 pragma/pragmaFrag（只是命名不同）。
      case 'transform':
        jsxOptions.runtime = 'classic'
        if (esbuildTransformOptions.jsxFactory) {
          jsxOptions.pragma = esbuildTransformOptions.jsxFactory
        }
        if (esbuildTransformOptions.jsxFragment) {
          jsxOptions.pragmaFrag = esbuildTransformOptions.jsxFragment
        }
        break
      default:
        break
    }

    // jsxDev 控制是否用 jsx-dev-runtime（开发态带 source/self 信息），oxc 里叫 development。
    if (esbuildTransformOptions.jsxDev !== undefined) {
      jsxOptions.development = esbuildTransformOptions.jsxDev
    }
    // 语义取反：esbuild 的 jsxSideEffects=true 表示「JSX 有副作用，不要 tree-shake」，
    // 而 oxc 的 pure 表示「可以当作无副作用调用进行摇树」，所以 pure = !jsxSideEffects。
    if (esbuildTransformOptions.jsxSideEffects !== undefined) {
      jsxOptions.pure = !esbuildTransformOptions.jsxSideEffects
    }

    oxcOptions.jsx = jsxOptions
  }

  // define 在两边结构一致（标识符 → 表达式源码字符串），可直接透传。
  if (esbuildTransformOptions.define) {
    oxcOptions.define = esbuildTransformOptions.define
  }

  // banner/footer 无法用单文件转译表达（它们属于产物级拼接），
  // 由 build 侧的 esbuildBannerFooterCompatPlugin 负责；这里只提示用户改写成插件。
  // these backward compat are supported by esbuildBannerFooterCompatPlugin
  if (esbuildTransformOptions.banner) {
    warnDeprecatedShouldBeConvertedToPluginOptions(logger, 'banner')
  }
  if (esbuildTransformOptions.footer) {
    warnDeprecatedShouldBeConvertedToPluginOptions(logger, 'footer')
  }

  return oxcOptions
}

// 作用：对「无法映射到 oxc 选项、需要改写成插件」的 esbuild 配置给出弃用提示。
// 调用点：本文件 convertEsbuildConfigToOxcConfig 的 banner / footer 分支。
// 为什么不静默忽略：这两个选项仍会影响产物内容——由 esbuildBannerFooterCompatPlugin
// 通过 transform 钩子（dev 与 build 都生效）另行拼接，而不是由 oxc 的转译选项实现。
// 提示用户改用插件，是为了将来移除这条兼容路径时配置不会突然失效。
function warnDeprecatedShouldBeConvertedToPluginOptions(
  logger: Logger,
  name: string,
) {
  logger.warn(
    colors.yellow(
      `\`esbuild.${name}\` option was specified. ` +
        `But this option is deprecated and will be removed in future versions. ` +
        'This option can be achieved by using a plugin with transform hook, please use that instead.',
    ),
  )
}
