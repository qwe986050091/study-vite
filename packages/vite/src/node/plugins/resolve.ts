// 文件角色：内置解析插件组（resolve）。这里定义「一个说明符变成可加载 id」的核心规则，
// 但它导出的是一个插件数组，不是单个插件。
// 上游（谁调用）：
//   - plugins/index.ts 的 resolvePlugins()：在 alias 插件之后、html/css 之前展开 oxcResolvePlugin()，
//     这是主插件流水线里的解析阶段；
//   - idResolver.ts 的 createIdResolver()：用同一套插件建一个旁路的 pluginContainer，
//     给依赖预构建、CSS @import 等场景做「只取 id」的解析（options.idOnly = true）。
//   - 还有几个非插件管线的调用方直接调本文件的 JS 函数：
//     external.ts 的 isExternalizable()、nodeResolve.ts 的 nodeResolveWithVite()、
//     ssr/fetchModule.ts 调 tryNodeResolve；assetImportMetaUrl.ts、workerImportMetaUrl.ts 调 tryFsResolve；
//     dynamicImportVars.ts 调 resolveSubpathImports。
// 下游（oxcResolvePlugin 返回的数组，顺序即执行顺序）：
//   1) optimizerResolvePlugin()（插件名 vite:resolve-dev）：仅 dev + 开启依赖预构建时存在。
//      只做两件「必须在通用解析之前」的事——把已预构建依赖的 URL/文件直接映射成缓存文件路径，
//      以及把裸说明符交给 tryOptimizedResolve 命中已有预构建产物。
//   2) perEnvironmentOrWorkerPlugin('vite:resolve-builtin', ...)：通用解析。真正的解析算法
//      委托给 rolldown 的 viteResolvePlugin（原生实现），本文件负责组装配置，并提供三个 JS 回调
//      （finalizeBareSpecifier / finalizeOtherSpecifiers / resolveSubpathImports）做预构建登记、
//      版本串注入与 #imports 解析。
// 关键不变量：本文件不拼 /@fs/、/@id/ 前缀，也不处理 alias。
//   alias 在更早的插件里完成；/@fs/ 由 server/moduleUrl.ts 的 fileToModuleUrl 产出、
//   moduleUrlToFilePath 还原（见 optimizerResolvePlugin 里 isOptimizedDepUrl 那一支）；
//   /@id/ 由 importAnalysis.ts 的 wrapId 包装虚拟 id 时产出，请求侧由 unwrapId 剥掉。
//   本文件只保证「解析出的 id 已经是绝对路径或虚拟 id」，前缀包装是后续环节的事。
// 容易误解：内核是 rolldown（不是 rollup），所以 tryNodeResolve / tryFsResolve /
//   resolvePackageEntry 这些 JS 实现已不在主解析路径上，但它们的语义必须和原生侧保持一致——
//   否则外部化判定（external.ts）、SSR fetchModule、import.meta.url 解析会得出与主流水线不同的结果。
import fs from 'node:fs'
import path from 'node:path'
import colors from 'picocolors'
import { exports, imports } from 'resolve.exports'
import type { PartialResolvedId } from 'rolldown'
import { viteResolvePlugin } from 'rolldown/experimental'
import type { Environment } from '..'
import {
  cleanUrl,
  splitFileAndPostfix,
  withTrailingSlash,
} from '../../shared/utils'
import type { ResolvedConfig, ResolvedEnvironmentOptions } from '../config'
import {
  CLIENT_ENTRY,
  DEP_VERSION_RE,
  DEV_PROD_CONDITION,
  ENV_ENTRY,
  SPECIAL_QUERY_RE,
} from '../constants'
import { canExternalizeFile } from '../external'
import {
  isDepOptimizationDisabled,
  optimizedDepInfoFromFile,
  optimizedDepInfoFromId,
} from '../optimizer'
import type { DepsOptimizer } from '../optimizer'
import type { PackageCache, PackageData } from '../packages'
import {
  findNearestMainPackageData,
  findNearestPackageData,
  loadPackageData,
  resolvePackageData,
} from '../packages'
import type { Plugin } from '../plugin'
import { moduleUrlToFilePath } from '../server/moduleUrl'
import {
  bareImportRE,
  createDebugger,
  deepImportRE,
  getNpmPackageName,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isInNodeModules,
  isObject,
  isOptimizable,
  normalizePath,
  safeRealpathSync,
  tryStatSync,
} from '../utils'

// client 入口（/@vite/client）与 env 入口的规范化路径。ensureVersionQuery 用它们排除
// 「虚拟入口」：这两个 id 不是磁盘上的依赖，不该被追加 ?v= 版本串。
const normalizedClientEntry = normalizePath(CLIENT_ENTRY)
const normalizedEnvEntry = normalizePath(ENV_ENTRY)

// 包入口解析失败的错误码。resolvePackageEntry 无条件抛出它；
// tryCleanFsResolve 在「目录里恰好有 package.json」这条 best-effort 分支里会把它吞掉，
// 继续去试 index 文件——否则一个 main 字段写坏的包会让整个解析直接失败。
const ERR_RESOLVE_PACKAGE_ENTRY_FAIL = 'ERR_RESOLVE_PACKAGE_ENTRY_FAIL'

// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
// browser 字段值为 false（或对象里映射到 false）时的占位 id。
// 消费方：optimizer/rolldownDepPlugin.ts（打包预构建依赖时换成空模块）、
// importAnalysis.ts（对命名导入做 interop，让运行时报错信息可读）。
export const browserExternalId = '__vite-browser-external'
// special id for packages that are optional peer deps
// 可选 peer 依赖缺失时的占位 id，形如 __vite-optional-peer-dep:<id>:<父包名>。
// 不在解析阶段报错，只有真正 import 到它时才报——这样「可选」语义才成立。
// rolldownDepPlugin.ts 会把它识别成 external 而不是真的去解析。
export const optionalPeerDepId = '__vite-optional-peer-dep'

// #imports 映射（package.json 的 imports 字段）的说明符前缀，只能出现在包内部。
const subpathImportsPrefix = '#'

// 判断一个已解析的 imports 映射结果是不是相对路径（需要再拼回「相对 importer」）。
const relativePrefixRE = /^\.\.?(?:[/\\]|$)/
// preferRelative 模式（HTML 文件里的 src 属性）下，用来判断说明符是否像一个包名。
const startsWithWordCharRE = /^\w/

// 解析明细日志仅在使用 --debug vite:resolve-details 时输出；
// onlyWhenFocused 让未聚焦的 debug 通道不产生日志，避免每次解析都拼字符串。
const debug = createDebugger('vite:resolve-details', {
  onlyWhenFocused: true,
})

// 单环境可覆盖的解析配置。config.ts 会按 consumer（client/ssr）给出默认值：
// client 用 DEFAULT_CLIENT_CONDITIONS，server 用 DEFAULT_SERVER_CONDITIONS。
export interface EnvironmentResolveOptions {
  /**
   * @default ['browser', 'module', 'jsnext:main', 'jsnext']
   */
  // 无 exports 字段时按顺序查找的 package.json 字段。
  // 注意：oxcResolvePlugin 会在末尾追加 'main'（除非 skipMainField），
  // 所以这里的数组仍然可以有 main 已经排在前面，不会重复解析。
  mainFields?: string[]
  // exports/imports 条件解析用的条件列表。DEV_PROD_CONDITION 这个伪条件
  // 会在 getConditions() 里被替换成 production/development。
  conditions?: string[]
  // 外部化时改用另一套条件（external.ts 的 resolveOptions.conditions 就是它），
  // 因为 external 判定不该套用浏览器条件。
  externalConditions?: string[]
  /**
   * @default ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
   */
  // 省略扩展名时的补全顺序；顺序敏感，靠前的先命中。
  extensions?: string[]
  // 强制从 root 开始解析的包名，用于避免同一个包被解析出两份（monorepo 常见）。
  dedupe?: string[]
  // TODO: better abstraction that works for the client environment too?
  /**
   * Prevent listed dependencies from being externalized and will get bundled in build.
   * Only works in server environments for now. Previously this was `ssr.noExternal`.
   * @experimental
   */
  // 不外部化（强制打进产物）的依赖，取代旧的 ssr.noExternal。
  noExternal?: string | RegExp | (string | RegExp)[] | true
  /**
   * Externalize the given dependencies and their transitive dependencies.
   * Only works in server environments for now. Previously this was `ssr.external`.
   * @experimental
   */
  // 外部化的依赖，取代旧的 ssr.external；与 noExternal 的优先级在 external.ts 里裁决。
  external?: string[] | true
  /**
   * Array of strings or regular expressions that indicate what modules are builtin for the environment.
   */
  // 该环境的「内置模块」名单，交给 isBuiltin() 带缓存地判断。
  // client 环境通常包含 nodeLikeBuiltins，于是 node:fs 会被解析成占位模块而不是报错。
  builtins?: (string | RegExp)[]
}

// 全局解析选项（所有环境共用）+ 插件内部开关。
export interface ResolveOptions extends EnvironmentResolveOptions {
  /**
   * @default false
   */
  // true 时不做 realpath：保留符号链接路径。monorepo 里 pnpm link 的项目若希望
  // 「以链接路径为准」（而不是真实路径）就需要它，代价是同一文件可能有两种 id。
  preserveSymlinks?: boolean
  /**
   * Enable tsconfig paths resolution
   *
   * @default false
   */
  // 是否启用 tsconfig 的 paths 别名；实现已下沉到原生 resolver（见下方 tsconfig 参数）。
  tsconfigPaths?: boolean
}

