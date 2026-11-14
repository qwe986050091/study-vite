/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { RawSourceMap } from '@jridgewell/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import colors from 'picocolors'
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  ImportKind,
  InputOptions,
  LoadResult,
  ModuleInfo,
  ModuleOptions,
  ModuleType,
  NormalizedInputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  PluginContextMeta,
  ResolvedId,
  RollupError,
  RolldownFsModule as RollupFsModule,
  RollupLog,
  MinimalPluginContext as RollupMinimalPluginContext,
  PluginContext as RollupPluginContext,
  TransformPluginContext as RollupTransformPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rolldown'
import { parseAst as rolldownParseAst } from 'rolldown/parseAst'
import type { ESTree } from 'rolldown/utils'
import type { FSWatcher } from '#dep-types/chokidar'
import { cleanUrl, unwrapId } from '../../shared/utils'
import type { PluginHookUtils } from '../config'
import { FS_PREFIX, VERSION as viteVersion } from '../constants'
import {
  isFutureDeprecationEnabled,
  warnFutureDeprecation,
} from '../deprecations'
import type { Environment } from '../environment'
import type { Logger } from '../logger'
import type { Plugin } from '../plugin'
import {
  createPluginHookUtils,
  getCachedFilterForPlugin,
  getHookHandler,
} from '../plugins'
import {
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  rolldownVersion,
  rollupVersion,
  timeFrom,
} from '../utils'
import type { DevEnvironment } from './environment'
import { buildErrorMessage } from './middlewares/error'
import type {
  EnvironmentModuleGraph,
  EnvironmentModuleNode,
} from './moduleGraph'

// same default value of "moduleInfo.meta" as in Rollup
const EMPTY_OBJECT = Object.freeze({})

const debugSourcemapCombineFilter =
  process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
  onlyWhenFocused: true,
})
const debugResolve = createDebugger('vite:resolve')
const debugPluginResolve = createDebugger('vite:plugin-resolve', {
  onlyWhenFocused: 'vite:plugin',
})
const debugPluginTransform = createDebugger('vite:plugin-transform', {
  onlyWhenFocused: 'vite:plugin',
})
const debugPluginContainerContext = createDebugger(
  'vite:plugin-container-context',
)

// ============================================================================
// 文件角色：插件执行器（每个 Environment 一份）。

// Vite 的插件就是 rolldown/rollup 插件接口的超集。本文件把「一堆插件」变成
// 「一次请求上按确定顺序执行的一串 hook」，并且把 Vite 自己需要的额外语义
// （per-environment 状态、filter、跳过自身、sourcemap 串联、错误定位）补进去。

// 与 rolldown 的关系（关键）：
//   - dev（serve）阶段：Vite 自己实现这个容器，逐个调用插件 hook；
//   - build 阶段：配置交给 rolldown，由 rolldown 内部的插件容器执行；
//     本文件只负责把 hook 排好序、把 Vite 特有的插件形态（applyToEnvironment、
//     perEnvironment*）展开成 rolldown 认识的普通插件。
//   所以「插件 hook 顺序」在 dev 与 build 由同一份排序逻辑（getSortedPlugins）保证，
//   但调用方不是同一个。

// hook 执行顺序（本文件实现的）：
//   options            → 串行，可改 rolldown InputOptions（resolveRolldownOptions）
//   buildStart         → 并行（sequential 标记的插件串行）
//   resolveId          → 串行、hookFirst：第一个非空结果胜出，立即 break
//   load               → 串行、hookFirst
//   transform          → 串行、链式：每个插件的输出是下一个的输入
//   watchChange        → 并行
//   buildEnd / closeBundle → 并行（buildEnd 的错误会传给 closeBundle）
// 每个 hook 内部的插件顺序由 getSortedPluginsByHook 决定：pre → normal → post。
// ============================================================================
export const ERR_CLOSED_SERVER = 'ERR_CLOSED_SERVER'

