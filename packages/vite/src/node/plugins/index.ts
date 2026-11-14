import aliasPlugin, { type ResolverFunction } from '@rollup/plugin-alias'
import type { ObjectHook } from 'rolldown'
import {
  viteAliasPlugin as nativeAliasPlugin,
  viteJsonPlugin as nativeJsonPlugin,
  oxcRuntimePlugin,
} from 'rolldown/experimental'
import { resolveBuildPlugins } from '../build'
import type { PluginHookUtils, ResolvedConfig } from '../config'
import { watchPackageDataPlugin } from '../packages'
import {
  type HookHandler,
  type Plugin,
  type PluginWithRequiredHook,
} from '../plugin'
import { assetPlugin } from './asset'
import { assetImportMetaUrlPlugin } from './assetImportMetaUrl'
import {
  bundledDevClientImportsPlugin,
  clientInjectionsPlugin,
} from './clientInjections'
import { cssAnalysisPlugin, cssPlugin, cssPostPlugin } from './css'
import { definePlugin } from './define'
import { dynamicImportVarsPlugin } from './dynamicImportVars'
import { esbuildBannerFooterCompatPlugin } from './esbuildBannerFooterCompatPlugin'
import { forwardConsolePlugin } from './forwardConsole'
import { buildHtmlPlugin, htmlInlineProxyPlugin } from './html'
import { importAnalysisPlugin } from './importAnalysis'
import { importGlobPlugin } from './importMetaGlob'
import { modulePreloadPolyfillPlugin } from './modulePreloadPolyfill'
import { optimizedDepsPlugin } from './optimizedDeps'
import { oxcPlugin } from './oxc'
import {
  type PluginFilter,
  type TransformHookFilter,
  createFilterForTransform,
  createIdFilter,
} from './pluginFilter'
import { preAliasPlugin } from './preAlias'
import { oxcResolvePlugin } from './resolve'
import { wasmHelperPlugin } from './wasm'
import { webWorkerPlugin } from './worker'
import { workerImportMetaUrlPlugin } from './workerImportMetaUrl'

// ============================================================================
// 文件角色：内置插件清单 + hook 排序工具。

// 下面的 resolvePlugins 返回的数组顺序，就是「同 order 插件之间的相对顺序」，
// 它决定了：
//   - 谁先认领 resolveId（hookFirst，先到先得）；
//   - transform 链上的执行次序（前一个的输出是后一个的输入）。

// 三条纪律，读这个数组时务必记住：
//   1. 解析类插件（preAlias → alias → 内置 resolve）必须整体靠前；
//   2. importAnalysis 必须最后（它要看到所有其它插件处理完的代码）；
//   3. 用户插件插在 normalPlugins 处，postPlugins 在 importGlob 之后、
//      内部 server-only 插件之前。