// 创建插件时由调用方（plugins/index.ts / idResolver.ts）显式传入的开关；
// 与 ResolveOptions 合并后成为 InternalResolveOptions。
interface ResolvePluginOptions {
  root: string
  isBuild: boolean
  isProduction: boolean
  // 解析 package.json 的缓存（由 watchPackageDataPlugin 维护）。
  // 传 undefined 时每次都重新读盘：nodeResolveWithVite 故意这么做，因为它面向一次性调用。
  packageCache?: PackageCache
  /**
   * src code mode also attempts the following:
   * - resolving /xxx as URLs
   * - resolving bare imports from optimized deps
   */
  // 源码模式：额外接受「/xxx 当作 URL」与「裸说明符走预构建产物」两种形态。
  // 主流水线与 createIdResolver 都传 true。
  asSrc?: boolean
  // 目录解析时是否尝试 index 文件；默认 true（插件里用 options.tryIndex ?? true）。
  tryIndex?: boolean
  // 找不到文件时再试一次「<dir>/<tryPrefix><basename>」，以及「<dir>/<tryPrefix>index」。
  // 实际只有 sass 解析器传 '_'（css.ts 的 sassResolve 配置）：@import "foo" 要能命中 _foo.scss。
  tryPrefix?: string
  // 把「像包名的说明符」优先当相对路径解析；HTML 里 src="foo.png" 这类场景需要。
  preferRelative?: boolean
  // 说明符来自 require() 调用：exports 条件里推入 'require' 而不是 'import'。
  isRequire?: boolean
  // True when resolving during the scan phase to discover dependencies
  // 预构建扫描阶段：不做真实预构建登记、也不注入 ?v=，只求「能解析出路径」。
  scan?: boolean
  /**
   * @internal
   */
  // 跳过在 mainFields 末尾追加 'main' 的补丁，只在需要严格对照用户配置时使用。
  skipMainField?: boolean

  /**
   * Optimize deps during dev, defaults to false // TODO: Review default
   * @internal
   */
  // 是否启用依赖预构建。注意它是 opt-in：createIdResolver 走的是「只解析不预构建」路径，
  // 所以不能仅凭 config 推断，必须由创建者显式打开。
  optimizeDeps?: boolean

  /**
   * Externalize using `resolve.external` and `resolve.noExternal` when running a build in
   * a server environment. Defaults to false (only for createResolver)
   * @internal
   */
  // 服务端构建时按 resolve.external / resolve.noExternal 做外部化判定。
  // 打开后 tryNodeResolve 会走 processResult，把结果标成 external: true。
  externalize?: boolean

  /**
   * Set by createResolver, we only care about the resolved id. moduleSideEffects
   * and other fields are discarded so we can avoid computing them.
   * @internal
   */
  // 只关心 id：跳过 moduleSideEffects / packageJsonPath 的计算（那是构建期
  // tree-shaking 才需要的），避免每次 CSS/预构建解析都多读一次 package.json。
  idOnly?: boolean

  /**
   * Set by `nodeResolveWithVite`, disables optional peer dependency handling.
   * @internal
   */
  // 关闭「可选 peer 依赖返回占位 id」的行为。nodeResolveWithVite 要的是
  // 严格 Node 语义：找不到就返回 undefined，而不是给一个占位 id。
  disableOptionalPeerDepHandling?: boolean

  /**
   * Enable when `legacy.inconsistentCjsInterop` is true. See that option for more details.
   */
  // 兼容旧版 CJS interop：为 true 时 findNearestPackagePath 才返回 package.json 路径，
  // 让 rolldown 用旧规则推断模块格式。
  legacyInconsistentCjsInterop?: boolean
}

export interface InternalResolveOptions
  extends Required<ResolveOptions>, ResolvePluginOptions {}

// Defined ResolveOptions are used to overwrite the values for all environments
// It is used when creating custom resolvers (for CSS, scanning, etc)
export interface ResolvePluginOptionsWithOverrides
  extends ResolveOptions, ResolvePluginOptions {}

// 作用：把「一个只在单环境内成立的插件」包装成「能同时服务多个环境的插件对」。
// 调用点：本文件内被 oxcResolvePlugin() 调用（vite:resolve-builtin 就是它的产物）。
// 关键参数：
//   - name：插件名；
//   - overrideEnvConfig：非空时（worker 场景，plugins/index.ts 传进来的 worker 配置）
//     强制只给 'client' 环境建一个实例，因为 worker 有自己的 root/consumer；
//   - f：按环境惰性创建真正插件的工厂，第二个参数 getEnvironment 让它能在运行时
//     拿到「当前环境」对象（拿 depsOptimizer、logger 等）。
// 失败模式：getEnvironment 返回 undefined 时，下游 getDepsOptimizer 会抛
//   'The environment mode should be dev' / 'The environment should have a depsOptimizer'。
//   这不是配置错误，而是「解析发生在 dev 环境但依赖优化器还没就绪」（例如 build 期或
//   createIdResolver 用 buildStart 未被触发的容器）。
const perEnvironmentOrWorkerPlugin = (
  name: string,
  overrideEnvConfig: (ResolvedConfig & ResolvedEnvironmentOptions) | undefined,
  f: (
    env: {
      name: string
      config: ResolvedConfig & ResolvedEnvironmentOptions
    },
    getEnvironment: () => Environment,
  ) => Plugin,
): Plugin[] => {
  // 环境名 → Environment 的登记表。惰性收集的原因：插件对象是按环境创建的，
  // 但某些配置项（root、logger）只有在 Environment 建好后才能读到。
  const envs: Record<string, Environment> = {}
  // 这个前置插件只干一件事：在每个环境的 buildStart 把 Environment 存进 envs。
  // 必须排在被包装插件之前，且 perEnvironmentStartEndDuringDev 让 dev 下的
  // setup/teardown 语义与 build 一致，否则 dev 里不会触发 buildStart，envs 永远是空的。
  const getEnvironmentPlugin: Plugin = {
    name: `${name}:get-environment`,
    buildStart() {
      envs[this.environment.name] = this.environment
    },
    perEnvironmentStartEndDuringDev: true,
  }
  // 按名字取环境；f 的闭包在解析时才调用它，保证拿到的是当前环境而不是创建时的快照。
  const createGetEnvironment = (name: string) => () => envs[name]

  if (overrideEnvConfig) {
    // worker 分支：worker 的配置不是 config.environments 里的正式成员，
    // 只能手工伪造一个名为 'client' 的环境配置，并固定用 'client' 作为查找键。
    return [
      getEnvironmentPlugin,
      f(
        { name: 'client', config: overrideEnvConfig },
        createGetEnvironment('client'),
      ),
    ]
  }
  // 常规分支：插件本身不绑定环境，applyToEnvironment 在 rolldown/vite 建每个环境
  // 的插件容器时被调用一次，返回该环境专属的插件实例。
  return [
    getEnvironmentPlugin,
    {
      name,
      applyToEnvironment(environment) {
        return f(environment, createGetEnvironment(environment.name))
      },
    },
  ]
}