export function throwClosedServerError(): never {
  // server 关闭/重启期间抛出的「请求过期」错误。
  // 用独立 code 而不是普通 Error：中间件要据此回 504 而不是 500。
  const err: any = new Error(
    'The server is being restarted or closed. Request is outdated',
  )
  err.code = ERR_CLOSED_SERVER
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

/**
 // 工厂：插件列表作为参数传入而不是从 environment.plugins 取，
 // 这样同一个 environment 可以并存多条插件流水线（典型用法是 createIdResolver：
 // 它需要一个「只做 resolve 的轻量容器」，不能触发 buildStart 等副作用）。
 * Create a plugin container with a set of plugins. We pass them as a parameter
 * instead of using environment.plugins to allow the creation of different
 * pipelines working with the same environment (used for createIdResolver).
 */
export async function createEnvironmentPluginContainer<
  Env extends Environment = Environment,
>(
  environment: Env,
  plugins: readonly Plugin[],
  watcher?: FSWatcher,
  autoStart = true,
): Promise<EnvironmentPluginContainer<Env>> {
  const container = new EnvironmentPluginContainer(
    environment,
    plugins,
    watcher,
    autoStart,
  )
  await container.resolveRolldownOptions()
  return container
}

export type SkipInformation = {
  // 传给「子解析」的跳过信息。插件在 resolveId 里调用 this.resolve() 时，
  // 必须能跳过自己（否则无限递归），并记住「这条 id+importer 我已经问过了」。
  // called=true 表示该次调用已经发生过，后续同一组合直接跳过。
  id: string
  importer: string | undefined
  plugin: Plugin
  called?: boolean
}

class EnvironmentPluginContainer<Env extends Environment = Environment> {
  // 字段职责速查（读方法体时来回对照，能省很多跳转）：
  //   _pluginContextMap       每个插件一个 context（插件可能用 this 存状态）
  //   _resolvedRolldownOptions options hook 链的结果，懒解析
  //   _processesing           未完成的 hook promise，close 时要等
  //   _seenResolves           只为 DEBUG 去重，不影响解析结果
  //   _moduleNodeToLoadAddedImports
  //                           load 阶段 addWatchFile 的结果，transform 阶段要复用
  //   watchFiles              容器级 watch 列表（getWatchFiles 的数据源）
  //   minimalContext          给不区分文件的 hook（buildStart/options）用的 context
  //   _started / _buildStartPromise / _closed / _closePromise
  //                           生命周期状态机，保证 hook 只跑一次、关闭可重入
  // 注意 moduleGraph 在 build 模式下是 undefined：容器本身不知道图，
  // 只在 dev 才把 environment.moduleGraph 借过来用。
  // 容器本体。注意 _resolvedRolldownOptions 是懒解析的：
  // options hook 可能依赖插件初始化，而插件初始化又可能发生在 buildStart，
  // 所以第一次真正需要 options 时才跑（见 resolveRolldownOptions）。
  private _pluginContextMap = new Map<Plugin, PluginContext>()
  private _resolvedRolldownOptions?: InputOptions
  private _processesing = new Set<Promise<any>>()
  private _seenResolves: Record<string, true | undefined> = {}

  // _addedFiles from the `load()` hook gets saved here so it can be reused in the `transform()` hook
  private _moduleNodeToLoadAddedImports = new WeakMap<
    EnvironmentModuleNode,
    Set<string> | null
  >()

  getSortedPluginHooks: PluginHookUtils['getSortedPluginHooks']
  // 每个 hook 的插件排序结果有缓存（plugins/index.ts 的 createPluginHookUtils）。
  // 排序规则只看 hook 的 order 字段（pre/normal/post），与插件数组顺序无关；
  // 插件数组顺序本身就是用户配置的顺序 + resolvePlugins 的固定内置顺序。
  getSortedPlugins: PluginHookUtils['getSortedPlugins']

  moduleGraph: EnvironmentModuleGraph | undefined
  watchFiles: Set<string> = new Set()
  minimalContext: MinimalPluginContext<Env>

  private _started = false
  private _buildStartPromise: Promise<void> | undefined
  private _closed = false
  private _closePromise: Promise<void> | undefined

  /**
   * @internal use `createEnvironmentPluginContainer` instead
   */
    // autoStart=false 供扫描阶段使用：扫描容器不应该触发 buildStart
    // （扫描只需要 resolve/load/transform 的静态分析能力）。
  constructor(
    public environment: Env,
    public plugins: readonly Plugin[],
    public watcher?: FSWatcher | undefined,
    autoStart = true,
  ) {
    this._started = !autoStart
    this.minimalContext = new MinimalPluginContext(
      { ...basePluginContextMeta, watchMode: true },
      environment,
    )
    const utils = createPluginHookUtils(plugins)
    this.getSortedPlugins = utils.getSortedPlugins
    this.getSortedPluginHooks = utils.getSortedPluginHooks
    this.moduleGraph =
      // 只有 dev 模式挂 moduleGraph；build 时模块信息由 rolldown 维护，
      // Vite 这边的 getModuleInfo 会返回 null（由插件自行降级）。
      environment.mode === 'dev' ? environment.moduleGraph : undefined
  }

  // load 期间插件通过 this.addWatchFile() 登记的依赖，会暂存在
  // LoadPluginContext._addedImports 里，这里把它绑到模块图上。
  // 目的：transform 阶段（尤其是 importAnalysis）需要知道「这个模块的产物的
  // 依赖集合」，而不想再跑一遍 load 去收集。
  // 注意即使 load 返回 null 也要记录（最后一个插件可能添加了 watch 文件）。
  private _updateModuleLoadAddedImports(
    id: string,
    addedImports: Set<string> | null,
  ): void {
    const module = this.moduleGraph?.getModuleById(id)
    if (module) {
      this._moduleNodeToLoadAddedImports.set(module, addedImports)
    }
  }

  private _getAddedImports(id: string): Set<string> | null {
    const module = this.moduleGraph?.getModuleById(id)
    return module
      ? this._moduleNodeToLoadAddedImports.get(module) || null
      : null
  }

  getModuleInfo(id: string): ModuleInfo | null {
    // build 模式下 moduleGraph 为 undefined，这里会直接返回 null：
    // 构建期的模块信息由 rolldown 维护，插件不能指望通过 Vite 容器拿到。
    // 暴露给插件的 module info。字段是惰性构造的 Proxy：
    // 访问不支持的属性直接抛错，让「照着 rollup 文档写了但 Vite 没实现」的插件
    // 立刻暴露问题，而不是拿到 undefined 后在深处崩。
    // 'then' 特判返回 undefined：避免 Proxy 被当成 thenable（async 函数返回它时会出错）。
    const module = this.moduleGraph?.getModuleById(id)
    if (!module) {
      return null
    }
    if (!module.info) {
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        // throw when an unsupported ModuleInfo property is accessed,
        // so that incompatible plugins fail in a non-cryptic way.
        {
          get(info: any, key: string) {
            if (key in info) {
              return info[key]
            }
            // Don't throw an error when returning from an async function
            if (key === 'then') {
              return undefined
            }
            throw Error(
              `[vite] The "${key}" property of ModuleInfo is not supported.`,
            )
          },
        },
      )
    }
    return module.info ?? null
  }

  // keeps track of hook promises so that we can wait for them all to finish upon closing the server
  // 记录所有未完成的 hook promise。close() 时要等它们结束，
  // 否则插件可能在 server 已经拆除后还在写文件/发请求。
  private handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    if (!(maybePromise as any)?.then) {
      return maybePromise
    }
    const promise = maybePromise as Promise<T>
    this._processesing.add(promise)
    return promise.finally(() => this._processesing.delete(promise))
  }

  // options 的读取入口。dev 阶段绝大多数插件不会读它（只有极少数
  // 需要知道 output.format / platform 的插件会读），所以解析可以懒到第一次访问。
  // 注意它返回的是「所有 options hook 依次处理后的结果」，不是用户原始配置：
  // 内置插件会在 options hook 里补 input/output 相关字段。
  get options(): InputOptions {
    return this._resolvedRolldownOptions!
  }

  async resolveRolldownOptions(): Promise<InputOptions> {
    // options hook 的结果会传给后续所有 hook（作为 NormalizedInputOptions）。
    // 注意这里用 || options：插件返回 undefined 时不覆盖前一个插件的结果。
    if (!this._resolvedRolldownOptions) {
      let options = this.environment.config.build.rolldownOptions
      for (const optionsHook of this.getSortedPluginHooks('options')) {
        if (this._closed) {
          throwClosedServerError()
        }
        options =
          (await this.handleHookPromise(
            optionsHook.call(this.minimalContext, options),
          )) || options
      }
      this._resolvedRolldownOptions = options
    }
    return this._resolvedRolldownOptions
  }

  private _getPluginContext(plugin: Plugin) {
    if (!this._pluginContextMap.has(plugin)) {
      this._pluginContextMap.set(plugin, new PluginContext(plugin, this))
    }
    return this._pluginContextMap.get(plugin)!
  }

  // parallel, ignores returns
  // 并行 hook 的通用实现：
  // 默认把每个插件的 promise 收集起来最后一起 await；
  // 插件显式声明 sequential: true 时，先等前面所有 promise 完成再执行自己。
  // 这个机制是给「必须严格先后」的插件（例如先写文件再统计）留的口子。
  private async hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
    condition?: (plugin: Plugin) => boolean | undefined,
  ): Promise<void> {
    const parallelPromises: Promise<unknown>[] = []
    for (const plugin of this.getSortedPlugins(hookName)) {
      // Don't throw here if closed, so buildEnd and closeBundle hooks can finish running
      if (condition && !condition(plugin)) continue

      const hook = plugin[hookName]
      const handler: Function = getHookHandler(hook)
      if ((hook as { sequential?: boolean }).sequential) {
        await Promise.all(parallelPromises)
        parallelPromises.length = 0
        await handler.apply(context(plugin), args(plugin))
      } else {
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    await Promise.all(parallelPromises)
  }

  /**
   * buildStart 的三层保护，缺一不可：
   *   1. _started：已跑过就直接返回（不再重复触发插件副作用）；
   *   2. _buildStartPromise：正在跑就等它，而不是并发跑第二遍；
   *   3. _registerInputsAsSafeModules：dev 下 buildStart 结束后要把
   *      「受信任的模块路径」登记进 safeModulePaths，后续静态文件服务据此放行。
   * 之所以把登记放在 hook 之后，是因为插件可以在 buildStart 里动态添加 safe 路径。
   */
  async buildStart(_options?: InputOptions): Promise<void> {
    // buildStart 只在第一次触发（resolveId/load/transform 都会确保它先跑过）。
    // _buildStartPromise 用来合并并发：多个请求同时到达时只跑一次 buildStart。
    if (this._started) {
      if (this._buildStartPromise) {
        await this._buildStartPromise
      }
      return
    }
    this._started = true
    const config = this.environment.getTopLevelConfig()
      // 兼容性开关：v5 之前 dev 只对 client 跑一次 buildStart。
      // 现在默认仍然如此，perEnvironmentStartEndDuringDev=true 时每个 environment 各跑一次。
      // 插件自身也可以用 perEnvironmentStartEndDuringDev 单独开启。
    const hookPromise = this.handleHookPromise(
      this.hookParallel(
        'buildStart',
        (plugin) => this._getPluginContext(plugin),
        () => [this.options as NormalizedInputOptions],
        (plugin) =>
          this.environment.name === 'client' ||
          config.server.perEnvironmentStartEndDuringDev ||
          plugin.perEnvironmentStartEndDuringDev,
      ),
    ) as Promise<void>
    this._buildStartPromise = (async () => {
      await hookPromise
      if (this.environment.mode === 'dev') {
        await this.environment._registerInputsAsSafeModules()
      }
    })()
    await this._buildStartPromise
    this._buildStartPromise = undefined
  }

  // resolveId。三层语义：
  //   1. 串行、hookFirst——第一个返回非空结果的插件决定 id，后面的不再问；
  //   2. skip / skipCalls——跳过调用者自己以及已经问过的组合，防递归；
  //   3. filter——插件用 filter 声明只处理某些 id，未命中直接跳过（省一次函数调用，
  //      对热路径有意义）。
  // 返回值统一成 PartialResolvedId；字符串形式是 rollup 的旧约定。
  // 两个默认值很关键：
  //   - importer 默认是 root/index.html：浏览器直接请求的模块没有 importer，
  //     但解析器需要一个「从哪个文件出发」的基准（否则相对路径与 exports 条件无法判定）；
  //   - kind 未传时为 undefined：内置 resolve 插件据此走「宽松」分支。
  // attributes 是 import attributes（with { type: 'json' }），会透传给插件。
  // _seenResolves 只服务于 DEBUG 日志去重，不参与解析决策。
  async resolveId(
    rawId: string,
    importer: string | undefined = join(
      this.environment.config.root,
      'index.html',
    ),
    options?: {
      kind?: ImportKind
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      /** @deprecated use `skipCalls` instead */
      skip?: Set<Plugin>
      skipCalls?: readonly SkipInformation[]
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null> {
    if (!this._started) {
      // 懒启动 buildStart：任何 resolveId 调用都会先把 buildStart 跑完，
      // 保证插件在 resolve 阶段看到的初始化状态是一致的。
      this.buildStart()
      await this._buildStartPromise
    }
    const skip = options?.skip
    const skipCalls = options?.skipCalls
    const scan = !!options?.scan
    const ssr = this.environment.config.consumer === 'server'
    const ctx = new ResolveIdContext(this, skip, skipCalls, scan)
    const topLevelConfig = this.environment.getTopLevelConfig()

    const mergedSkip = new Set<Plugin>(skip)
    for (const call of skipCalls ?? []) {
      if (call.called || (call.id === rawId && call.importer === importer)) {
        mergedSkip.add(call.plugin)
      }
    }

    const resolveStart = debugResolve ? performance.now() : 0
    let id: string | null = null
    const partial: Partial<PartialResolvedId> = {}
    for (const plugin of this.getSortedPlugins('resolveId')) {
      // 按 hook 排序后的插件顺序遍历（pre → normal → post）。
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()
      if (mergedSkip?.has(plugin)) continue

      const filter = getCachedFilterForPlugin(plugin, 'resolveId')
      // filter 未命中就跳过。filter 由插件在声明 hook 时给出，
      // 首次使用时编译并缓存（getCachedFilterForPlugin）。
      if (filter && !filter(rawId)) continue

      ctx._plugin = plugin

      const normalizedOptions = {
        // 传给插件的 options。ssr 由 environment.consumer 推导，
        // 不是由调用方传的——这是 Vite 6 之后「环境即上下文」的体现。
        kind: options?.kind,
        attributes: options?.attributes ?? {},
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        ssr,
        scan,
      }
        // 兼容：removePluginHookSsrArgument 打开后，ssr 字段变成 getter，
        // 一旦被读取就打 future deprecation 警告。目的是让插件逐步不再依赖这个参数。
      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        let ssrTemp = ssr
        Object.defineProperty(normalizedOptions, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssrTemp
          },
          set(v) {
            ssrTemp = v
          },
        })
      }

      const pluginResolveStart = debugPluginResolve ? performance.now() : 0
      const handler = getHookHandler(plugin.resolveId)
      const result = await this.handleHookPromise(
        handler.call(ctx as any, rawId, importer, normalizedOptions),
      )
      if (!result) continue

      if (typeof result === 'string') {
        id = result
      } else {
        id = result.id
        Object.assign(partial, result)
      }

      debugPluginResolve?.(
        timeFrom(pluginResolveStart),
        plugin.name,
        prettifyUrl(id, this.environment.config.root),
      )

      // resolveId() is hookFirst - first non-null result is returned.
      // hookFirst 语义：拿到第一个非空结果就 break。
      // 这是 resolve 能与 rollup 兼容的基础——alias、resolve、optimizedDeps 等插件
      // 都按「谁先认领谁负责」排列，顺序错了会解析到错误位置。
      break
    }

    if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
      const key = rawId + id
      // avoid spamming
      if (!this._seenResolves[key]) {
        this._seenResolves[key] = true
        debugResolve(
          `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
            id,
          )}`,
        )
      }
    }

    if (id) {
      // 出口归一化：虚拟模块（\0 开头）和 URL 保持原样，其余路径分隔符统一成 /。
      // 不做这一步，Windows 下 id 会在后续比较中失配（同一文件两种写法）。
      partial.id = isExternalUrl(id) || id[0] === '\0' ? id : normalizePath(id)
      return partial as PartialResolvedId
    } else {
      return null
    }
  }

  async load(id: string): Promise<LoadResult | null> {
    // load：同样是 hookFirst。返回对象时额外处理两件事：
    //   - meta 合并进 moduleInfo；
    //   - 把 load 期间 addWatchFile 的依赖记到 module 上，供 transform 阶段复用
    //     （见 _updateModuleLoadAddedImports / _getAddedImports）。
    let ssr = this.environment.config.consumer === 'server'
    const topLevelConfig = this.environment.getTopLevelConfig()
    const options = { ssr }
    const ctx = new LoadPluginContext(this)
    for (const plugin of this.getSortedPlugins('load')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()

      const filter = getCachedFilterForPlugin(plugin, 'load')
      if (filter && !filter(id)) continue

      ctx._plugin = plugin

      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        Object.defineProperty(options, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssr
          },
          set(v) {
            ssr = v
          },
        })
      }

      const handler = getHookHandler(plugin.load)
      const result = await this.handleHookPromise(
        handler.call(ctx as any, id, options),
      )
      if (result != null) {
        if (isObject(result)) {
          ctx._updateModuleInfo(id, result)
        }
        this._updateModuleLoadAddedImports(id, ctx._addedImports)
        return result
      }
    }
    this._updateModuleLoadAddedImports(id, ctx._addedImports)
    return null
  }

    // transform：串行链式，不是 hookFirst。
    // 每个插件的输出 code 立刻成为下一个插件的输入；map 不是覆盖而是压栈，
    // 最后用 sourcemapChain 逆序合并（见 TransformPluginContext）。
  async transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      moduleType?: string
    },
  ): Promise<{
    code: string
    map: SourceMap | { mappings: '' } | null
    moduleType?: ModuleType
  }> {
    let ssr = this.environment.config.consumer === 'server'
    // optionsWithSSR 是同一个对象在整条链上共享的：
    // 一个插件把 ssr 改成 true，后面的插件就能看到。这是 rollup 的既有行为。
    const topLevelConfig = this.environment.getTopLevelConfig()
    const optionsWithSSR = options
      ? { ...options, ssr, moduleType: options.moduleType ?? 'js' }
      : { ssr, moduleType: 'js' }
    const inMap = options?.inMap

    const ctx = new TransformPluginContext(this, id, code, inMap as SourceMap)
    // 每次 transform 新建一个 context。context 里保存：
    //   - originalCode / sourcemapChain：用于合并 map；
    //   - _activeId / _activeCode：用于错误定位时生成 code frame。
    // 复用 context 会导致 sourcemap 串联错误，所以必须每次新建。
    ctx._addedImports = this._getAddedImports(id)

    for (const plugin of this.getSortedPlugins('transform')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()

      const filter = getCachedFilterForPlugin(plugin, 'transform')
      if (filter && !filter(id, code, optionsWithSSR.moduleType)) continue

      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        Object.defineProperty(optionsWithSSR, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssr
          },
          set(v) {
            ssr = v
          },
        })
      }

      ctx._updateActiveInfo(plugin, id, code)
      // 更新「当前活跃插件/文件/代码」，供 this.error() 补全 plugin 名与 code frame。
      const start = debugPluginTransform ? performance.now() : 0
      let result: TransformResult | string | undefined
      const handler = getHookHandler(plugin.transform)
      try {
        result = await this.handleHookPromise(
          handler.call(ctx as any, code, id, optionsWithSSR),
        )
      } catch (e) {
        ctx.error(e)
      }
      // 插件返回空值 = 「我不处理这个文件」，code 原样传给下一个插件。
      // 这与 resolveId 的 hookFirst 不同：transform 永远是全链执行，
      // 所以「空返回」是常态而不是终止信号。
      if (!result) continue
      debugPluginTransform?.(
        timeFrom(start),
        plugin.name,
        prettifyUrl(id, this.environment.config.root),
      )
      if (isObject(result)) {
        // 返回对象时的处理：
        //   - code 为 undefined 表示「我只改 map / 只声明 moduleType」，链上的 code 不变；
        //   - map 只在 code 真正变化时才压栈（否则 map 对应的是旧 code）；
        //   - moduleType 会被后续插件与 rolldown 消费。
        if (result.code !== undefined) {
          code = result.code as string
          if (result.map) {
            if (debugSourcemapCombine) {
              // @ts-expect-error inject plugin name for debug purpose
              result.map.name = plugin.name
            }
            ctx.sourcemapChain.push(result.map)
          }
        }
        if (result.moduleType !== undefined) {
          optionsWithSSR.moduleType = result.moduleType
        }
        ctx._updateModuleInfo(id, result)
      } else {
        code = result
      }
    }
    return {
      // 返回时把 sourcemapChain 合并成一张 map。合并发生在每次 transform 结束时，
      // 因此下一个 hook 看到的是「到目前为止的完整 map」。
      code,
      map: ctx._getCombinedSourcemap(),
      moduleType: optionsWithSSR.moduleType,
    }
  }

    // watchChange：并行通知。同样有 per-environment 兼容开关：
    // 默认只有 client 收到，避免 SSR 环境把同一个文件事件处理两遍。
  async watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void> {
    const config = this.environment.getTopLevelConfig()
    await this.hookParallel(
      'watchChange',
      (plugin) => this._getPluginContext(plugin),
      () => [id, change],
      (plugin) =>
        this.environment.name === 'client' ||
        config.server.perEnvironmentWatchChangeDuringDev ||
        plugin.perEnvironmentWatchChangeDuringDev,
    )
  }

  // 关闭的幂等实现：并发调用 close() 时共享同一个 promise；
  // 结束后把 _closePromise 清空，但 _closed 保持 true——
  // 也就是「第二次 close 立即返回、不重复跑 hook」。
  async close(): Promise<void> {
    if (this._closed) return this._closePromise
    this._closed = true
    this._closePromise = this._close()
    try {
      await this._closePromise
    } finally {
      // Once cleanup settles, repeated closes remain a no-op, including after errors.
      this._closePromise = undefined
    }
  }

  private async _close(): Promise<void> {
    // 关闭分三步：等所有 hook 完成 → buildEnd → closeBundle。
    // buildEnd 的错误不立即抛，而是作为参数传给 closeBundle（rollup 的约定），
    // 等 closeBundle 也跑完再抛，保证清理代码一定执行。
    await Promise.allSettled(this._processesing)
    const config = this.environment.getTopLevelConfig()
    let buildEndError: Error | undefined
    try {
      await this.hookParallel(
        'buildEnd',
        (plugin) => this._getPluginContext(plugin),
        () => [],
        (plugin) =>
          this.environment.name === 'client' ||
          config.server.perEnvironmentStartEndDuringDev ||
          plugin.perEnvironmentStartEndDuringDev,
      )
    } catch (error) {
      buildEndError = error as Error
    }
    await this.hookParallel(
      'closeBundle',
      (plugin) => this._getPluginContext(plugin),
      () => [buildEndError],
    )
    if (buildEndError) {
      throw buildEndError
    }
  }
}

