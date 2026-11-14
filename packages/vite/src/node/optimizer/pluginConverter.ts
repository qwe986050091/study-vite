// ---------------------------------------------------------------------------
// 文件角色：esbuild 插件 → rolldown 插件的「兼容翻译层」。
// 为什么还存在：Vite 8 的内核已换成 rolldown，但用户的 vite.config 里可能仍写着
//   `optimizeDeps.esbuildOptions.plugins: [someEsbuildPlugin]`（生态里大量插件只发布 esbuild 形态）。
//   为了不直接报错，config.ts 的 applyDepOptimizationOptionCompat() 会把这些插件
//   逐个交给本文件转换后塞进 optimizeDeps.rolldownOptions.plugins。
// 上游：config.ts 的 applyDepOptimizationOptionCompat()（resolveConfig 阶段，仅一次）。
// 下游：转换结果由 optimizer/scan.ts 与 optimizer/index.ts 的 rolldown 构建消费。
// 核心映射：
//   esbuild onResolve  → rolldown resolveId
//   esbuild onLoad     → rolldown load
//   esbuild onStart    → rolldown buildStart
//   esbuild onEnd      → rolldown generateBundle
//   esbuild onDispose  → rolldown closeBundle / closeWatcher
// 核心难点：两个 API 的 namespace 语义不同（见 idToPathAndNamespace）。
// 明确不可用：build.resolve、build.esbuild（transform API）、完整 initialOptions、
//   metafile/mangleCache/outputFiles、warnings 与 watchDirs —— 见下方各处抛错。
// ---------------------------------------------------------------------------
import { dirname } from 'node:path'
import type * as esbuild from 'esbuild'
import type {
  ImportKind,
  LoadResult,
  PartialResolvedId,
  PluginContext,
  ResolveIdResult,
  Plugin as RolldownPlugin,
  RolldownPluginOption,
} from 'rolldown'

// esbuild 的钩子允许返回 Promise，rolldown 同样允许，所以这里的联合类型只是「桥」，
// 不做任何调度改写 —— 真正的时序差异在钩子映射层面处理。
type MaybePromise<T> = T | Promise<T>
type EsbuildOnResolveCallback = (
  args: esbuild.OnResolveArgs,
) => MaybePromise<esbuild.OnResolveResult | null | undefined>
type EsbuildOnLoadCallback = (
  args: esbuild.OnLoadArgs,
) => MaybePromise<esbuild.OnLoadResult | null | undefined>
// rolldown 的 resolveId 允许返回 `{ namespace }`，但 esbuild 的 namespace 是
// 「id 前缀 + 独立字段」的双轨制，因此这个局部类型额外声明了 namespace。
// opts.kind 是 rolldown 的 ImportKind，需要在 createResolveIdHandler 里翻译成 esbuild 的 kind。
type ResolveIdHandler = (
  this: PluginContext,
  id: string,
  importer: string | undefined,
  opts: { kind: ImportKind },
) => MaybePromise<
  | (PartialResolvedId & { namespace?: string })
  | Exclude<ResolveIdResult, PartialResolvedId>
>
type LoadHandler = (this: PluginContext, id: string) => MaybePromise<LoadResult>