// 作用：构造「内置解析插件组」。注意返回 Plugin[]，调用方必须展开（...）：
//   [0] optimizerResolvePlugin（仅 dev + optimizeDeps 时存在）
//   [1] vite:resolve-builtin 的 get-environment 前置插件
//   [2] vite:resolve-builtin 本体（每环境一份）
// 为什么顺序不能换：
//   - vite:resolve-dev 必须在前：它认领的是「已预构建依赖」的 id，这类 id 在磁盘上
//     可能还不存在（预构建正在重跑），通用解析会直接返回 undefined；
//     让它先命中，才不会把并发重构建期间的请求打空。
//   - get-environment 必须在 resolve-builtin 之前：它负责在 buildStart 里登记 Environment，
//     而 resolve-builtin 的回调（finalizeBareSpecifier）要在解析时才用 depsOptimizer。
// 调用点：plugins/index.ts 的 resolvePlugins()（位于 alias 之后、html/css 之前）；
//   idResolver.ts 的 createIdResolver()（第三个参数 isJsPluginContainer = true，
//   用于 CSS @import、预构建扫描等「只要 id」的旁路解析）。
// 关键参数：
//   - resolveOptions：插件级覆盖值，优先级高于每个环境的 config.resolve（见下方 options 展开顺序）；
//   - overrideEnvConfig：worker 专用环境配置；非空时不做 applyToEnvironment；
//   - isJsPluginContainer：标记「这是纯 JS 侧插件容器」，只影响 warning 上报路径。
// 失败模式：
//   - 环境不是 dev 或没有 depsOptimizer：只会在 finalizeBareSpecifier 被调用时抛错，
//     所以只有真的碰到裸说明符才会暴露；
//   - 解析失败最终由原生 resolver 抛错（本函数不捕获）。
export function oxcResolvePlugin(
  resolveOptions: ResolvePluginOptionsWithOverrides,
  overrideEnvConfig: (ResolvedConfig & ResolvedEnvironmentOptions) | undefined,
  isJsPluginContainer = false,
): Plugin[] {
  return [
    // 条件：构建期不预构建（build 由 rolldown 自己打包依赖），因此只在 dev 才加。
    // 这里用插件级 resolveOptions.isBuild 而非环境级 config：预构建只对「非 build 命令」有意义。
    ...(resolveOptions.optimizeDeps && !resolveOptions.isBuild
      ? [optimizerResolvePlugin(resolveOptions)]
      : []),
    ...perEnvironmentOrWorkerPlugin(
      'vite:resolve-builtin',
      overrideEnvConfig,
      (partialEnv, getEnv) => {
        // The resolve plugin is used for createIdResolver and the depsOptimizer should be
        // disabled in that case, so deps optimization is opt-in when creating the plugin.
        // 四个条件同时成立才算「本环境启用依赖预构建」：
        //   1) 插件级打开了 optimizeDeps（createIdResolver 不传，所以旁路解析不会误登记）；
        //   2) 非 build 命令；
        //   3) 本环境不是 bundled（bundledDev/worker 走全量打包，不需要逐依赖预构建）；
        //   4) 用户没显式关闭 optimizeDeps。
        // 这个布尔值决定是否给原生 resolver 挂 finalize* 回调：不挂时裸说明符直接返回
        // 真实文件路径，挂上时返回值可能被替换成 ?v= 版本串或预构建产物路径。
        const depsOptimizerEnabled =
          resolveOptions.optimizeDeps &&
          !resolveOptions.isBuild &&
          !partialEnv.config.isBundled &&
          !isDepOptimizationDisabled(partialEnv.config.optimizeDeps)
        // 惰性取 depsOptimizer：解析时才调用，避免插件创建早于 optimizer 初始化。
        // 两个 throw 都是内部契约检查，命中说明调用时机错了，而不是用户配置错。
        const getDepsOptimizer = () => {
          const env = getEnv()
          if (env.mode !== 'dev')
            throw new Error('The environment mode should be dev')
          if (!env.depsOptimizer)
            throw new Error('The environment should have a depsOptimizer')
          return env.depsOptimizer
        }

        // 合并顺序：先环境配置，再用插件级覆盖值盖掉。
        // 这就是 createIdResolver 能对 CSS/sass 单独定制 mainFields/extensions 的原因
        // （css.ts 的 sassResolve 传 mainFields: ['sass','style']）。
        const options: InternalResolveOptions = {
          ...partialEnv.config.resolve,
          ...resolveOptions, // plugin options + resolve options overrides
        }
        // 原生侧只接受数组形态的 noExternal；字符串/true 在这里归一化，
        // 不做这步会让外部化判定把 noExternal 当成「未设置」。
        const noExternal =
          Array.isArray(options.noExternal) || options.noExternal === true
            ? options.noExternal
            : [options.noExternal]

        // 真正的解析器来自 rolldown/experimental（原生实现）。本文件只负责：
        // 传配置、传条件、传三个回调。旧版 JS 版 resolvePlugin 已不在本文件中。
        const plugin = viteResolvePlugin({
          // tsconfig 的 paths/baseUrl 解析也在原生侧完成，这里只把解析后的 tsconfig 传过去。
          tsconfig: partialEnv.config.tsconfig,
          resolveOptions: {
            isBuild: options.isBuild,
            isBundled: partialEnv.config.isBundled,
            isProduction: options.isProduction,
            asSrc: options.asSrc ?? false,
            preferRelative: options.preferRelative ?? false,
            isRequire: options.isRequire,
            root: options.root,
            scan: options.scan ?? false,

            // 在用户配置的 mainFields 后面补 'main'。原因：默认 mainFields 是
            // ['browser','module','jsnext:main','jsnext']，不含 main；而 Node 生态里
            // 大量包只有 main 字段，不补就会退到 index.js 而解析错包。
            // skipMainField 用于 sass 这类自定义解析（mainFields: ['sass','style']），
            // 它们不希望 main 兜底。
            mainFields: options.skipMainField
              ? options.mainFields
              : [...options.mainFields, 'main'],
            conditions: options.conditions,
            externalConditions: options.externalConditions,
            extensions: options.extensions,
            tryIndex: options.tryIndex ?? true,
            tryPrefix: options.tryPrefix,
            preserveSymlinks: options.preserveSymlinks,
            tsconfigPaths: options.tsconfigPaths,
          },
          // consumer 决定默认条件集（client 不含 node 条件，server 含 node）；
          // 传错会把浏览器包解析到 Node 入口。
          environmentConsumer: partialEnv.config.consumer,
          environmentName: partialEnv.name,
          // SSR + webworker target 的 build 才需要把 require('node:xxx') 转成 external require，
          // 其他组合保持普通 import 语义。
          convertExternalRequire:
            options.isBuild &&
            partialEnv.name === 'ssr' &&
            partialEnv.config.ssr.target === 'webworker',
          // builtins 决定 isBuiltin 的结果：命中后直接当内置模块处理，不再查 node_modules；
          // client 环境下 node:fs 因此变成 browserExternalId 空壳而不是解析失败。
          builtins: partialEnv.config.resolve.builtins,
          // external / noExternal / dedupe 直接交给原生侧的 external 判定与 basedir 选择。
          // 注意这里只是「解析时」的外部化（对应 resolve.external / resolve.noExternal，即
          // 旧的 ssr.external / ssr.noExternal），裁决逻辑在 external.ts 的
          // createIsConfiguredAsExternal；而 build.rollupOptions/rolldownOptions.external
          // 是给 rolldown 的构建配置，不经过这个参数。
          external: options.external,
          noExternal: noExternal,
          dedupe: options.dedupe,
          // dev 下把 server.watch 设为 null（关闭文件监听）时必须禁用原生 resolver 的缓存，
          // 否则改文件后 id 不会更新。注意这里用的是 ===，只匹配显式 null；
          // 紧邻的 eslint-disable eqeqeq 与 === 并不对应，属上游遗留注释。
          disableCache:
            partialEnv.config.command === 'serve' &&
            // eslint-disable-next-line eqeqeq
            partialEnv.config.server.watch === null,
          legacyInconsistentCjsInterop: options.legacyInconsistentCjsInterop,
          // 裸说明符的「最终加工」：原生侧解析出真实文件后回调到这里，
          // 由 JS 侧决定「注入 ?v= 版本串」还是「登记为缺失依赖并改写成预构建产物路径」。
          // 不启用预构建时传 undefined，原生侧就直接用解析结果。
          finalizeBareSpecifier: !depsOptimizerEnabled
            ? undefined
            : (resolvedId, rawId, importer) => {
                const depsOptimizer = getDepsOptimizer()
                // if we reach here, it's a valid dep import that hasn't been optimized.
                const isJsType = isOptimizable(
                  resolvedId,
                  depsOptimizer.options,
                )
                const exclude = depsOptimizer?.options.exclude

                // check for deep import, e.g. "my-lib/foo"
                const deepMatch = deepImportRE.exec(rawId)
                // package name doesn't include postfixes
                // trim them to support importing package with queries (e.g. `import css from 'normalize.css?inline'`)
                // pkgId 只用包名（my-lib），后面 exclude 匹配按「包名」和「原始说明符」两种粒度都试。
                const pkgId = deepMatch
                  ? deepMatch[1] || deepMatch[2]
                  : cleanUrl(rawId)

                // 以下情形任一命中就跳过预构建登记，只注入版本串：
                //   - noDiscovery：用户要求完全不做依赖发现（optimizeDeps.noDiscovery）；
                //   - 非 JS 类型（css/json/asset），预构建没意义；
                //   - importer 已在 node_modules 内：依赖的依赖由预构建器统一处理，不在 dev 解析里登记；
                //   - 命中 optimizeDeps.exclude（包名或完整 id 均可）；
                //   - 带 ?worker/?raw/?url 等特殊查询串：这些由其它插件接管。
                const skipOptimization =
                  depsOptimizer.options.noDiscovery ||
                  !isJsType ||
                  (importer && isInNodeModules(importer)) ||
                  exclude?.includes(pkgId) ||
                  exclude?.includes(rawId) ||
                  SPECIAL_QUERY_RE.test(resolvedId)

                let newId = resolvedId
                if (skipOptimization) {
                  // excluded from optimization
                  // Inject a version query to npm deps so that the browser
                  // can cache it without re-validation, but only do so for known js types.
                  // otherwise we may introduce duplicated modules for externalized files
                  // from pre-bundled deps.
                  // 版本串取 browserHash：预构建产物一变 hash 就变，浏览器缓存自然失效。
                  // 只对 JS 类型注入，避免给 css/asset 造出重复模块。
                  const versionHash = depsOptimizer!.metadata.browserHash
                  if (versionHash && isJsType) {
                    newId = injectQuery(newId, `v=${versionHash}`)
                  }
                } else {
                  // this is a missing import, queue optimize-deps re-run and
                  // get a resolved its optimized info
                  // 关键分支：这是「新发现的依赖」。registerMissingImport 把它排进下一次
                  // 预构建批次并返回 optimizedInfo（产物还没落盘也可能返回）；
                  // getOptimizedDepId 拼出 `${file}?v=${browserHash}` 交给浏览器。
                  // 带 ?v= 的目的：产物一变 browserHash 就变，URL 随之改变，浏览器不会拿到旧缓存；
                  // 若浏览器仍请求旧 hash（预构建期间又发现新依赖、导致本轮被 cancel），
                  // 请求会落到 optimizedDeps.ts 的 throwOutdatedRequest()，
                  // 那里抛 ERR_OUTDATED_OPTIMIZED_DEP，transform 中间件回 504 让页面整刷重取。
                  // 所以这里既不能吞异常，也不能自己编 hash——必须交给 optimizer 的统一出口。
                  const optimizedInfo = depsOptimizer!.registerMissingImport(
                    rawId,
                    newId,
                  )
                  newId = depsOptimizer!.getOptimizedDepId(optimizedInfo)
                }
                return newId
              },
          // 非裸说明符（相对/绝对路径）的加工：只负责给 node_modules 里的直接引用
          // 补上和「裸说明符路径」一致的 ?v= 版本串，保证同一个文件只有一种 id。
          // 返回 undefined 表示「不改」，原生侧沿用原值。
          finalizeOtherSpecifiers: !depsOptimizerEnabled
            ? undefined
            : (resolvedId, rawId) => {
                const depsOptimizer = getDepsOptimizer()
                const newResolvedId = ensureVersionQuery(
                  resolvedId,
                  rawId,
                  options,
                  depsOptimizer,
                )
                return newResolvedId === resolvedId ? undefined : newResolvedId
              },
          // #imports 字段解析仍留在 JS 侧（依赖 resolve.exports 的 imports()）。
          // isRequire 的取值优先级：插件级显式配置 > 原生侧传来的本次解析 kind。
          resolveSubpathImports(id, importer, isRequire) {
            return resolveSubpathImports(id, importer, {
              ...options,
              isRequire: resolveOptions.isRequire ?? isRequire,
            })
          },

          // 警告上报：createIdResolver 的容器不会触发 buildStart，所以不能用 getEnv()，
          // 必须用创建时捕获的 partialEnv.config.logger。
          ...(partialEnv.config.command === 'serve' || isJsPluginContainer
            ? {
                async onWarn(msg) {
                  // use `partialEnv` instead of `getEnv()` because `buildStart` is
                  // not called for plugin container used by `createIdResolver`
                  partialEnv.config.logger.warn(`warning: ${msg}`, {
                    clear: true,
                    timestamp: true,
                  })
                },
              }
            : {}),
          // 调试钩子：只有在 --debug vite:resolve-details 打开时 debug 才非空。
          ...(debug
            ? {
                async onDebug(message) {
                  debug(message)
                },
              }
            : {}),
        })
        // 插件容器返回的是 rollup 兼容形状，这里补上 Vite 的 dev 期 watch 语义标记：
        // dev 下 watchChange 需要按环境分别派发，否则一个环境改文件会漏掉另一个环境。
        ;(plugin as Plugin).perEnvironmentWatchChangeDuringDev = true
        return plugin
      },
    ),
  ]
}