// 注意「数组顺序」只决定同 order 插件之间的相对次序；每个 hook 自己的
// pre/normal/post 排序由文件末尾的 getSortedPluginsByHook 完成。
// ============================================================================
export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[],
): Promise<Plugin[]> {
  // 判断当前流水线是否包含「打包」环境。build 命令一定是；
  // dev 下若开了 experimental.bundledDev，也要把 build 侧插件装进来。
  const isBuild = config.command === 'build'
  const isWorker = config.isWorker
  const anyEnvBundled =
    isBuild || Object.values(config.environments).some((env) => env.isBundled)
  const buildPlugins = anyEnvBundled
    ? resolveBuildPlugins(config)
    : { pre: [], post: [] }
  const { modulePreload } = config.build

  return [
    // 优化依赖插件：把「已经预构建的依赖」的 URL 映射到 deps 缓存目录，
    // 并在发现新依赖时通知 depsOptimizer。它排在最前，因为它处理的是
    // 「已经确定是依赖」的 id，不该再走后面的普通解析。
    optimizedDepsPlugin(),
    // 监听 package.json 变化，维护 packageCache（exports/main/module 字段）。
    // 没有它，依赖元数据会被永久缓存，改 package.json 后必须重启。
    !isWorker ? watchPackageDataPlugin(config.packageCache) : null,
    // preAlias：在 alias 之前做一次「裸模块 → 预构建产物」的短路。
    // 为什么在 alias 之前：用户 alias 不应改写已经确定要被预构建的依赖。
    preAliasPlugin(config),
    // alias：兼容 @rollup/plugin-alias 的语义。bundledDev 环境下若用户没配
    // 自定义 resolver，会换成 rolldown 的原生 alias 插件（避免每模块一次 JS 调用）。
    {
      ...aliasPlugin({
        // @ts-expect-error aliasPlugin receives rollup types
        entries: config.resolve.alias,
        customResolver: viteAliasCustomResolver,
      }),
      applyToEnvironment(environment) {
        if (
          environment.config.isBundled &&
          !environment.config.resolve.alias.some((v) => v.customResolver)
        ) {
          return nativeAliasPlugin({
            entries: config.resolve.alias.map((item) => {
              return {
                find: item.find,
                replacement: item.replacement,
              }
            }),
          })
        }
        return true
      },
    } as Plugin,

    // 用户插件（vite.config 的 plugins 数组，已按 enforce 分好 pre/normal/post）。
    // 用户在 enforce:'pre' 里写的插件，实际上仍然排在 alias / 解析插件之后——
    // enforce 只控制它们在「用户插件集合」内部的顺序。
    ...prePlugins,

    // modulePreload polyfill：给不支持 modulepreload 的浏览器补一个。
    // 必须在 importAnalysis 之前注入，否则 polyfill 自己的 import 不会被改写。
    modulePreload !== false && modulePreload.polyfill
      ? modulePreloadPolyfillPlugin()
      : null,
    // before the resolver, which cannot resolve the client's public URL
    // bundledDev 专用：客户端入口的 import 改写（产物是全量打包的，说明符形态不同）。
    bundledDevClientImportsPlugin(config),
    // 内置解析插件（oxcResolvePlugin，实现仍在 plugins/resolve.ts）。
    // 它负责：相对/绝对路径、bare import、exports/imports 字段、browser 字段、
    // /@fs/、虚拟模块、external 判定。放在 alias 之后、其它插件之前，
    // 因为后续插件（css、asset、worker…）都默认「id 已经是可读的文件路径」。
    ...oxcResolvePlugin(
      {
        root: config.root,
        isProduction: config.isProduction,
        isBuild,
        packageCache: config.packageCache,
        asSrc: true,
        optimizeDeps: true,
        externalize: true,
        legacyInconsistentCjsInterop: config.legacy?.inconsistentCjsInterop,
      },
      isWorker
        ? {
            ...config,
            consumer: 'client',
            isBundled: true,
            optimizeDepsPluginNames: [],
            safeModulePaths: config.environments.client.safeModulePaths,
          }
        : undefined,
    ),
    // HTML inline proxy：把 <script> 内联代码变成一个虚拟模块（html-proxy），
    // 这样内联脚本也能走完整的模块管线与 HMR。
    htmlInlineProxyPlugin(config),
    // CSS 主插件：`.css` 与预处理器的 load/transform。它依赖 resolve 已经完成，
    // 否则 @import 里的路径无法解析。
    cssPlugin(config),
    // esbuild 的 banner/footer 配置兼容（仅当用户配了 config.esbuild 时生效）。
    esbuildBannerFooterCompatPlugin(config),
    // oxc 运行时助手（jsx runtime 等）的解析。build 时由 rolldown 自己处理，
    // 所以这里用 applyToEnvironment 限定只在非打包环境生效。
    config.oxc !== false
      ? ({
          // oxlint-disable-next-line typescript/no-misused-spread - BuiltinPlugin is fine
          ...oxcRuntimePlugin(),
          applyToEnvironment(environment) {
            return !environment.config.isBundled
          },
        } satisfies Plugin)
      : null,
    // oxc 转译插件：TS/JSX → JS。这是 dev 下替代 esbuild 的那一层。
    // config.oxc === false 时整体关掉（用户自行处理转译）。
    config.oxc !== false ? oxcPlugin(config) : null,
    // JSON：用 rolldown 的原生插件，dev/build 同一实现。
    nativeJsonPlugin({ ...config.json, minify: isBuild }),
    // wasm / worker / asset：三类特殊资源。顺序上 asset 在最后，
    // 因为前面几类会先把「自己认识的扩展名」认领走，剩下的才当普通静态资源。
    wasmHelperPlugin(),
    webWorkerPlugin(config),
    assetPlugin(config),
    // for now client only
    // forwardConsole：把浏览器 console 转发到终端（仅 client 环境）。
    // 属于开发体验插件，不影响产物。
    config.server.forwardConsole.enabled &&
      forwardConsolePlugin({ environments: ['client'] }),

    ...normalPlugins,

    // define：替换编译期常量（import.meta.env 等）。必须在 importAnalysis 之前，
    // 否则被替换出来的新表达式不会被再次分析。
    definePlugin(config),
    // cssPost：CSS 的后处理（压缩、注入 HMR 代码）。它排在 cssPlugin 之后很远，
    // 是因为中间的用户插件可能还要改 CSS（例如 PostCSS 之外的转换）。
    cssPostPlugin(config),
    // buildHtml：生产构建时处理 index.html（注入 script/link、资源指纹）。
    buildHtmlPlugin(config),
    workerImportMetaUrlPlugin(config),
    assetImportMetaUrlPlugin(config),
    ...buildPlugins.pre,
    // dynamicImportVars：把 import(变量) 展开成 glob 或可静态分析的形态。
    // 必须在 importAnalysis 之前，否则 importAnalysis 看到的是无法解析的变量。
    dynamicImportVarsPlugin(config),
    // import.meta.glob：把 glob 调用展开成静态 import 表。同样必须在 importAnalysis 之前。
    importGlobPlugin(config),

    ...postPlugins,

    ...buildPlugins.post,

    // internal server-only plugins are always applied after everything else
    // 以下三个是 server-only 的内部插件，固定排在所有插件之后：
    //   clientInjections：注入 @vite/client 与 HMR 引导代码；
    //   cssAnalysis：收集 CSS 依赖（供 HMR 与 preload）；
    //   importAnalysis：改写 import 说明符——它必须看到最终代码，
    //   所以永远最后一个。
    clientInjectionsPlugin(config),
    cssAnalysisPlugin(config),
    importAnalysisPlugin(config),
  ].filter(Boolean) as Plugin[]
}