export const basePluginContextMeta: {
  viteVersion: string
  rollupVersion: string
  rolldownVersion: string
} = {
  viteVersion,
  rollupVersion,
  rolldownVersion,
}

// 最小的 context：只有 meta 与日志方法，没有 resolve/load 能力。
// buildStart / configureServer / closeServer 这类「不针对某个模块」的 hook 用它。
// meta 里同时暴露 viteVersion / rollupVersion / rolldownVersion 三个字段——
// 生态里大量插件用 rollupVersion 做特性判断，而 Vite 8 的内核其实是 rolldown，
// 所以必须两个都报，否则插件会因为「rollup 版本号看起来很低」而走错分支。
export class BasicMinimalPluginContext<Meta = PluginContextMeta> {
  constructor(
    public meta: Meta,
    private _logger: Logger,
  ) {}

  // FIXME: properly support this later
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get pluginName(): string {
    return ''
  }

  debug(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(log, [`debug: ${log.message}`], false)
    debugPluginContainerContext?.(msg)
  }

  info(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(log, [`info: ${log.message}`], false)
    this._logger.info(msg, { clear: true, timestamp: true })
  }

  warn(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(
      log,
      [colors.yellow(`warning: ${log.message}`)],
      false,
    )
    this._logger.warn(msg, { clear: true, timestamp: true })
  }