// 作用：dev + 依赖预构建专用解析插件（插件名 vite:resolve-dev）。它排在通用解析之前，
//   只认领两类 id，其余一律返回 undefined 交给下一个插件：
//   a) 已经是预构建产物的 URL/文件（可能尚未落盘）；
//   b) 裸说明符，且能在现有预构建元数据里命中（tryOptimizedResolve）。
// 调用点：本文件 oxcResolvePlugin() 里按 `optimizeDeps && !isBuild` 条件插入。
// 关键参数：
//   - resolveOptions.root：把 /@fs/ 形式的 URL 还原成文件路径时的根；
//   - resolveOptions.asSrc：只有源码模式才做「预构建产物短路」与「裸说明符命中」，
//     否则（例如预构建器自己的解析）要拿到真实文件路径；
//   - resolveOpts.kind：'require-call' 会改变 exports 条件（require vs import）。
// 失败模式：本插件不抛错；环境未就绪（无 depsOptimizer）时静默返回 undefined，
//   由后面的 vite:resolve-builtin 兜底，所以「漏认领」表现为走通用解析而不是报错。
function optimizerResolvePlugin(
  resolveOptions: ResolvePluginOptionsWithOverrides,
): Plugin {
  const { root, asSrc } = resolveOptions

  return {
    name: 'vite:resolve-dev',
    // bundled 环境不需要预构建（整包由 rolldown 打），整体禁用预构建时也不必插入。
    applyToEnvironment(environment) {
      return (
        !environment.config.isBundled &&
        !isDepOptimizationDisabled(environment.config.optimizeDeps)
      )
    },
    resolveId: {
      // filter 只覆盖「可能属于预构建产物」的形态，把绝大多数 id 在 JS 之外就过滤掉，
      // 避免每个模块解析都进一次 JS handler（这是热路径，filter 在原生侧执行）。
      // 排除项：
      //   \0/...      —— 虚拟模块（rolldown 约定，Vite 内部大量使用）；
      //   virtual:    —— 插件产出的虚拟模块；
      //   /virtual:   —— 直接在 HTML 里写 /virtual:xxx 时浏览器请求的形态；
      //   __vite-     —— Vite 自己的内部 id（browserExternalId、optionalPeerDepId 等）。
      filter: {
        id: {
          exclude: [
            /^\0/,
            /^virtual:/,
            // When injected directly in html/client code
            /^\/virtual:/,
            /^__vite-/,
          ],
        },
      },
      async handler(id, importer, resolveOpts) {
        // The resolve plugin is used for createIdResolver and the depsOptimizer should be
        // disabled in that case, so deps optimization is opt-in when creating the plugin.
        // 双重保险：插件级 optimizeDeps 为 false（createIdResolver 场景）或当前不是 dev，
        // 都不接管。返回 undefined 表示「我没意见」，不是「解析失败」。
        const depsOptimizer =
          resolveOptions.optimizeDeps && this.environment.mode === 'dev'
            ? this.environment.depsOptimizer
            : undefined
        if (!depsOptimizer) {
          return
        }

        // 与 oxcResolvePlugin 相同的合并顺序；scan 优先取本次 resolve 的标记
        // （预构建扫描时传入 scan=true，此时不做真实登记）。
        const options: InternalResolveOptions = {
          isRequire: resolveOpts.kind === 'require-call',
          ...this.environment.config.resolve,
          ...resolveOptions,
          scan: resolveOpts.scan ?? resolveOptions.scan,
        }
        // HTML 里的 src/href 常写成包名形态（如 "foo.png"），对 HTML 的 importer
        // 默认按相对路径理解，否则会被当成 npm 包去 node_modules 找。
        options.preferRelative ||= importer?.endsWith('.html')

        // resolve pre-bundled deps requests, these could be resolved by
        // tryFileResolve or /fs/ resolution but these files may not yet
        // exists if we are in the middle of a deps re-processing
        // 已经是预构建产物 URL（/@fs/.../node_modules/.vite/deps/xxx.js?v=hash）的请求：
        // 直接换成文件路径，不查磁盘——重构建期间文件可能被临时删掉/尚未写出。
        // moduleUrlToFilePath 负责把 /@fs/ 前缀还原成绝对路径（见 server/moduleUrl.ts）。
        if (asSrc && depsOptimizer.isOptimizedDepUrl(id)) {
          return moduleUrlToFilePath(id, root)
        }

        // data: / http(s): 说明符不归解析插件管，交给后续插件（asset/外部 URL 处理）。
        if (!isDataUrl(id) && !isExternalUrl(id)) {
          // 相对路径分支。preferRelative 时「foo.png」这种字母开头的也当相对路径，
          // 与 HTML 的 URL 语义一致（HTML 里不会出现裸包名）。
          if (
            id[0] === '.' ||
            (options.preferRelative && startsWithWordCharRE.test(id))
          ) {
            const basedir = importer ? path.dirname(importer) : root
            const fsPath = path.resolve(basedir, id)
            // handle browser field mapping for relative imports

            const normalizedFsPath = normalizePath(fsPath)

            // 相对路径解析结果恰好落在预构建目录里（源码里写了 ../node_modules/.vite/deps/...）：
            // 同样不能查磁盘，直接返回原路径并按需补 ?v=。
            if (depsOptimizer.isOptimizedDepFile(normalizedFsPath)) {
              // Optimized files could not yet exist in disk, resolve to the full path
              // Inject the current browserHash version if the path doesn't have one
              // 已有 ?v= 就保持原样（不能覆盖，否则会打断已确定的缓存键）；
              // 没有则从 metadata 里按文件反查 browserHash 补上。
              if (!DEP_VERSION_RE.test(normalizedFsPath)) {
                const browserHash = optimizedDepInfoFromFile(
                  depsOptimizer.metadata,
                  normalizedFsPath,
                )?.browserHash
                if (browserHash) {
                  return injectQuery(normalizedFsPath, `v=${browserHash}`)
                }
              }
              return normalizedFsPath
            }
          }

          // bare package imports, perform node resolve
          // 裸说明符：先看现有预构建元数据里有没有（tryOptimizedResolve）。
          // scan 阶段跳过——扫描时还没有预构建产物，而且不该触发登记。
          if (bareImportRE.test(id)) {
            let res: string | PartialResolvedId | undefined
            if (
              asSrc &&
              !options.scan &&
              (res = await tryOptimizedResolve(
                depsOptimizer,
                id,
                importer,
                options.preserveSymlinks,
                options.packageCache,
              ))
            ) {
              return res
            }
          }
        }
      },
    },
  }
}

// 作用：解析 package.json 的 imports 字段（即 "#xxx" 说明符），返回「可直接再交给解析器」
//   的相对路径或裸包名（外加原说明符上的 query/hash 后缀）。
// 调用点：
//   - 本文件 oxcResolvePlugin() 里作为 viteResolvePlugin 的 resolveSubpathImports 回调；
//   - plugins/dynamicImportVars.ts（动态 import 的变量展开时先试 #imports）；
//   - __tests__/plugins/resolve.spec.ts。
// 关键参数：id 为 # 开头；importer 用来定位「最近的 package.json」，因此 # 只能用于包内部；
//   options.isRequire 决定条件里推 require 还是 import。
// 失败模式：找不到 key 时返回 undefined（交给后续解析）；若某个 key 存在但目标解析失败，
//   会把 resolve.exports 抛出的原始错误重新抛出（保留包作者写错 exports 的诊断）。
export function resolveSubpathImports(
  id: string,
  importer: string | undefined,
  options: Pick<
    InternalResolveOptions,
    | 'packageCache'
    | 'conditions'
    | 'externalConditions'
    | 'isProduction'
    | 'isRequire'
  >,
): string | undefined {
  // # 前缀只对「包内」有意义：没有 importer 就无从确定是哪个包，直接放弃。
  if (!importer || !id.startsWith(subpathImportsPrefix)) return
  const basedir = path.dirname(importer)
  // 注意：这里找的是 importer 最近的 package.json，而不是 root 的——
  // monorepo 里每个包都有自己的 imports 映射。
  const pkgData = findNearestPackageData(basedir, options.packageCache)
  if (!pkgData) return
  // Imports keys may themselves contain `#` or `?` (e.g. `##/*`, `#a?b`).
  // Try the full id first, then each query or hash boundary from right to left
  // so that the longest matching key wins (#16085, #23622).
  // 循环从「整个 id」开始，每次把末尾的 ? / # 边界切掉再试：
  //   - 先试完整 id，能精确命中带 # 或 ? 的 key；
  //   - 再逐段右→左回退，把剩下的部分当 postfix 原样保留。
  // 顺序敏感：必须从长到短，否则 "#a?b" 会先命中 "#a" 而丢掉 "?b" 的语义。
  let importsPath: string | undefined
  let postfix = ''
  let fullIdError: unknown
  for (
    let postfixIndex = id.length;
    postfixIndex > 0;
    postfixIndex = Math.max(
      id.lastIndexOf('?', postfixIndex - 1),
      id.lastIndexOf('#', postfixIndex - 1),
    )
  ) {
    const key = id.slice(0, postfixIndex)
    try {
      importsPath = resolveExportsOrImports(
        pkgData.data,
        key,
        options,
        'imports',
      )
      if (importsPath !== undefined) {
        postfix = id.slice(postfixIndex)
        break
      }
    } catch (e) {
      // key 确实存在但解析失败：这是真错误，立即抛出（不能退化成「下一个更短的 key」）。
      if (Object.hasOwn(pkgData.data.imports, key)) throw e
      // resolve.exports throws when no key matches; keep the full id error.
      // 否则只是「这个 key 不存在」，记住第一次的错误最后再抛，便于定位。
      fullIdError ??= e
    }
  }
  if (importsPath === undefined && fullIdError) {
    throw fullIdError
  }

  // 映射目标若是相对路径，需要改成「相对于 importer 目录」的形式，
  // 因为返回值会被当作普通说明符继续解析（相对谁解析取决于 importer）。
  if (importsPath?.[0] === '.') {
    importsPath = path.relative(basedir, path.join(pkgData.dir, importsPath))

    // path.relative 可能产生 "foo.js" 这种不带 ./ 的形态，必须补上，
    // 否则会被误判成裸包名。
    if (!relativePrefixRE.test(importsPath)) {
      importsPath = `./${importsPath}`
    }
  }

  if (importsPath == null) return
  // 把 query/hash 后缀拼回去（例如 "#internal?raw" → "./src/internal.js?raw"）。
  return importsPath + postfix
}