// hook 排序工具。排序结果按 hook 名缓存：同一插件的不同 hook 可以有不同的 order，
// 所以缓存 key 是 hook 名而不是插件。
export function createPluginHookUtils(
  plugins: readonly Plugin[],
): PluginHookUtils {
  // sort plugins per hook
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>()
  function getSortedPlugins<K extends keyof Plugin>(
    hookName: K,
  ): PluginWithRequiredHook<K>[] {
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName) as PluginWithRequiredHook<K>[]
    const sorted = getSortedPluginsByHook(hookName, plugins)
    sortedPluginsCache.set(hookName, sorted)
    return sorted
  }
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K,
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    const plugins = getSortedPlugins(hookName)
    return plugins.map((p) => getHookHandler(p[hookName])).filter(Boolean)
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks,
  }
}

// 排序算法：一次遍历，用三个游标把插件分别插到 pre 区 / normal 区 / post 区的末尾。
// 不用三次 filter + concat，是为了避免每个 hook 都创建三个临时数组（热路径）。
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[],
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = []
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) {
    const hook = plugin[hookName]
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

  return sortedPlugins as PluginWithRequiredHook<K>[]
}

// hook 既可以是函数，也可以是 { handler, order, filter, sequential } 对象。
// 这个函数把两种形态统一成可调用函数。
export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === 'object' ? hook.handler : hook) as HookHandler<T>
}

type FilterForPluginValue = {
  resolveId?: PluginFilter | undefined
  load?: PluginFilter | undefined
  transform?: TransformHookFilter | undefined
}
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>()

// filter 缓存：filter 声明在 hook 对象上，首次使用时编译成匹配函数并缓存。
// 编译成本不低（picomatch），所以必须缓存；key 用插件对象本身（WeakMap），
// 插件被回收时缓存自动释放。
export function getCachedFilterForPlugin<
  H extends 'resolveId' | 'load' | 'transform',
>(plugin: Plugin, hookName: H): FilterForPluginValue[H] | undefined {
  let filters = filterForPlugin.get(plugin)
  if (filters && hookName in filters) {
    return filters[hookName]
  }

  if (!filters) {
    filters = {}
    filterForPlugin.set(plugin, filters)
  }

  let filter: PluginFilter | TransformHookFilter | undefined
  switch (hookName) {
    case 'resolveId': {
      const rawFilter = extractFilter(plugin.resolveId)?.id
      filters.resolveId = createIdFilter(rawFilter)
      filter = filters.resolveId
      break
    }
    case 'load': {
      const rawFilter = extractFilter(plugin.load)?.id
      filters.load = createIdFilter(rawFilter)
      filter = filters.load
      break
    }
    case 'transform': {
      const rawFilters = extractFilter(plugin.transform)
      filters.transform = createFilterForTransform(
        rawFilters?.id,
        rawFilters?.code,
        rawFilters?.moduleType,
      )
      filter = filters.transform
      break
    }
  }
  return filter as FilterForPluginValue[H] | undefined
}

function extractFilter<T extends Function, F>(
  hook: ObjectHook<T, { filter?: F }> | undefined,
) {
  return hook && 'filter' in hook && hook.filter ? hook.filter : undefined
}

// Same as `@rollup/plugin-alias` default resolver, but we attach additional meta
// if we can't resolve to something, which will error in `importAnalysis`
// alias 的自定义 resolver：解析失败时不返回 null，而是带上 meta 标记返回原 id。
// 这样 importAnalysis 能给出「alias 指向的模块不存在」的精确报错，
// 而不是笼统的「Failed to resolve import」。
export const viteAliasCustomResolver: ResolverFunction = async function (
  id,
  importer,
  options,
) {
  const resolved = await this.resolve(id, importer, options)
  return resolved || { id, meta: { 'vite:alias': { noResolved: true } } }
}