// 作用：把一个用户提供的 esbuild 插件对象「包装」成一个 rolldown 插件对象。
// 调用点：config.ts 的 applyDepOptimizationOptionCompat()，只处理
//       optimizeDeps.esbuildOptions.plugins（build.esbuild 的插件不在此列）。
// 关键参数：esbuildPlugin 只需含 { name, setup }；
//       其余字段（如 esbuild 原生的 build 配置）都不会被读取。
// 失败模式：
//   - 插件 setup 抛错 → options/buildStart 钩子 reject，整次预打包失败；
//   - 插件用到未实现能力（build.resolve / build.esbuild / warnings / watchDirs）→ 抛
//     'Not implemented'，这是有意为之：宁可显式失败，也不要静默产生错误结果。
export function convertEsbuildPluginToRolldownPlugin(
  esbuildPlugin: esbuild.Plugin,
): RolldownPlugin {
  // esbuild 的回调先收集、后统一分发；三者分别对应不同 rolldown 钩子（见下）。
  const onStartCallbacks: Array<() => void> = []
  const onEndCallbacks: Array<(buildResult: esbuild.BuildResult) => void> = []
  const onDisposeCallbacks: Array<() => void> = []
  // 注意：这两个数组是延迟赋值的（setup 里才 map）。
  // 若在 setup 完成前就调用 resolveId/load，会因 undefined 而抛 TypeError；
  // 正常路径下 rolldown 保证 buildStart（内含 setup）先于二者。
  let resolveIdHandlers: ResolveIdHandler[]
  let loadHandlers: LoadHandler[]

  // setup 只能执行一次：options 钩子（正常 build）与 buildStart（scanner 路径）都可能触发，
  // 用这个标志防止插件被 setup 两遍（否则 onStart/onEnd 回调会重复注册）。
  let isSetupDone = false
  const setup = async (
    plugins: RolldownPluginOption[],
    platform: 'browser' | 'node' | 'neutral',
  ) => {
    const onResolveCallbacks: Array<
      [options: esbuild.OnResolveOptions, callback: EsbuildOnResolveCallback]
    > = []
    const onLoadCallbacks: Array<
      [options: esbuild.OnLoadOptions, callback: EsbuildOnLoadCallback]
    > = []

    // 伪造成 esbuild 的 PluginBuild，让用户的 setup(build) 能跑通。
    // initialOptions 用 Proxy 只放行 platform 与 plugins 的 name 列表，
    // 其余字段一律抛 'Not implemented' —— 避免插件「以为」自己拿到了真实 esbuild 配置。
    const pluginBuild: esbuild.PluginBuild = {
      initialOptions: new Proxy(
        {
          platform,
          // esbuild 插件常通过 initialOptions.plugins 检查同批插件名；这里只投影 name，
          // setup 用空函数，因为真正的插件实例并不在 esbuild 体系里。
          plugins:
            plugins?.flatMap((p) =>
              p && 'name' in p
                ? [
                    {
                      name: p.name,
                      // eslint-disable-next-line @typescript-eslint/no-empty-function
                      setup() {},
                    },
                  ]
                : [],
            ) ?? [],
        },
        {
          get(target, p, _receiver) {
            if (p in target) return (target as any)[p]
            throw new Error('Not implemented')
          },
        },
      ) as esbuild.BuildOptions,
      // esbuild 的 build.resolve 是「主动再解析一次」，rolldown 插件上下文没有等价物；
      // 用 this.resolve 也无法完全对齐 esbuild 的语义（namespace/pluginData），故直接拒绝。
      resolve() {
        throw new Error('Not implemented')
      },
      onStart(callback) {
        onStartCallbacks.push(callback)
      },
      onEnd(callback) {
        onEndCallbacks.push(callback)
      },
      onResolve(options, callback) {
        onResolveCallbacks.push([options, callback])
      },
      onLoad(options, callback) {
        onLoadCallbacks.push([options, callback])
      },
      onDispose(callback) {
        onDisposeCallbacks.push(callback)
      },
      // esbuild 的 transform 服务（build.esbuild.transform）依赖 esbuild 单例，
      // rolldown 侧由 oxc 承担，没有可透传的等价物。
      get esbuild(): esbuild.PluginBuild['esbuild'] {
        throw new Error('Not implemented')
      },
      set esbuild(_: unknown) {
        throw new Error('Not implemented')
      },
    }

    await esbuildPlugin.setup(pluginBuild)

    // 到这里才把「esbuild 回调表」编译成「rolldown 处理器表」。
    // 顺序保持注册顺序，与 esbuild 的语义一致（先注册先命中）。
    resolveIdHandlers = onResolveCallbacks.map(([options, callback]) =>
      createResolveIdHandler(options, callback),
    )
    loadHandlers = onLoadCallbacks.map(([options, callback]) =>
      createLoadHandler(options, callback),
    )
    isSetupDone = true
  }

  // 记录插件曾经返回过的 namespace。用途见 resolveId 末尾的「命名空间回退解析」。
  const usedNamespaces = new Set<string>()
  return {
    name: esbuildPlugin.name,
    // options 钩子是 rolldown 的「最早」时机，能拿到完整 inputOptions（含其它插件）。
    // esbuild 的 setup 恰好也要求能看到同批插件，所以放在这里最贴近语义。
    async options(inputOptions) {
      await setup(
        inputOptions.plugins as RolldownPluginOption[],
        inputOptions.platform ?? 'node',
      )
    },
    async buildStart(inputOptions) {
      // options hook is not called for scanner
      // rolldown 的 scan() 不触发 options 钩子，只从 buildStart 开始，
      // 因此扫描场景下要在这里补一次 setup。
      if (!isSetupDone) {
        // inputOptions.plugins is not available for buildStart hook
        // put a dummy plugin to tell that this is a scan
        // buildStart 拿不到插件列表，initialOptions.plugins 只能给个占位名；
        // 依赖「同批插件名」的 esbuild 插件在扫描路径下会看到这个假值。
        await setup(
          [{ name: 'vite:dep-scan' }],
          inputOptions.platform ?? 'node',
        )
      }

      // esbuild 的 onStart 在「构建开始」触发，rolldown 用 buildStart 承接。
      // 注意 esbuild 的 onStart 可以返回 { errors, warnings } 影响构建，这里直接丢弃返回值。
      for (const cb of onStartCallbacks) {
        cb()
      }
    },
    // esbuild 的 onEnd 在「构建结束、产物已生成」时触发，rolldown 最接近的是 generateBundle。
    // 只在构建成功时才会走到这里 —— 构建失败时 onEnd 不会收到 errors，这是与 esbuild 的差异。
    generateBundle(_outputOpts, _bundle, isWrite) {
      // 构造一个「最小可用」的 BuildResult：
      // metafile/mangleCache 恒为 undefined；outputFiles 仅在写盘模式（isWrite）下出现，
      // 且值本身也是 undefined，因为 rolldown 不提供等价的产物内存表。
      const buildResult = new Proxy(
        {
          metafile: undefined,
          mangleCache: undefined,
          ...(isWrite ? { outputFiles: undefined } : {}),
        } as esbuild.BuildResult,
        {
          // 访问未声明字段直接抛错，防止插件静默拿到 undefined 后写出错误逻辑。
          get(_target, prop) {
            if (prop in _target || typeof prop === 'symbol') {
              return (_target as any)[prop]
            }
            throw new Error('Not implemented property: ' + prop)
          },
        },
      )
      for (const cb of onEndCallbacks) {
        cb(buildResult)
      }
    },
    async resolveId(id, importer, opts) {
      // 与 esbuild 一致：按注册顺序逐个尝试，第一个返回非空结果的处理器获胜。
      for (const handler of resolveIdHandlers) {
        const result = await handler.call(this, id, importer, opts)
        if (result) {
          // 只有「返回了 namespace 字符串」的才登记；非字符串（如 true）不登记。
          if (typeof result === 'object' && result.namespace) {
            usedNamespaces.add(result.namespace)
          }
          return result
        }
      }
      // 命名空间回退：rolldown 侧 id 已被编码成 `ns:path`。
      // 如果 importer 属于本插件产出过的 namespace，而本插件的 onResolve 全都没命中，
      // 说明这条 import 是在「插件自己的虚拟模块」里发出的；
      // 此时剥掉 namespace 前缀再让 rolldown 走常规解析，否则相对路径会基于错误的 id 计算。
      if (usedNamespaces.size) {
        const [importerWithoutNamespace, namespaceFromImporter] =
          idToPathAndNamespace(importer)
        if (usedNamespaces.has(namespaceFromImporter)) {
          return await this.resolve(id, importerWithoutNamespace, opts)
        }
      }
    },
    async load(id) {
      // 同 resolveId：按顺序尝试，第一个有返回值的处理器获胜。
      // 未命中时返回 undefined，交给 rolldown 的默认文件加载逻辑。
      for (const handler of loadHandlers) {
        const result = await handler.call(this, id)
        if (result) {
          return result
        }
      }
    },
    // esbuild 的 onDispose 在「每次 build 结束、插件被销毁」时触发。
    // 非 watch 模式下 rolldown 的 closeBundle 是唯一可靠时机；
    // watch 模式下 closeBundle 也会在每次重建后触发，若在此 dispose 会让下一次重建失效，
    // 所以这里用 !watchMode 排除掉，交给 closeWatcher。
    closeBundle() {
      if (!this.meta.watchMode) {
        for (const cb of onDisposeCallbacks) {
          cb()
        }
      }
    },
    // rolldown 的 watcher 真正关闭时触发，对应 esbuild 的 onDispose 语义。
    closeWatcher() {
      for (const cb of onDisposeCallbacks) {
        cb()
      }
    },
  }
}