// 作用：给「绕过裸说明符解析、直接引用 node_modules 里文件」的 id 补上 ?v= 版本串，
//   让它和通过裸说明符解析得到的是同一个 id（否则同一文件会有两种 id，模块图重复）。
// 调用点：本文件 oxcResolvePlugin() 的 finalizeOtherSpecifiers 回调（即原生 resolver
//   处理完相对/绝对路径后回调到这里）。
// 关键参数：resolved 是解析后的绝对路径，id 是原始说明符（用于判断是否 node_modules）。
// 失败模式：纯函数、不抛错；不满足条件时原样返回 resolved。
function ensureVersionQuery(
  resolved: string,
  id: string,
  options: InternalResolveOptions,
  depsOptimizer?: DepsOptimizer,
): string {
  // 四个前提：非 build、非 scan、有预构建器、且不是 /@vite/client 与 env 虚拟入口。
  // 虚拟入口在磁盘上不存在于 node_modules，补 ?v= 只会制造无意义的缓存键。
  if (
    !options.isBuild &&
    !options.scan &&
    depsOptimizer &&
    !(resolved === normalizedClientEntry || resolved === normalizedEnvEntry)
  ) {
    // Ensure that direct imports of node_modules have the same version query
    // as if they would have been imported through a bare import
    // Use the original id to do the check as the resolved id may be the real
    // file path after symlinks resolution
    // 两个都要查：preserveSymlinks=false 时 resolved 是 realpath，可能已经不含
    // node_modules 字样，而原始 id 仍带着，所以不能只看其中一个。
    const isNodeModule = isInNodeModules(id) || isInNodeModules(resolved)

    // 已有 ?v= 就不重复注入（DEP_VERSION_RE 匹配 ?v=xxx / &v=xxx）。
    if (isNodeModule && !DEP_VERSION_RE.test(resolved)) {
      const versionHash = depsOptimizer.metadata.browserHash
      // 只给可优化的 JS 类型加版本串；css/json 等交给预构建器以外的方式处理。
      if (versionHash && isOptimizable(resolved, depsOptimizer.options)) {
        resolved = injectQuery(resolved, `v=${versionHash}`)
      }
    }
  }
  return resolved
}

// 作用：把「文件系统路径（可带 ?query/#hash 后缀）」解析成真实存在的文件路径。
//   本文件里最底层的文件解析函数，resolvePackageEntry / resolveDeepImport 都靠它。
// 调用点：本文件 resolvePackageEntry、resolveDeepImport；
//   plugins/assetImportMetaUrl.ts 与 plugins/workerImportMetaUrl.ts
//   （import.meta.url 里引用的相对资源需要先变成真实文件）。
// 关键参数：tryIndex=false 时不做「目录 → index/package.json」回退（有 exports 字段时用）；
//   skipPackageJson=true 时跳过 package.json 入口（sass 里的 "foo" 不应读到包入口）。
// 失败模式：找不到返回 undefined，由调用方决定是报错还是继续回退；不抛错。
export function tryFsResolve(
  fsPath: string,
  options: InternalResolveOptions,
  tryIndex = true,
  skipPackageJson = false,
): string | undefined {
  // Dependencies like es5-ext use `#` in their paths. We don't support `#` in user
  // source code so we only need to perform the check for dependencies.
  // We don't support `?` in node_modules paths, so we only need to check in this branch.
  // 少数包（es5-ext）文件名里真的带 '#'，而 '#' 在 Vite 里同时是 hash 后缀分隔符。
  // 只对 node_modules 内部做这个特判：用户源码不支持 '#' 文件名。
  const hashIndex = fsPath.indexOf('#')
  if (hashIndex >= 0 && isInNodeModules(fsPath)) {
    const queryIndex = fsPath.indexOf('?')
    // We only need to check foo#bar?baz and foo#bar, ignore foo?bar#baz
    // 只处理 '#' 在 '?' 之前（或没有 '?'）的情形；'foo?bar#baz' 的 '#' 属于 hash 后缀。
    if (queryIndex < 0 || queryIndex > hashIndex) {
      // file 丢掉 '?' 之后的部分，但保留文件名里的 '#'；
      // 解析成功后把被切掉的后缀原样拼回（res + fsPath.slice(file.length)）。
      const file = queryIndex > hashIndex ? fsPath.slice(0, queryIndex) : fsPath
      const res = tryCleanFsResolve(file, options, tryIndex, skipPackageJson)
      if (res) return res + fsPath.slice(file.length)
    }
  }

  // 常规路径：干净地把 query/hash 分开，解析干净部分后再拼回后缀。
  // splitFileAndPostfix 与上面手写切分等价，但没有 node_modules '#' 特判。
  const { file, postfix } = splitFileAndPostfix(fsPath)
  const res = tryCleanFsResolve(file, options, tryIndex, skipPackageJson)
  if (res) return res + postfix
}

// 这些扩展名「可能是 TS 编译产物」，于是允许把 x.js 回退到 x.ts / x.tsx。
// 注意不含 .mts/.cts：它们的产物是 .mjs/.cjs，已在上面的正则里覆盖。
const knownTsOutputRE = /\.(?:js|mjs|cjs|jsx)$/
const isPossibleTsOutput = (url: string): boolean => knownTsOutputRE.test(url)

// 作用：tryFsResolve 的无后缀版本——入参保证已去掉 ?query/#hash。
// 调用点：本文件 tryFsResolve（唯一调用方）。
// 关键参数：见 tryFsResolve；另外 fileResult 复用了第一次 stat 的结果，避免重复 stat。
// 失败模式：不抛错；唯一会向上抛的是 package.json 读取时的非 ENOENT 错误
//   （例如权限问题），以及 resolvePackageEntry 的非 ERR_RESOLVE_PACKAGE_ENTRY_FAIL 异常。
function tryCleanFsResolve(
  file: string,
  options: InternalResolveOptions,
  tryIndex = true,
  skipPackageJson = false,
): string | undefined {
  const { tryPrefix, extensions, preserveSymlinks } = options

  // Optimization to get the real type or file type (directory, file, other)
  // 一次 stat 拿到「是文件 / 是目录 / 不存在」，后面所有分支都复用它：
  // 这是热路径（每个模块解析都会走），重复 stat 的代价很高。
  const fileResult = tryResolveRealFileOrType(file, options.preserveSymlinks)

  // 是文件：直接命中（getRealPath 已按 preserveSymlinks 处理并 normalize）。
  if (fileResult?.path) return fileResult.path

  let res: string | undefined

  // If path.dirname is a valid directory, try extensions and ts resolution logic
  // 只有在「父目录存在」时才值得试扩展名/TS 回退；
  // 三个条件任一成立才进入：像 JS 产物、配置了扩展名、或需要 tryPrefix 探针。
  const possibleJsToTs = isPossibleTsOutput(file)
  if (possibleJsToTs || options.extensions.length || tryPrefix) {
    const dirPath = path.dirname(file)
    if (isDirectory(dirPath)) {
      if (possibleJsToTs) {
        // try resolve .js, .mjs, .cjs or .jsx import to typescript file
        // TS 源码里 import './a.js' 实际要指向 a.ts：把扩展名里的 js 换成 ts
        // （.mjs→.mts、.cjs→.cts、.jsx→.tsx 都由 replace('js','ts') 一次完成）。
        const fileExt = path.extname(file)
        const fileName = file.slice(0, -fileExt.length)
        if (
          (res = tryResolveRealFile(
            fileName + fileExt.replace('js', 'ts'),
            preserveSymlinks,
          ))
        )
          return res
        // for .js, also try .tsx
        // .jsx 已在上一步映射到 .tsx；这里只额外补 .js → .tsx 的情况。
        if (
          fileExt === '.js' &&
          (res = tryResolveRealFile(fileName + '.tsx', preserveSymlinks))
        )
          return res
      }

      // 常规扩展名补全，按 extensions 顺序逐个试，先命中先返回（顺序即优先级）。
      if (
        (res = tryResolveRealFileWithExtensions(
          file,
          extensions,
          preserveSymlinks,
        ))
      )
        return res

      // sass 场景：'foo' 找不到时试 '_foo'（partial 下划线约定）。
      if (tryPrefix) {
        const prefixed = `${dirPath}/${options.tryPrefix}${path.basename(file)}`

        if ((res = tryResolveRealFile(prefixed, preserveSymlinks))) return res

        if (
          (res = tryResolveRealFileWithExtensions(
            prefixed,
            extensions,
            preserveSymlinks,
          ))
        )
          return res
      }
    }
  }

  // 目录分支：先试 package.json 入口，再试 index。
  // 顺序不能反：包目录同时有 package.json 与 index.js 时，必须以 package.json 为准。
  if (tryIndex && fileResult?.type === 'directory') {
    // Path points to a directory, check for package.json and entry and /index file
    const dirPath = file

    if (!skipPackageJson) {
      let pkgPath = `${dirPath}/package.json`
      try {
        if (fs.existsSync(pkgPath)) {
          // preserveSymlinks=false 时先 realpath：pnpm 的 .pnpm 目录里 package.json
          // 可能是符号链接，入口必须按真实位置算。
          if (!options.preserveSymlinks) {
            pkgPath = safeRealpathSync(pkgPath)
          }
          // path points to a node package
          const pkg = loadPackageData(pkgPath)
          return resolvePackageEntry(dirPath, pkg, options)
        }
      } catch (e) {
        // This check is best effort, so if an entry is not found, skip error for now
        // 这里是「best effort」：包入口坏掉不该让目录解析整体失败，
        // 吞掉入口失败与 ENOENT 后继续试 index；其它错误（权限等）照常抛。
        if (e.code !== ERR_RESOLVE_PACKAGE_ENTRY_FAIL && e.code !== 'ENOENT')
          throw e
      }
    }

    // 目录 index 回退：index + extensions。
    if (
      (res = tryResolveRealFileWithExtensions(
        `${dirPath}/index`,
        extensions,
        preserveSymlinks,
      ))
    )
      return res

    // sass 的目录形式：_index.scss。
    if (tryPrefix) {
      if (
        (res = tryResolveRealFileWithExtensions(
          `${dirPath}/${options.tryPrefix}index`,
          extensions,
          preserveSymlinks,
        ))
      )
        return res
    }
  }
}