  error(e: string | RollupError): never {
    const err = (typeof e === 'string' ? new Error(e) : e) as RollupError
    throw err
  }

  private _normalizeRawLog(
    rawLog: string | RollupLog | (() => string | RollupLog),
  ): RollupLog {
    const logValue = typeof rawLog === 'function' ? rawLog() : rawLog
    return typeof logValue === 'string' ? new Error(logValue) : logValue
  }
}

class MinimalPluginContext<T extends Environment = Environment>
  extends BasicMinimalPluginContext
  implements RollupMinimalPluginContext
{
  public environment: T
  constructor(meta: PluginContextMeta, environment: T) {
    super(meta, environment.logger)
    this.environment = environment
  }
}

// 暴露给插件的最小文件系统接口（rollup 的 this.fs）。
// 只挑常用方法，不直接暴露整个 node:fs/promises：
// 这样 build 侧把插件搬到 rolldown 的沙箱/虚拟文件系统时，接口面是一致的。
const fsModule: RollupFsModule = {
  appendFile: fsp.appendFile,
  copyFile: fsp.copyFile,
  mkdir: fsp.mkdir as RollupFsModule['mkdir'],
  mkdtemp: fsp.mkdtemp,
  readdir: fsp.readdir,
  readFile: fsp.readFile as RollupFsModule['readFile'],
  realpath: fsp.realpath,
  rename: fsp.rename,
  rmdir: fsp.rmdir,
  stat: fsp.stat,
  lstat: fsp.lstat,
  unlink: fsp.unlink,
  writeFile: fsp.writeFile,
}