// 作用：把一个 esbuild onResolve 的 (options, callback) 对翻译成 rolldown 的 resolveId。
// 调用点：本文件 setup() 内，转换阶段一次性创建。
// 关键参数：options.namespace 是「importer 的 namespace 过滤器」，options.filter 是 id 前缀过滤。
// 失败模式：callback 返回 warnings/watchDirs 或没有 path → 抛 'not implemented'；
//       callback 返回 errors → 聚合后抛出，中断构建。
function createResolveIdHandler(
  options: esbuild.OnResolveOptions,
  callback: EsbuildOnResolveCallback,
): ResolveIdHandler {
  return async function (id, importer, opts) {
    // rolldown 的 importer 形如 `ns:path`，esbuild 的 args.importer 只要路径部分。
    // 注意此处解析依赖 idToPathAndNamespace 的「第一个冒号」规则（见函数尾注释）。
    const [importerWithoutNamespace, importerNamespace] =
      idToPathAndNamespace(importer)
    // esbuild 的 namespace 过滤语义：不填表示「任意 namespace」；
    // 填了则只在 importer 属于该 namespace 时命中。
    if (
      options.namespace !== undefined &&
      options.namespace !== importerNamespace
    ) {
      return
    }
    if (options.filter !== undefined && !options.filter.test(id)) {
      return
    }

    const result = await callback({
      path: id,
      // esbuild 约定：入口没有 importer，用空字符串表示（而不是 undefined）。
      importer: importerWithoutNamespace ?? '',
      namespace: importerNamespace,
      // esbuild 的 resolveDir 是「相对导入的基准目录」，对应 importer 的 dirname；
      // 没有 importer 时给 ''，esbuild 插件通常用 path.resolve('') 的兜底行为。
      resolveDir: dirname(importerWithoutNamespace ?? ''),
      // kind 需要翻译：rolldown 没有 'new-url'/'hot-accept' 这两个概念，
      // 它们本质都是「动态导入」，统一映射成 dynamic-import；
      // 没有 importer 时一律视为 entry-point。
      kind:
        importerWithoutNamespace === undefined
          ? 'entry-point'
          : opts.kind === 'new-url' || opts.kind === 'hot-accept'
            ? 'dynamic-import'
            : opts.kind,
      // 这两个字段在 rolldown 上下文里没有对应物，给空对象而不是 undefined，
      // 避免 esbuild 插件直接读属性时崩溃。
      pluginData: {},
      with: {},
    })
    if (!result) return
    // esbuild 的 errors 是「结构化错误数组」，rolldown 只认抛出的异常，故聚合成 AggregateError。
    if (result.errors && result.errors.length > 0) {
      throw new AggregateError(result.errors)
    }
    // 以下三种能力 rolldown 插件无法表达：
    //   warnings  —— 没有等价的 warning 收集通道；
    //   watchDirs —— rolldown 只有 addWatchFile（文件级），不支持目录级监听；
    //   空 path   —— esbuild 允许「只 external 不返回路径」的写法，rolldown 不行。
    if (
      (result.warnings && result.warnings.length > 0) ||
      (result.watchDirs && result.watchDirs.length > 0) ||
      !result.path
    ) {
      throw new Error('not implemented')
    }
    // watchFiles 有等价能力，直接登记到 rolldown 的 watch 列表。
    for (const file of result.watchFiles ?? []) {
      this.addWatchFile(file)
    }

    // namespace 双写：rolldown 的 id 用 `ns:path` 编码，同时再单独给一个 namespace 字段。
    // 这样本插件的 load 可以通过 id 前缀还原 namespace，其它插件也能读到 namespace。
    return {
      id: result.namespace ? `${result.namespace}:${result.path}` : result.path,
      external: result.external,
      moduleSideEffects: result.sideEffects,
      namespace: result.namespace,
    }
  }
}