// 作用：按 Node/Vite 规则解析裸说明符与裸说明符的 deep import，返回 PartialResolvedId。
//   这是「JS 版」的完整解析链，顺序为：
//   1) 求包名 pkgId（deep import 取包段，普通说明符去掉 ?query/#hash）；
//   2) 定 basedir（dedupe 命中→root；否则 importer 目录；否则 root）；
//   3) 先查 self-reference（包内自己 import 自己），再查 node_modules；
//   4) 找不到时判断是否「可选 peer 依赖」，是则返回占位 id 而不是 undefined；
//   5) 无子路径 → resolvePackageEntry（exports/mainFields/index）；有子路径 → resolveDeepImport；
//   6) 需要外部化时 processResult 标 external: true，并把 id 收敛成包内相对形态；
//   7) build 且非 scan 时补 moduleSideEffects / packageJsonPath；
//   8) dev 下给 node_modules 里的 JS 注入 ?v=，新依赖则登记预构建。
// 调用点：
//   - external.ts 的 isExternalizable()（判定能否外部化，externalize=false）；
//   - nodeResolve.ts 的 nodeResolveWithVite()（严格 Node 语义，disableOptionalPeerDepHandling=true）；
//   - ssr/fetchModule.ts（SSR 运行期按 id 找真实文件）。
//   注意：主插件流水线已不再直接调用它——那部分由 rolldown 的原生 resolver 承担。
// 关键参数：dedupe 强制从 root 解析；preserveSymlinks 决定是否 realpath；
//   externalize=true 才会走 processResult 的外部化分支；idOnly 跳过 sideEffects 计算。
// 失败模式：解析不出来返回 undefined（调用方决定报错）；包入口坏掉会抛
//   ERR_RESOLVE_PACKAGE_ENTRY_FAIL；可选 peer dep 返回占位 id，错误延迟到 import 时才报。
export function tryNodeResolve(
  id: string,
  importer: string | null | undefined,
  options: InternalResolveOptions,
  depsOptimizer?: DepsOptimizer,
  externalize?: boolean,
): PartialResolvedId | undefined {
  const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options

  // check for deep import, e.g. "my-lib/foo"
  // deepImportRE 的判据（utils.ts）：
  //   /^([^@][^/]*)\/|^(@[^/]+\/[^/]+)\//，即「非 @ 开头的首段 + /」或「@scope/name/」。
  // 因此 "foo" 不是 deep，"foo/bar" 是，"@a/b" 不是，"@a/b/c" 是。
  // 注意它只看字面形态，不校验包是否真存在。
  const deepMatch = deepImportRE.exec(id)
  // package name doesn't include postfixes
  // trim them to support importing package with queries (e.g. `import css from 'normalize.css?inline'`)
  // deepMatch[1] 是无 scope 包名，deepMatch[2] 是 @scope/name；
  // 非 deep 时用 cleanUrl 去掉 ?query/#hash，否则 "normalize.css?inline" 会被当成包名去找。
  const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : cleanUrl(id)

  let basedir: string
  // dedupe 命中：强制从 root 解析，保证整个项目只解析出一份该包（monorepo 里
  // 各子包 node_modules 版本不一致时的标准解法）。
  if (dedupe.includes(pkgId)) {
    basedir = root
  } else if (
    importer &&
    path.isAbsolute(importer) &&
    // css processing appends `*` for importer
    // CSS 侧传进来的 importer 末尾带 '*'（表示「按该文件所在目录解析」的约定），
    // 这种形态 fs.existsSync 必然为 false，所以要单独放行。
    // 其它情况要求 importer 真存在，避免用已被删除的文件目录去解析。
    (importer.endsWith('*') || fs.existsSync(cleanUrl(importer)))
  ) {
    basedir = path.dirname(importer)
  } else {
    basedir = root
  }

  // builtins 按环境配置（client 通常是 nodeLikeBuiltins）。
  // 命中后不做 node_modules 查找，也不参与 self-reference / optional peer dep 判定。
  const isModuleBuiltin = (id: string) => isBuiltin(options.builtins, id)

  let selfPkg = null
  // self-reference：包内文件 import 自己包的 name（Node 支持 exports 的 self 映射）。
  // 只对「裸说明符、非内置、非虚拟（\0）」判断。
  if (!isModuleBuiltin(id) && !id.includes('\0') && bareImportRE.test(id)) {
    // check if it's a self reference dep.
    const selfPackageData = findNearestPackageData(basedir, packageCache)
    // 必须同时满足「最近的包有 exports」与「name === pkgId」，否则不算 self 引用
    // （没有 exports 时 Node 也不允许 self reference）。
    selfPkg =
      selfPackageData?.data.exports && selfPackageData.data.name === pkgId
        ? selfPackageData
        : null
  }

  // 先 self，再走 node_modules 逐级向上查找（resolvePackageData 内部带 packageCache）。
  const pkg =
    selfPkg ||
    resolvePackageData(pkgId, basedir, preserveSymlinks, packageCache)
  if (!pkg) {
    // if import can't be found, check if it's an optional peer dep.
    // if so, we can resolve to a special id that errors only when imported.
    // 可选 peer 依赖：父包声明了 peerDependenciesMeta[pkg].optional，但没安装。
    // 不在这里报错（否则「可选」就失去意义），而是返回占位 id；
    // basedir === root 时跳过：root 自身没有 peer 语义。
    if (
      !options.disableOptionalPeerDepHandling &&
      basedir !== root && // root has no peer dep
      !isModuleBuiltin(id) &&
      !id.includes('\0') &&
      bareImportRE.test(id)
    ) {
      const mainPkg = findNearestMainPackageData(basedir, packageCache)?.data
      if (mainPkg) {
        const pkgName = getNpmPackageName(id)
        // 三个条件缺一不可：父包声明了该 peer、且标记 optional。
        if (
          pkgName != null &&
          mainPkg.peerDependencies?.[pkgName] &&
          mainPkg.peerDependenciesMeta?.[pkgName]?.optional
        ) {
          return {
            id: `${optionalPeerDepId}:${id}:${mainPkg.name}`,
          }
        }
      }
    }
    return
  }

  // 同一包解析到入口还是子路径，决定走哪条完全不同的链路。
  const resolveId = deepMatch ? resolveDeepImport : resolvePackageEntry
  // resolveDeepImport 需要以 './' 开头的子路径（'./foo'），
  // 这里把 'my-lib/foo' 的包名部分切掉并补上 '.' → './foo'。
  const unresolvedId = deepMatch ? '.' + id.slice(pkgId.length) : id

  let resolved = resolveId(unresolvedId, pkg, options, externalize)
  if (!resolved) {
    return
  }

  // 作用：把解析结果加工成「可外部化」形态。
  // - 非 externalize 或该文件不允许外部化（canExternalizeFile：只允许 .js/.mjs/.cjs，
  //   即只外部化 JS 导入）→ 原样返回；
  // - 否则 id 收敛成「包内相对说明符」并把 external 置 true，
  //   让产物里保留 import 'date-fns/locale' 而不是绝对路径。
  const processResult = (resolved: PartialResolvedId) => {
    if (!externalize) {
      return resolved
    }
    if (!canExternalizeFile(resolved.id)) {
      return resolved
    }

    let resolvedId = id
    // 只在「deep import + 包没有 exports + 实际命中文件扩展名与说明符不同」时收敛：
    // 例如 id=date-fns/locale，resolved=.../date-fns/esm/locale/index.js，
    // 从 resolved 中截出 'locale/index.js' 这一段作为外部化 id。
    if (
      deepMatch &&
      !pkg.data.exports &&
      path.extname(id) !== path.extname(resolved.id)
    ) {
      // id date-fns/locale
      // resolve.id ...date-fns/esm/locale/index.js
      const index = resolved.id.indexOf(id)
      if (index > -1) {
        resolvedId = resolved.id.slice(index)
        debug?.(
          `[processResult] ${colors.cyan(id)} -> ${colors.dim(resolvedId)}`,
        )
      }
    }
    return { ...resolved, id: resolvedId, external: true }
  }

  // build（且非 scan）或外部化时，需要额外元数据：
  //   moduleSideEffects 供 tree-shaking 判断（上游英文注释写的 rollup，现在实际是 rolldown）；
  //   packageJsonPath 供 rolldown 推断模块格式（CJS/ESM）。
  // idOnly 时整段跳过——createIdResolver 只要 id，多算这些纯属浪费。
  if (!options.idOnly && ((!options.scan && isBuild) || externalize)) {
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    // （注：本仓内核是 rolldown，此处的 rollup 指插件接口兼容层，不是打包器。）
    return processResult({
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved),
      packageJsonPath: findNearestPackagePath(
        resolved,
        options.legacyInconsistentCjsInterop,
        options.packageCache,
        isBuild,
      ),
    })
  }

  // 三种情况直接返回真实路径，不做预构建相关处理：
  //   1) 解析结果不在 node_modules 内（含 pnpm link 出来的源码）——不是依赖；
  //   2) 还没有 depsOptimizer（server 尚未 listen，或 createIdResolver 场景）；
  //   3) 处于预构建扫描阶段（上游英文写的 esbuild scan 是旧词，现在是 rolldown 扫描）。
  if (
    !isInNodeModules(resolved) || // linked
    !depsOptimizer || // resolving before listening to the server
    options.scan // initial esbuild scan phase
  ) {
    return { id: resolved }
  }

  // if we reach here, it's a valid dep import that hasn't been optimized.
  // 走到这里说明是「node_modules 里的真实依赖」。下一段与 oxcResolvePlugin 的
  // finalizeBareSpecifier 逻辑同构（后者给原生 resolver 用，这里给 JS 调用方用），
  // 两处必须保持一致，否则主流水线和 external/SSR 会得出不同的 id。
  const isJsType = isOptimizable(resolved, depsOptimizer.options)
  const exclude = depsOptimizer.options.exclude

  const skipOptimization =
    depsOptimizer.options.noDiscovery ||
    !isJsType ||
    (importer && isInNodeModules(importer)) ||
    exclude?.includes(pkgId) ||
    exclude?.includes(id) ||
    SPECIAL_QUERY_RE.test(resolved)

  if (skipOptimization) {
    // excluded from optimization
    // Inject a version query to npm deps so that the browser
    // can cache it without re-validation, but only do so for known js types.
    // otherwise we may introduce duplicated modules for externalized files
    // from pre-bundled deps.
    // 跳过预构建时仍要补 ?v=：让浏览器把该文件当作长期缓存，
    // 同时保证和「从裸说明符进来的同一文件」拥有相同 id。
    const versionHash = depsOptimizer.metadata.browserHash
    if (versionHash && isJsType) {
      resolved = injectQuery(resolved, `v=${versionHash}`)
    }
  } else {
    // this is a missing import, queue optimize-deps re-run and
    // get a resolved its optimized info
    // 新依赖：登记后立刻返回「预构建产物的预期路径 + ?v=」，真实文件稍后落盘。
    const optimizedInfo = depsOptimizer.registerMissingImport(id, resolved)
    resolved = depsOptimizer.getOptimizedDepId(optimizedInfo)
  }

  return { id: resolved }
}