// 插件 context。实现了 rollup PluginContext 的大部分方法，但 dev 阶段
// 有些在语义上做不到，于是显式告警而不是静默返回空值：
//   - emitFile / setAssetSource / getFileName：dev 没有产物，只在 build 有意义；
//   - cache：没有实现（rollup 的持久缓存机制在 dev 不存在）。
// 这类「明确不支持」比「假装支持」更利于插件作者定位问题。
class PluginContext
  extends MinimalPluginContext
  implements Omit<RollupPluginContext, 'cache'>
{
  ssr = false
  // ssr 字段在 context 上是可写的（rollup 兼容）。Vite 内部用
  // environment.consumer 判断环境，不读这个字段。
  _scan = false
  _activeId: string | null = null
  _activeCode: string | null = null
  _resolveSkips?: Set<Plugin>
  _resolveSkipCalls?: readonly SkipInformation[]

  override get pluginName(): string {
    return this._plugin.name
  }

  constructor(
    public _plugin: Plugin,
    public _container: EnvironmentPluginContainer,
  ) {
    super(_container.minimalContext.meta, _container.environment)
  }

  fs: RollupFsModule = fsModule

  // 用 rolldown 的解析器而不是 acorn：这样插件在 dev 里 this.parse 出来的 AST，
  // 与构建内核实际解析的语法范围一致（例如装饰器、import attributes）。
  parse(code: string, opts: any): ESTree.Program {
    // parse 用 rolldown 自带的解析器（不是 acorn）。插件里 this.parse 的
    // 语法支持范围因此与构建内核一致。
    return rolldownParseAst(code, opts)
  }

    // this.resolve 的递归防护：
    //   - skipSelf 默认 true：跳过调用者自己，否则 alias 这类插件会自我递归；
    //   - skipSelf=false 时允许问自己，但要把当前组合记进 skipCalls，
    //     第二次遇到同一组合就跳过（防止 A 问 B、B 又问 A）。
    // 这段逻辑读起来绕，但它保证的是「resolve 图一定能终止」。
  async resolve(
    id: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      isEntry?: boolean
      skipSelf?: boolean
    },
  ): Promise<ResolvedId | null> {
    let skipCalls: readonly SkipInformation[] | undefined
    if (options?.skipSelf === false) {
      skipCalls = this._resolveSkipCalls
    } else if (this._resolveSkipCalls) {
      const skipCallsTemp = [...this._resolveSkipCalls]
      const sameCallIndex = this._resolveSkipCalls.findIndex(
        (c) =>
          c.id === id && c.importer === importer && c.plugin === this._plugin,
      )
      if (sameCallIndex !== -1) {
        skipCallsTemp[sameCallIndex] = {
          ...skipCallsTemp[sameCallIndex],
          called: true,
        }
      } else {
        skipCallsTemp.push({ id, importer, plugin: this._plugin })
      }
      skipCalls = skipCallsTemp
    } else {
      skipCalls = [{ id, importer, plugin: this._plugin }]
    }

    let out = await this._container.resolveId(id, importer, {
      attributes: options?.attributes,
      custom: options?.custom,
      isEntry: !!options?.isEntry,
      skip: this._resolveSkips,
      skipCalls,
      scan: this._scan,
    })
    if (typeof out === 'string') out = { id: out }
    return out as ResolvedId | null
  }

    // this.load：让插件在 resolve/transform 期间主动加载另一个模块。
    // 会先补建模块图条目，再走完整的 load + transform（不是只 load），
    // 所以拿到的是「可执行形态」的模块信息。
  async load(
    options: {
      id: string
      resolveDependencies?: boolean
    } & Partial<PartialNull<ModuleOptions>>,
  ): Promise<ModuleInfo> {
    // We may not have added this to our module graph yet, so ensure it exists
    await this._container.moduleGraph?.ensureEntryFromUrl(unwrapId(options.id))
    // Not all options passed to this function make sense in the context of loading individual files,
    // but we can at least update the module info properties we support
    this._updateModuleInfo(options.id, options)

    const loadResult = await this._container.load(options.id)
    const code = typeof loadResult === 'object' ? loadResult?.code : loadResult
    if (code != null) {
      await this._container.transform(code, options.id)
    }

    const moduleInfo = this.getModuleInfo(options.id)
    // This shouldn't happen due to calling ensureEntryFromUrl, but 1) our types can't ensure that
    // and 2) moduleGraph may not have been provided (though in the situations where that happens,
    // we should never have plugins calling this.load)
    if (!moduleInfo) throw Error(`Failed to load module with id ${options.id}`)
    return moduleInfo
  }

  getModuleInfo(id: string): ModuleInfo | null {
    return this._container.getModuleInfo(id)
  }

  // meta 是模块级共享数据（rollup 的 moduleInfo.meta）：用来在插件之间传递
  // 「这个模块的额外信息」，例如 vue 插件把 SFC 的 descriptor 挂在 meta 上，
  // 后续插件（如 HMR 相关）再读出来用。这里是浅合并，后写覆盖先写。
  _updateModuleInfo(id: string, { meta }: { meta?: object | null }): void {
    if (meta) {
      const moduleInfo = this.getModuleInfo(id)
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  // 迭代器而不是数组：模块图可能很大，避免为一次遍历分配快照。
  // build 模式没有 moduleGraph，返回空迭代器（而不是 null），保持调用方代码统一。
  getModuleIds(): IterableIterator<string> {
    return this._container.moduleGraph
      ? this._container.moduleGraph.idToModuleMap.keys()
      : Array.prototype[Symbol.iterator]()
  }

  // 注意这里不区分「load 阶段的 addWatchFile」与「transform 阶段的 addWatchFile」：
  // 前者会被 LoadPluginContext 覆写并额外收集到 _addedImports，
  // 后者直接落到容器级的 watchFiles（不会回填给 moduleGraph）。
  addWatchFile(id: string): void {
    // addWatchFile：同时记进容器级 watchFiles 与真实 watcher。
    // dev 下必须真的挂 watcher，否则这个文件改了不会触发 HMR。
    this._container.watchFiles.add(id)
    if (this._container.watcher)
      ensureWatchedFile(
        this._container.watcher,
        id,
        this.environment.config.root,
      )
  }

  // watchFiles 是「插件声明过的依赖」的集合，和真实 watcher 不是一回事：
  // watcher 可能因为配置为 null 而不存在，但插件仍然可以查询自己声明过哪些文件。
  // 返回副本而不是内部 Set，防止调用方直接改容器状态。
  getWatchFiles(): string[] {
    return [...this._container.watchFiles]
  }

  // dev 没有产物概念，emitFile 无处落地，只能告警并返回空文件名。
  // 返回 '' 而不是抛错：让插件继续执行，由后续逻辑决定是否还有意义。
  emitFile(_assetOrFile: EmittedFile): string {
    this._warnIncompatibleMethod(`emitFile`)
    return ''
  }

  // 与 emitFile 同属「build 才有意义」的一组：setAssetSource 设置产物的源内容，
  // getFileName 反查产物的最终文件名。dev 没有产物表，两个方法都只能告警。
  setAssetSource(): void {
    this._warnIncompatibleMethod(`setAssetSource`)
  }

  getFileName(): string {
    this._warnIncompatibleMethod(`getFileName`)
    return ''
  }

  // 日志三兄弟（debug/info/warn）都先过 _formatLog 再交给 logger：
  // 这样插件用 this.warn('...') 时，输出里也会带上插件名与 code frame，
  // 与插件用 this.error 的呈现保持一致。debug 走 DEBUG 通道，默认不打印。
  override debug(log: string | RollupLog | (() => string | RollupLog)): void {
    const err = this._formatLog(typeof log === 'function' ? log() : log)
    super.debug(err)
  }

  override info(log: string | RollupLog | (() => string | RollupLog)): void {
    const err = this._formatLog(typeof log === 'function' ? log() : log)
    super.info(err)
  }

  override warn(
    log: string | RollupLog | (() => string | RollupLog),
    position?: number | { column: number; line: number },
  ): void {
    const err = this._formatLog(
      typeof log === 'function' ? log() : log,
      position,
    )
    super.warn(err)
  }

  override error(
    e: string | RollupError,
    position?: number | { column: number; line: number },
  ): never {
    // error thrown here is caught by the transform middleware and passed on
    // the error middleware.
    throw this._formatLog(e, position)
  }

  /**
   * 把插件抛出的「裸错误」补齐成 Vite/rollup 风格的可展示错误。
   *
   * 输入形态有三种，都要兼容：
   *   - pos（数字偏移）：rollup 的老写法，用 numberToPos 转行列；
   *   - loc（{file,line,column}）：预处理器/编译器常给；
   *   - line + column：部分插件给。
   * 如果当前处于 transform 且已经有多张 map，还要把位置回溯到原始源码
   * （TraceMap + originalPositionFor），否则报错会指向转译后的中间代码。
   *
   * 一个易错点：pluginCode 有值说明这个错误已经由插件自己格式化过（err.frame 已有），
   * 此时不能再覆盖，否则会丢掉插件精心准备的 code frame。
   */
    // 错误格式化。三件事：
    //   1. 补 plugin 名与 id；
    //   2. 把位置信息（pos / loc / line+column）统一成 loc + frame；
    //   3. 若在 transform 中且能拿到合并 map，用 trace-mapping 把位置回溯到原始源码，
    //      这样报错指向的是用户写的 .ts 而不是转译后的 .js。
  private _formatLog<E extends RollupLog>(
    e: string | E,
    position?: number | { column: number; line: number },
  ): E {
    const err = (typeof e === 'string' ? new Error(e) : e) as E
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    err.plugin = this._plugin.name
    if (this._activeId && !err.id) err.id = this._activeId
    if (this._activeCode) {
      err.pluginCode = this._activeCode

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      const pos = position ?? err.pos ?? (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(this._activeCode, pos)
        } catch (err2) {
          this.environment.logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        err.frame = err.frame || generateCodeFrame(this._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = this._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(this._activeCode, err.loc)
      }

      // TODO: move it to overrides
      if (
        this instanceof TransformPluginContext &&
        typeof err.loc?.line === 'number' &&
        typeof err.loc.column === 'number'
      ) {
        const rawSourceMap = this._getCombinedSourcemap()
        if (rawSourceMap && 'version' in rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc)
        }
      }
    }

    if (
      typeof err.loc?.column !== 'number' &&
      typeof err.loc?.line !== 'number' &&
      !err.loc?.file
    ) {
      delete err.loc
    }

    return err
  }

  // 不支持的 context 方法统一走这里：一条 warn，带上插件名与「serve 模式不支持」。
  // 选择 warn 而不是 throw，是为了让「只在 build 用这些 API」的插件在 dev 下仍能跑起来。
  _warnIncompatibleMethod(method: string): void {
    this.environment.logger.warn(
      colors.cyan(`[plugin:${this._plugin.name}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`,
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
        ),
    )
  }
}

// resolve 阶段的 context。刻意把 _plugin 传成 null：
// 此时还不知道「当前是哪个插件在问」，要等 resolveId 循环里逐个 ctx._plugin = plugin。
// 它为每个插件携带「跳过集合」，这是 resolve 图能终止的关键。
class ResolveIdContext extends PluginContext {
  constructor(
    container: EnvironmentPluginContainer,
    skip: Set<Plugin> | undefined,
    skipCalls: readonly SkipInformation[] | undefined,
    scan: boolean,
  ) {
    super(null!, container)
    this._resolveSkips = skip
    this._resolveSkipCalls = skipCalls
    this._scan = scan
  }
}

// load 阶段的 context。相对基类只多一件事：收集 load 期间新增的 watch 文件。
// 为什么单独收集：load 出来的模块可能不在 moduleGraph 里（例如虚拟模块），
// 但它的依赖文件仍然需要被监听，于是用 _addedImports 临时承接，load 结束后
// 交给容器按 id 归档。
class LoadPluginContext extends PluginContext {
  _addedImports: Set<string> | null = null

  constructor(container: EnvironmentPluginContainer) {
    super(null!, container)
  }

  override addWatchFile(id: string): void {
    if (!this._addedImports) {
      this._addedImports = new Set()
    }
    this._addedImports.add(id)
    super.addWatchFile(id)
  }
}

// transform 专用 context：在 load context 基础上增加 sourcemap 合并能力。
// sourcemapChain 的合并顺序是「后发生的变换先作用」，
// 所以 combineSourcemaps 的调用是 [新的, 旧的]，不能反过来。
class TransformPluginContext
  extends LoadPluginContext
  implements Omit<RollupTransformPluginContext, 'cache'>
{
  filename: string
  originalCode: string
  originalSourcemap: SourceMap | null = null
  sourcemapChain: NonNullable<SourceDescription['map']>[] = []
  combinedMap: SourceMap | { mappings: '' } | null = null

  constructor(
    container: EnvironmentPluginContainer,
    id: string,
    code: string,
    inMap?: SourceMap | string,
  ) {
    super(container)

    this.filename = id
    this.originalCode = code
    if (inMap) {
      if (debugSourcemapCombine) {
        // @ts-expect-error inject name for debug purpose
        inMap.name = '$inMap'
      }
      this.sourcemapChain.push(inMap)
    }
  }

  // 合并策略：从「最早」到「最新」逐张叠加，每叠加一张就丢掉旧链。
  // 这样 combinedMap 始终代表「从原始源码到当前 code」的映射，
  // 下一次 transform 只需要在它上面再叠一层，不必重放整条历史。
  // 代价：合并后的 map 不能反推单个插件的贡献（调试时靠 DEBUG_VITE_SOURCEMAP_COMBINE 打印链）。
  _getCombinedSourcemap(): SourceMap | { mappings: '' } | null {
    // 合并 sourcemap。三个特殊约定：
    //   - { mappings: '' } 是「显式空 map」哨兵：表示「不要 sourcemap」，直接清链返回；
    //   - 非空对象但没有 version：视为空 map，链上出现即结果为空；
    //   - 只有一张 map 且 sources 是 [null] 或 [''] 时，补上 filename 与原始代码
    //     （MagicString 未设 filename 时的产物，rollup 也这样兜底）。
    if (
      debugSourcemapCombine &&
      debugSourcemapCombineFilter &&
      this.filename.includes(debugSourcemapCombineFilter)
    ) {
      debugSourcemapCombine('----------', this.filename)
      debugSourcemapCombine(this.combinedMap)
      debugSourcemapCombine(this.sourcemapChain)
      debugSourcemapCombine('----------')
    }

    let combinedMap = this.combinedMap
    // { mappings: '' }
    if (
      combinedMap &&
      !('version' in combinedMap) &&
      combinedMap.mappings === ''
    ) {
      this.sourcemapChain.length = 0
      return combinedMap
    }

    for (let m of this.sourcemapChain) {
      if (typeof m === 'string') m = JSON.parse(m)
      if (!('version' in (m as SourceMap))) {
        // { mappings: '' }
        if ((m as SourceMap).mappings === '') {
          combinedMap = { mappings: '' }
          break
        }
        // empty, nullified source map
        combinedMap = null
        break
      }
      if (!combinedMap) {
        const sm = m as SourceMap
        // sourcemap should not include `sources: [null]` (because `sources` should be string) nor
        // `sources: ['']` (because `''` means the path of sourcemap)
        // but MagicString generates this when `filename` option is not set.
        // Rollup supports these and therefore we support this as well
        if (sm.sources.length === 1 && !sm.sources[0]) {
          combinedMap = {
            ...sm,
            sources: [this.filename],
            sourcesContent: [this.originalCode],
          }
        } else {
          combinedMap = sm
        }
      } else {
        combinedMap = combineSourcemaps(cleanUrl(this.filename), [
          m as RawSourceMap,
          combinedMap as RawSourceMap,
        ]) as SourceMap
      }
    }
    if (combinedMap !== this.combinedMap) {
      this.combinedMap = combinedMap
      this.sourcemapChain.length = 0
    }
    return this.combinedMap
  }

  getCombinedSourcemap(): SourceMap {
    // 对外暴露的 getCombinedSourcemap：没有可用 map 时用 MagicString 生成一张
    // 恒等 map（保证插件拿到的永远是非空 sourcemap，符合 rollup 契约）。
    const map = this._getCombinedSourcemap()
    if (!map || (!('version' in map) && map.mappings === '')) {
      return new MagicString(this.originalCode).generateMap({
        includeContent: true,
        hires: 'boundary',
        source: cleanUrl(this.filename),
      }) as SourceMap
    }
    return map
  }

  _updateActiveInfo(plugin: Plugin, id: string, code: string): void {
    this._plugin = plugin
    this._activeId = id
    this._activeCode = code
  }
}

export type {
  EnvironmentPluginContainer,
  TransformPluginContext,
  TransformResult,
}

// Backward compatibility
class PluginContainer {
  // 兼容包装：旧 API 的 server.pluginContainer 是一个「不知道 environment」的对象。
  // 这里按 options.ssr 选 client/ssr，再转发到对应 environment 的容器。
  // 新代码应直接用 environment.pluginContainer。
  constructor(private environments: Record<string, Environment>) {}

  // Backward compatibility
  // Users should call pluginContainer.resolveId (and load/transform) passing the environment they want to work with
  // But there is code that is going to call it without passing an environment, or with the ssr flag to get the ssr environment
  private _getEnvironment(options?: {
    ssr?: boolean
    environment?: Environment
  }) {
    return options?.environment
      ? options.environment
      : this.environments[options?.ssr ? 'ssr' : 'client']
  }

  private _getPluginContainer(options?: {
    ssr?: boolean
    environment?: Environment
  }) {
    return (this._getEnvironment(options) as DevEnvironment).pluginContainer
  }

  getModuleInfo(id: string): ModuleInfo | null {
    const clientModuleInfo = (
      this.environments.client as DevEnvironment
    ).pluginContainer.getModuleInfo(id)
    const ssrModuleInfo = (
      this.environments.ssr as DevEnvironment
    ).pluginContainer.getModuleInfo(id)

    if (clientModuleInfo == null && ssrModuleInfo == null) return null

    return new Proxy({} as any, {
      get: (_, key: string) => {
        // `meta` refers to `ModuleInfo.meta` of both environments, so we also
        // need to merge it here
        if (key === 'meta') {
          const meta: Record<string, any> = {}
          if (ssrModuleInfo) {
            Object.assign(meta, ssrModuleInfo.meta)
          }
          if (clientModuleInfo) {
            Object.assign(meta, clientModuleInfo.meta)
          }
          return meta
        }
        if (clientModuleInfo) {
          if (key in clientModuleInfo) {
            return clientModuleInfo[key as keyof ModuleInfo]
          }
        }
        if (ssrModuleInfo) {
          if (key in ssrModuleInfo) {
            return ssrModuleInfo[key as keyof ModuleInfo]
          }
        }
      },
    })
  }

  get options(): InputOptions {
    return (this.environments.client as DevEnvironment).pluginContainer.options
  }

  // For backward compatibility, buildStart and watchChange are called only for the client environment
  // buildStart is called per environment for a plugin with the perEnvironmentStartEndDuringDev flag
  // watchChange is called per environment for a plugin with the perEnvironmentWatchChangeDuringDev flag

  async buildStart(_options?: InputOptions): Promise<void> {
    return (
      this.environments.client as DevEnvironment
    ).pluginContainer.buildStart(_options)
  }

  async watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void> {
    return (
      this.environments.client as DevEnvironment
    ).pluginContainer.watchChange(id, change)
  }

  // 兼容层的 resolveId：直接转发到对应 environment 的容器（按 options.ssr 选环境）。
  async resolveId(
    rawId: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      /** @deprecated use `skipCalls` instead */
      skip?: Set<Plugin>
      skipCalls?: readonly SkipInformation[]
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null> {
    return this._getPluginContainer(options).resolveId(rawId, importer, options)
  }

  async load(
    id: string,
    options?: {
      ssr?: boolean
    },
  ): Promise<LoadResult | null> {
    return this._getPluginContainer(options).load(id)
  }

  async transform(
    code: string,
    id: string,
    options?: {
      ssr?: boolean
      environment?: Environment
      inMap?: SourceDescription['map']
    },
  ): Promise<{ code: string; map: SourceMap | { mappings: '' } | null }> {
    return this._getPluginContainer(options).transform(code, id, options)
  }

  async close(): Promise<void> {
    // noop, close will be called for each environment
  }
}

/**
 * server.pluginContainer compatibility
 *
 * The default environment is in buildStart, buildEnd, watchChange, and closeBundle hooks,
 * which are called once for all environments, or when no environment is passed in other hooks.
 * The ssrEnvironment is needed for backward compatibility when the ssr flag is passed without
 * an environment. The defaultEnvironment in the main pluginContainer in the server should be
 * the client environment for backward compatibility.
 **/
export function createPluginContainer(
  environments: Record<string, Environment>,
): PluginContainer {
  return new PluginContainer(environments)
}

export type { PluginContainer }