// 作用：把 esbuild 的 onLoad 翻译成 rolldown 的 load。
// 调用点：本文件 setup() 内。
// 关键参数：options.namespace 默认是 'file'（esbuild 的文件系统命名空间）。
// 失败模式：contents 为 null / 返回 warnings / watchDirs → 抛 'not implemented'；
//       errors 非空 → AggregateError。
function createLoadHandler(
  options: esbuild.OnLoadOptions,
  callback: EsbuildOnLoadCallback,
): LoadHandler {
  // esbuild 的 contents 允许 Uint8Array；rolldown 的 load 只接受字符串，故统一解码。
  // 复用一个 decoder 实例是为了避免每个模块都新建对象。
  const textDecoder = new TextDecoder()
  return async function (id) {
    const [idWithoutNamespace, idNamespace] = idToPathAndNamespace(id)
    // esbuild 里 onLoad 不写 namespace 等价于 namespace: 'file'，
    // 所以既接受 'file' 也接受与本 id 实际 namespace 相同的过滤条件。
    if (
      options.namespace !== undefined &&
      options.namespace !== 'file' &&
      options.namespace !== idNamespace
    ) {
      return
    }
    if (options.filter !== undefined && !options.filter.test(id)) {
      return
    }

    const result = await callback.call(this, {
      path: idWithoutNamespace,
      namespace: idNamespace,
      // esbuild 的 suffix 指 `?query` 部分；rolldown 把 query 视作 id 的一部分，
      // 这里硬编码 ''，意味着插件看不到 query —— 属于已知的能力缺失。
      suffix: '',
      pluginData: {},
      with: {},
    })
    if (!result) return
    if (result.errors && result.errors.length > 0) {
      throw new AggregateError(result.errors)
    }
    // 与 resolve 侧同理，warnings/watchDirs 不可表达；
    // 额外的 contents == null 表示「没有内容可加载」，rolldown 的 load 返回空对象会
    // 被当成「未处理」从而继续 fallback，语义会变，所以这里直接判为不支持。
    if (
      (result.warnings && result.warnings.length > 0) ||
      (result.watchDirs && result.watchDirs.length > 0) ||
      result.contents == null
    ) {
      throw new Error('not implemented')
    }
    for (const file of result.watchFiles ?? []) {
      this.addWatchFile(file)
    }

    // loader 直接映射成 rolldown 的 moduleType（js/ts/jsx/tsx/css/...），
    // 不做校验：非法值由 rolldown 在解析阶段报错。
    return {
      code:
        typeof result.contents === 'string'
          ? result.contents
          : textDecoder.decode(result.contents),
      moduleType: result.loader,
    }
  }
}