// 作用：在现有预构建元数据里查找 id 对应的产物（含「嵌套依赖」）
//   → 返回带 ?v=browserHash 的预构建产物路径；查不到返回 undefined。
// 调用点：本文件 optimizerResolvePlugin 的裸说明符分支；plugins/preAlias.ts
//   （判断被 alias 的依赖是否已预构建，避免把裸说明符换成真实路径）。
// 关键参数：id 是原始裸说明符；importer 用于解析「嵌套依赖」归属；
//   packageCache/preserveSymlinks 透传给 resolvePackageData。
// 失败模式：不抛错。找不到返回 undefined，让后面的通用解析接管。
export async function tryOptimizedResolve(
  depsOptimizer: DepsOptimizer,
  id: string,
  importer?: string,
  preserveSymlinks?: boolean,
  packageCache?: PackageCache,
): Promise<string | undefined> {
  // TODO: we need to wait until scanning is done here as this function
  // is used in the preAliasPlugin to decide if an aliased dep is optimized,
  // and avoid replacing the bare import with the resolved path.
  // We should be able to remove this in the future
  // 必须等扫描结束：扫描会重写 metadata，提前读会得到「还没有这个依赖」的结论，
  // preAlias 就会把裸说明符换成真实路径，导致该依赖绕开预构建。
  await depsOptimizer.scanProcessing

  const metadata = depsOptimizer.metadata

  // 第一优先：id 本身是已预构建依赖（metadata.optimized）。
  const depInfo = optimizedDepInfoFromId(metadata, id)
  if (depInfo) {
    return depsOptimizer.getOptimizedDepId(depInfo)
  }

  // 没有 importer 就无法判断嵌套关系，到此为止。
  if (!importer) return

  // further check if id is imported by nested dependency
  // 嵌套依赖的 id 形如 "my-lib > foo"（optimizer/resolve.ts 里的 nestedPath 就是这个格式）。
  // 这里用 `> ${id}` 后缀先粗筛，再用 src 前缀确认归属，避免误配到另一个包下的同名依赖。
  let idPkgDir: string | undefined
  const nestedIdMatch = `> ${id}`

  for (const optimizedData of metadata.depInfoList) {
    if (!optimizedData.src) continue // Ignore chunks

    // check where "foo" is nested in "my-lib > foo"
    if (!optimizedData.id.endsWith(nestedIdMatch)) continue

    // lazily initialize idPkgDir
    // 惰性计算：只有真的出现 "xxx > id" 形态才去查一次包目录（磁盘 I/O 较贵）。
    if (idPkgDir == null) {
      const pkgName = getNpmPackageName(id)
      if (!pkgName) break
      // 注意这里用 importer（而不是 root）作为 basedir：嵌套依赖属于 importer 所属的包树。
      idPkgDir = resolvePackageData(
        pkgName,
        importer,
        preserveSymlinks,
        packageCache,
      )?.dir
      // if still null, it likely means that this id isn't a dep for importer.
      // break to bail early
      if (idPkgDir == null) break
      idPkgDir = normalizePath(idPkgDir)
    }

    // match by src to correctly identify if id belongs to nested dependency
    // 只有 src 落在该包目录下，才确认这条预构建记录就是 importer 想引用的那个。
    if (optimizedData.src.startsWith(withTrailingSlash(idPkgDir))) {
      return depsOptimizer.getOptimizedDepId(optimizedData)
    }
  }
}

// 作用：解析包的「入口」（裸说明符 id 不带子路径时走这里）。
//   优先级严格为：exports 字段 → mainFields 逐项 → data.main → 默认 index.*。
// 调用点：本文件 tryNodeResolve（非 deep import 分支）、tryCleanFsResolve
//   （目录里发现 package.json 时的回退）。
// 关键参数：id 只用于日志/缓存键；PackageData 自带 resolved 缓存（set/getResolvedCache），
//   缓存键 '.' 表示「整包入口」；externalize 决定 exports 用哪套条件。
// 失败模式：一定抛 ERR_RESOLVE_PACKAGE_ENTRY_FAIL（不返回 undefined）——
//   调用方若想容错（tryCleanFsResolve）必须自己 catch 这个 code。
export function resolvePackageEntry(
  id: string,
  { dir, data, setResolvedCache, getResolvedCache }: PackageData,
  options: InternalResolveOptions,
  externalize?: boolean,
): string | undefined {
  // 说明符上的 ?query/#hash 不能参与入口解析，先分离，命中后再拼回。
  const { file: idWithoutPostfix, postfix } = splitFileAndPostfix(id)

  // PackageData 内部的解析缓存：同一个包被大量模块 import 时避免重复读盘/重复跑 exports。
  // 缓存键用 '.'（入口），deep import 用子路径字符串作键（见 resolveDeepImport）。
  const cached = getResolvedCache('.', options)
  if (cached) {
    return cached + postfix
  }

  try {
    let entryPoint: string | undefined

    // resolve exports field with highest priority
    // using https://github.com/lukeed/resolve.exports
    // exports 优先级最高：一旦包声明了 exports，Node 语义下 mainFields 就完全失效。
    // 注意这里仍可能返回 undefined（例如 exports 里没有 '.' 这个 key），
    // 此时会继续走 mainFields 回退（Vite 比 Node 宽松，避免老包直接失败）。
    if (data.exports) {
      entryPoint = resolveExportsOrImports(
        data,
        '.',
        options,
        'exports',
        externalize,
      )
    }

    // fallback to mainFields if still not resolved
    // 按 mainFields 顺序找第一个字符串字段；
    // browser 比较特殊：它可能是对象，此时取对象里的 '.' 键作为入口。
    if (!entryPoint) {
      for (const field of options.mainFields) {
        if (typeof data[field] === 'string') {
          entryPoint = data[field]
          break
        } else if (field === 'browser') {
          const browser = data[field]
          if (isObject(browser) && browser['.']) {
            entryPoint = browser['.']
            break
          }
        }
      }
    }
    // 最后兜底 main（mainFields 里通常已被追加 'main'，这里再兜一次是给
    // skipMainField 的自定义解析用）。
    entryPoint ||= data.main

    // try default entry when entry is not define
    // https://nodejs.org/api/modules.html#all-together
    // 完全没有入口字段时按 Node 的默认规则找 index.{js,json,node}。
    const entryPoints = entryPoint
      ? [entryPoint]
      : ['index.js', 'index.json', 'index.node']

    for (let entry of entryPoints) {
      // make sure we don't get scripts when looking for sass
      // sass 解析（mainFields[0] === 'sass'）：如果入口扩展名不在本次 extensions 里
      // （例如包 main 指向 index.js，但我们只找 .scss），就把 entry 清空、
      // 并禁止再读 package.json（skipPackageJson），只让后面的 tryFsResolve 用
      // tryPrefix/_index.scss 去探测——否则会把 JS 入口当成样式入口。
      let skipPackageJson = false
      if (
        options.mainFields[0] === 'sass' &&
        !options.extensions.includes(path.extname(entry))
      ) {
        entry = ''
        skipPackageJson = true
      } else {
        // resolve object browser field in package.json
        // browser 对象映射：把入口路径按映射表替换（见 mapWithBrowserField）。
        // 只有 mainFields 里包含 browser 才生效，server 环境默认不含。
        const { browser: browserField } = data
        if (options.mainFields.includes('browser') && isObject(browserField)) {
          entry = mapWithBrowserField(entry, browserField) || entry
        }
      }

      // path.join 用系统分隔符，tryFsResolve 内部会 normalizePath 后再返回，
      // 因此最终 id 在 Windows 上也是 '/'。
      const entryPointPath = path.join(dir, entry)
      const resolvedEntryPoint = tryFsResolve(
        entryPointPath,
        options,
        true,
        skipPackageJson,
      )
      if (resolvedEntryPoint) {
        debug?.(
          `[package entry] ${colors.cyan(idWithoutPostfix)} -> ${colors.dim(
            resolvedEntryPoint,
          )}${postfix !== '' ? ` (postfix: ${postfix})` : ''}`,
        )
        // 缓存的是「不带 postfix」的入口，命中时再拼回本次的 postfix。
        setResolvedCache('.', resolvedEntryPoint, options)
        return resolvedEntryPoint + postfix
      }
    }
  } catch (e) {
    // 任何异常都转成统一的入口失败错误（带上原始信息便于定位）。
    packageEntryFailure(id, e.message)
  }
  packageEntryFailure(id)
}

// 作用：构造并抛出「包入口解析失败」错误，错误码固定为 ERR_RESOLVE_PACKAGE_ENTRY_FAIL。
// 调用点：本文件 resolvePackageEntry（正常失败与异常兜底各一次）。
// 关键参数：details 是原始异常信息，会被拼进 message。
// 失败模式：永远抛错（返回类型 never），调用方想容错必须按 code 判断。
function packageEntryFailure(id: string, details?: string) {
  const err: any = new Error(
    `Failed to resolve entry for package "${id}". ` +
      `The package may have incorrect main/module/exports specified in its package.json` +
      (details ? ': ' + details : '.'),
  )
  err.code = ERR_RESOLVE_PACKAGE_ENTRY_FAIL
  throw err
}

// 作用：把配置里的条件列表加工成「真正传给 resolve.exports 的条件」。
// 调用点：本文件 resolveExportsOrImports（唯一调用方）。
// 关键参数：isProduction 决定 DEV_PROD_CONDITION 落到 development 还是 production；
//   isRequire 决定追加 'require' 还是 'import'。
// 失败模式：纯函数不抛错；注意 'import'/'require' 是「追加在末尾」的，
//   因此用户自定义条件里若已包含同名条件会重复，不影响结果但会让条件数组变长。
function getConditions(
  conditions: string[],
  isProduction: boolean,
  isRequire: boolean | undefined,
) {
  const resolvedConditions = conditions.map((condition) => {
    // 'development|production' 是 Vite 的伪条件（constants.ts 的 DEV_PROD_CONDITION），
    // 在真正匹配前必须替换掉，否则永远匹配不上任何包。
    if (condition === DEV_PROD_CONDITION) {
      return isProduction ? 'production' : 'development'
    }
    return condition
  })

  // import/require 由调用上下文决定，而不是用户配置——所以放在最后追加，
  // 保证它不会被用户配置覆盖（resolve.exports 按条件集合匹配，不按顺序）。
  if (isRequire) {
    resolvedConditions.push('require')
  } else {
    resolvedConditions.push('import')
  }

  return resolvedConditions
}

// 作用：用 resolve.exports 库解析 exports/imports 字段，取第一个匹配结果。
// 调用点：本文件 resolvePackageEntry、resolveDeepImport、resolveSubpathImports。
// 关键参数：externalize=true 时改用 externalConditions（外部化不看浏览器条件）；
//   unsafe: true 打开 resolve.exports 的宽松模式，用于兼容不完全符合规范的 exports 写法。
// 失败模式：key 不存在时 resolve.exports 会抛错（由调用方决定吞还是抛）；
//   返回 undefined 表示「有 exports 但没有匹配到 key」。
function resolveExportsOrImports(
  pkg: PackageData['data'],
  key: string,
  options: Pick<
    InternalResolveOptions,
    'conditions' | 'externalConditions' | 'isProduction' | 'isRequire'
  >,
  type: 'imports' | 'exports',
  externalize?: boolean,
) {
  const conditions = getConditions(
    externalize ? options.externalConditions : options.conditions,
    options.isProduction,
    options.isRequire,
  )

  const fn = type === 'imports' ? imports : exports
  const result = fn(pkg, key, { conditions, unsafe: true })
  return result ? result[0] : undefined
}

// 作用：解析包的 deep import（'my-lib/foo' 这类子路径）。
// 调用点：本文件 tryNodeResolve（deepMatch 时）。
// 关键参数：id 形如 './foo'（调用方已把包名切掉并补点）；PackageData 提供包目录与
//   exports/browser 字段；externalize 影响 exports 条件。
// 失败模式：
//   - 包有 exports 但该子路径未导出 → 抛错（Node 语义，不做回退）；
//   - browser 字段映射为 false → 返回 browserExternalId 占位；
//   - 找不到文件 → 返回 undefined（调用方按解析失败处理）。
function resolveDeepImport(
  id: string,
  { setResolvedCache, getResolvedCache, dir, data }: PackageData,
  options: InternalResolveOptions,
  externalize?: boolean,
): string | undefined {
  // 缓存键是「未处理的原始子路径 id」，与入口的 '.' 键互不干扰。
  const cache = getResolvedCache(id, options)
  if (cache) {
    return cache
  }

  let relativeId: string | undefined | void = id
  const { exports: exportsField, browser: browserField } = data

  // map relative based on exports data
  // 有 exports 时完全按 Node 规则：只允许 exports 里声明的子路径，
  // 未声明就报错（不回退到真实文件），这是与 mainFields 路径最大的差别。
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      // resolve without postfix (see #7098)
      // 带 ?query/#hash 时要先剥掉再匹配（#7098），否则 key 永远对不上。
      const { file, postfix } = splitFileAndPostfix(relativeId)
      const exportsId = resolveExportsOrImports(
        data,
        file,
        options,
        'exports',
        externalize,
      )
      if (exportsId !== undefined) {
        relativeId = exportsId + postfix
      } else {
        relativeId = undefined
      }
    } else {
      // not exposed
      // exports 是字符串或数组：没有子路径表，所有 deep import 都视为未导出。
      relativeId = undefined
    }
    if (!relativeId) {
      // 注意这里报错信息里的 relativeId 此时已是 undefined，所以打印的是
      // "Package subpath 'undefined' is not defined..."（上游遗留问题，见回报的代码疑点）。
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, 'package.json')}.`,
      )
    }
  } else if (options.mainFields.includes('browser') && isObject(browserField)) {
    // 没有 exports 时才用 browser 对象做子路径映射（client 环境）。
    // resolve without postfix (see #7098)
    const { file, postfix } = splitFileAndPostfix(relativeId)
    const mapped = mapWithBrowserField(file, browserField)
    if (mapped) {
      relativeId = mapped + postfix
    } else if (mapped === false) {
      // 显式排除：缓存并返回占位 id（消费方见文件顶部 browserExternalId 注释）。
      setResolvedCache(id, browserExternalId, options)
      return browserExternalId
    }
    // mapped 为 undefined：没有映射，保持原相对路径继续解析。
  }

  if (relativeId) {
    // 有 exports 时不再做 index 回退（exports 的映射结果是精确文件/目录，
    // 再回退会绕过包的显式声明）；没有 exports 时允许 index。
    const resolved = tryFsResolve(
      path.join(dir, relativeId),
      options,
      !exportsField, // try index only if no exports field
    )
    if (resolved) {
      debug?.(
        `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`,
      )
      setResolvedCache(id, resolved, options)
      return resolved
    }
  }
}

/**
 * given a relative path in pkg dir,
 * return a relative path in pkg dir,
 * mapped with the "map" object
 *
 * - Returning `undefined` means there is no browser mapping for this id
 * - Returning `false` means this id is explicitly externalized for browser
 */
// 作用：按 package.json 的 browser 对象做「包内相对路径 → 另一路径」映射。
// 调用点：本文件 resolvePackageEntry（入口映射）、resolveDeepImport（子路径映射）。
// 关键参数：relativePathInPkgDir 是相对包目录的路径；map 是 browser 字段对象，
//   值可以是替换路径字符串，也可以是 false（显式排除）。
// 失败模式：不抛错；无映射返回 undefined，false 表示排除（由调用方转成 browserExternalId）。
// 匹配规则（三者满足其一即可，顺序即优先级）：
//   1) 规范化后完全相等；
//   2) key 带 '.js' 后缀，去掉后缀后相等（"foo" ↔ "foo.js"）；
//   3) key 以 '/index.js' 结尾，去掉后相等（"foo" ↔ "foo/index.js"）。
function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>,
): string | false | undefined {
  // browser 字段的 key 可能写成 './foo.js'、'foo.js'、'foo'，统一用 posix 规则规范化；
  // 必须用 path.posix（不能跟随宿主系统），否则 Windows 上 '\' 与 '/' 会对不上。
  const normalizedPath = path.posix.normalize(relativePathInPkgDir)

  for (const key in map) {
    const normalizedKey = path.posix.normalize(key)
    if (
      normalizedPath === normalizedKey ||
      equalWithoutSuffix(normalizedPath, normalizedKey, '.js') ||
      equalWithoutSuffix(normalizedPath, normalizedKey, '/index.js')
    ) {
      return map[key]
    }
  }
}

// 作用：判断 key 去掉某个已知后缀后是否与 path 相等（browser 字段省略扩展名的匹配）。
// 调用点：本文件 mapWithBrowserField。
// 失败模式：纯字符串比较，不抛错。
function equalWithoutSuffix(path: string, key: string, suffix: string) {
  return key.endsWith(suffix) && key.slice(0, -suffix.length) === path
}

// 作用：文件存在且是普通文件时返回「真实路径」（按 preserveSymlinks 决定是否 realpath）。
// 调用点：本文件 tryCleanFsResolve、tryResolveRealFileWithExtensions。
// 失败模式：不存在/不是文件返回 undefined；stat 的错误被 tryStatSync 吞掉。
function tryResolveRealFile(
  file: string,
  preserveSymlinks?: boolean,
): string | undefined {
  const stat = tryStatSync(file)
  if (stat?.isFile()) return getRealPath(file, preserveSymlinks)
}

// 作用：按 extensions 顺序逐个补全并检查文件，返回第一个命中项。
// 调用点：本文件 tryCleanFsResolve（普通路径、tryPrefix 路径、目录 index 三处）。
// 失败模式：都不存在返回 undefined；顺序即优先级，不要随意重排 extensions。
function tryResolveRealFileWithExtensions(
  filePath: string,
  extensions: string[],
  preserveSymlinks?: boolean,
): string | undefined {
  for (const ext of extensions) {
    const res = tryResolveRealFile(filePath + ext, preserveSymlinks)
    if (res) return res
  }
}

// 作用：一次 stat 同时给出「是文件（附真实路径）/ 是目录」的信息。
// 调用点：本文件 tryCleanFsResolve（唯一调用方，复用结果避免重复 stat）。
// 失败模式：不存在或既非文件也非目录（socket 等）返回 undefined。
function tryResolveRealFileOrType(
  file: string,
  preserveSymlinks?: boolean,
): { path?: string; type: 'directory' | 'file' } | undefined {
  const fileStat = tryStatSync(file)
  if (fileStat?.isFile()) {
    return { path: getRealPath(file, preserveSymlinks), type: 'file' }
  }
  if (fileStat?.isDirectory()) {
    return { type: 'directory' }
  }
  return
}

// 作用：按 preserveSymlinks 决定是否 realpath，并统一成 '/' 分隔的 id 形式。
// 调用点：本文件 tryResolveRealFile、tryResolveRealFileOrType。
// 关键点：preserveSymlinks=true 时保留符号链接路径，同一文件可能因此出现两种 id；
//   false（默认）时 realpath 会指向 pnpm store / monorepo 真实目录。
function getRealPath(resolved: string, preserveSymlinks?: boolean): string {
  if (!preserveSymlinks) {
    resolved = safeRealpathSync(resolved)
  }
  return normalizePath(resolved)
}

// 作用：目录判断；stat 失败（不存在/无权限）一律当「不是目录」。
// 调用点：本文件 tryCleanFsResolve。
function isDirectory(path: string): boolean {
  const stat = tryStatSync(path)
  return stat?.isDirectory() ?? false
}

// 作用：为构建产物提供「该文件所属 package.json 的路径」，供 rolldown 推断模块格式。
// 调用点：本文件 tryNodeResolve（构建期返回 moduleSideEffects 时）。
// 关键参数：legacyInconsistentCjsInterop 为 true 时返回 undefined——把格式推断完全
//   交回 rolldown 的默认逻辑，以复现旧版不一致的 CJS interop 行为。
// 失败模式：非 build、兼容模式、或找不到 package.json 时返回 undefined/null。
function findNearestPackagePath(
  file: string,
  legacyInconsistentCjsInterop: boolean | undefined,
  packageCache: PackageCache | undefined,
  isBuild: boolean,
) {
  if (!isBuild || legacyInconsistentCjsInterop) return
  const pkgData = findNearestPackageData(file, packageCache)
  return pkgData ? path.join(pkgData.dir, 'package.json') : null
}