// 作用：在「rolldown 的 `ns:path` 编码」与「esbuild 的 (path, namespace) 二元组」之间互转。
// 调用点：本文件 convertEsbuildPluginToRolldownPlugin().resolveId、
//       createResolveIdHandler()、createLoadHandler()。
// 关键参数：id 为 undefined 时视作 esbuild 的默认命名空间 'file'。
// 规则：按「第一个冒号」切分 —— 前缀是 namespace，其余全是 path。
// 失败模式（已知局限）：Windows 绝对路径形如 `C:\foo`，会被切成 namespace='C'、
//       path='\foo'。Vite 内部 id 通常已 normalize 成 `C:/foo`，依然会命中这条规则；
//       这是本转换层的固有近似，遇到时只能靠调用方保证 id 形如 `file:C:/foo` 或纯 POSIX 路径。
function idToPathAndNamespace(id: string): [path: string, namespace: string]
function idToPathAndNamespace(
  id: string | undefined,
): [path: string | undefined, namespace: string]
function idToPathAndNamespace(
  id: string | undefined,
): [path: string | undefined, namespace: string] {
  if (id === undefined) return [undefined, 'file']

  const namespaceIndex = id.indexOf(':')
  if (namespaceIndex >= 0) {
    return [id.slice(namespaceIndex + 1), id.slice(0, namespaceIndex)]
  } else {
    // 没有冒号：esbuild 语义下这就是 file 命名空间里的普通路径。
    return [id, 'file']
  }
}
