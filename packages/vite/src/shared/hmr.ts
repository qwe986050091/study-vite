// 文件角色：HMR 的「两端共用」实现——浏览器（client/client.ts）与 ModuleRunner（SSR）都 new 这里的
//   HMRClient / HMRContext，只是注入的 logger、transport、importUpdatedModule 不同。
// 引用方（Grep 确认）：
//   - client/client.ts：new HMRClient(...)、new HMRContext(hmrClient, moduleUrl)
//   - module-runner/runner.ts：同样两处，importUpdatedModule = runner.import
//   - shared/bundledDevHmr.ts：复用 HMRClient 的 map 与 HMRContext 的 accept 语义
//   - module-runner/hmrLogger.ts、types.ts、index.ts：只 import type HMRLogger（纯类型消费）
// 纯类型：CustomListenersMap、HotModule、HotCallback、HMRLogger（interface）。
// 运行时代码：HMRContext、HMRClient 两个 class——它们持有状态（Map），不是无状态工具。
// 关键不变量：
//   1. 所有 map 的 key 都是模块 URL（ownerPath / acceptedPath / path 同域）；
//   2. accept 回调挂在“边界模块”上，而不是被接受模块上（见 acceptDeps 用 ownerPath 作 key）；
//   3. fetchUpdate 先取合格回调、再 import、最后才执行回调，保证新模块已求值。
// 容易误解：本文件不做依赖图分析。accept 边界由 node/server/hmr.ts 的 updateModules / propagateUpdate
//   算好后以 Update[] 下发；这里只负责“按服务端给的 path / acceptedPath 执行”。
import type { InferCustomEventPayload } from '#types/customEvent'
import type { HotPayload, Update } from '#types/hmrPayload'
import type { ModuleNamespace, ViteHotContext } from '#types/hot'
import type { NormalizedModuleRunnerTransport } from './moduleRunnerTransport'

// event -> 监听器数组。这里存的数组会被 HMRContext.newListeners 按引用共享，
// 所以清理陈旧监听时必须 filter 出新数组再 set 回去（不能原地 splice，否则会改到别人的快照）。
type CustomListenersMap = Map<string, ((data: any) => void)[]>

// 一个模块可以被多次 accept：callbacks 是该模块声明的所有边界集合。
interface HotModule {
  id: string
  callbacks: HotCallback[]
}

interface HotCallback {
  // the dependencies must be fetchable paths
  // deps 是「可以被 fetch 的模块 URL」，必须与 Update.acceptedPath 精确相等才会命中；
  // exports 只服务 acceptExports，运行时匹配不做部分判断（部分接受在服务端算）。
  deps: string[]
  fn: (modules: Array<ModuleNamespace | undefined>) => void
  exports?: readonly string[]
}

// 两端各自实现：浏览器传 console 包装（client.ts），runner 传 module-runner/hmrLogger.ts。
// 只有 error / debug 两个级别，是为了让 SSR 端能把日志整体静音（silentConsole）。
export interface HMRLogger {
  error(msg: string | Error): void
  debug(...msg: unknown[]): void
}

// 作用：每个模块一份的 import.meta.hot 门面，把用户调用转成对共享 HMRClient 状态的读写。
// 创建点：client.ts 的 createHotContext -> new HMRContext；runner.ts 的 createModuleHotContext 同理。
// 关键参数：ownerPath 是这个模块自己的 URL，所有注册都以它为 key。
// 失败模式：没有“销毁”方法；模块被再次求值时靠构造函数里的重置逻辑清掉旧状态。
export class HMRContext implements ViteHotContext {
  private newListeners: CustomListenersMap

  constructor(
    private hmrClient: HMRClient,
    private ownerPath: string,
  ) {
    // 保证 data 一定存在：即使模块从未访问 hot.data，dispose/prune 回调也能拿到一个对象。
    if (!hmrClient.dataMap.has(ownerPath)) {
      hmrClient.dataMap.set(ownerPath, {})
    }

    // when a file is hot updated, a new context is created
    // clear its stale callbacks
    // 顺序敏感：先清 accept 回调，再清自定义监听，最后装新的 newListeners。
    // 清监听时必须从 ctxToListenersMap 找回“上一轮该模块注册过哪些函数”逐个移除，
    // 因为 customListenersMap 是全局按 event 聚合的，整表清空会误删别的模块的监听。
    const mod = hmrClient.hotModulesMap.get(ownerPath)
    if (mod) {
      mod.callbacks = []
    }

    // clear stale custom event listeners
    const staleListeners = hmrClient.ctxToListenersMap.get(ownerPath)
    if (staleListeners) {
      for (const [event, staleFns] of staleListeners) {
        const listeners = hmrClient.customListenersMap.get(event)
        if (listeners) {
          hmrClient.customListenersMap.set(
            event,
            listeners.filter((l) => !staleFns.includes(l)),
          )
        }
      }
    }

    this.newListeners = new Map()
    // newListeners 记录“本轮注册”，供下一次构造时精确清理；ctxToListenersMap 保存它。
    hmrClient.ctxToListenersMap.set(ownerPath, this.newListeners)
  }

  get data(): any {
    // 返回同一对象引用：dispose 里写入的 data 会被下一次 accept 的新模块读到，这是跨版本传状态的唯一通道。
    return this.hmrClient.dataMap.get(this.ownerPath)
  }

  // 作用：注册 HMR 边界。调用点：用户代码里的 import.meta.hot.accept(...)（类型见 types/hot.d.ts）。
  // 三种形态：无参/函数 = 自接受；字符串 = 接受单个依赖；数组 = 接受多个依赖。
  // 失败模式：其他形态直接抛错——这种误用历史上很难排查，所以选择立即失败。
  accept(deps?: any, callback?: any): void {
    if (typeof deps === 'function' || !deps) {
      // self-accept: hot.accept(() => {})
      // 自接受：把 ownerPath 同时当作 deps 与 acceptedPath，对应 Update.isSelfUpdate。
      this.acceptDeps([this.ownerPath], ([mod]) => deps?.(mod))
    } else if (typeof deps === 'string') {
      // explicit deps
      // 单依赖：callback 拿到的是“该依赖的新模块”，不是自己。
      this.acceptDeps([deps], ([mod]) => callback?.(mod))
    } else if (Array.isArray(deps)) {
      // 数组形态：callback 的签名是 mods 数组，未命中/加载失败的槽位是 undefined。
      this.acceptDeps(deps, callback)
    } else {
      throw new Error(`invalid hot.accept() usage.`)
    }
  }

  // 作用：部分接受——只声明自己接受哪些导出变化，其余导出变化继续向上传播。
  // 调用点：用户代码 import.meta.hot.acceptExports(...)；匹配逻辑在 node/server/hmr.ts 的 areAllImportsAccepted。
  // 注意：deps 仍是 [ownerPath]（自接受），exports 只是给服务端做传播裁剪的元数据。
  acceptExports(
    exportNames: string | readonly string[],
    callback?: (data: any) => void,
  ): void {
    this.acceptDeps(
      [this.ownerPath],
      ([mod]) => callback?.(mod),
      typeof exportNames === 'string' ? [exportNames] : exportNames,
    )
  }

  // 作用：模块被替换/移除前执行清理，参数是 hot.data（同一模块跨版本共享）。
  // 调用点：fetchUpdate 在 import 新模块之前调用；prunePaths 在 prune 阶段也会调用一次。
  // 覆盖语义：同一个模块只有一个 disposer，后注册的会覆盖先注册的。
  dispose(cb: (data: any) => void): void {
    this.hmrClient.disposeMap.set(this.ownerPath, cb)
  }

  // 作用：模块彻底不在图上时清理其副作用（如移除注入的 <style>）。
  // 调用点：user 代码 import.meta.hot.prune(...)；由 prunePaths 统一执行。
  // 与 dispose 的区别：dispose 每次更新都跑，prune 只在被剪枝时跑。
  prune(cb: (data: any) => void): void {
    this.hmrClient.pruneMap.set(this.ownerPath, cb)
  }

  // Kept for backward compatibility (#11036)
  // 历史 API，现在什么都不做：真正的“拒绝更新”由服务端传播时判定（无边界 -> full reload）。
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  decline(): void {}

  // 作用：主动让自己失效，请求服务端重新传播这次更新。
  // 调用点：用户代码 import.meta.hot.invalidate(msg)。
  // firstInvalidatedBy 语义：第一个发起 invalidate 的模块 URL 会随事件一路回传，
  //   服务端 updateModules 用它检测“互相 invalidate”的死循环并退化成 full reload。
  invalidate(message: string): void {
    const firstInvalidatedBy =
      this.hmrClient.currentFirstInvalidatedBy ?? this.ownerPath
    this.hmrClient.notifyListeners('vite:invalidate', {
      path: this.ownerPath,
      message,
      firstInvalidatedBy,
    })
    // 本地先广播（同页其他监听者能立刻感知），再把同样的 payload 发给服务端触发重新传播；
    // 两处必须一起发，只发服务端会让本地监听者错过事件。
    this.send('vite:invalidate', {
      path: this.ownerPath,
      message,
      firstInvalidatedBy,
    })
    this.hmrClient.logger.debug(
      `invalidate ${this.ownerPath}${message ? `: ${message}` : ''}`,
    )
  }

  on<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    // 双写：全局表供 notifyListeners 分发，newListeners 供下次构造时精确清理。
    const addToMap = (map: Map<string, any[]>) => {
      const existing = map.get(event) || []
      existing.push(cb)
      map.set(event, existing)
    }
    addToMap(this.hmrClient.customListenersMap)
    addToMap(this.newListeners)
  }

  off<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    // 从两张表都移除；数组空时删 key，避免 customListenersMap 无限增长。
    const removeFromMap = (map: Map<string, any[]>) => {
      const existing = map.get(event)
      if (existing === undefined) {
        return
      }
      const pruned = existing.filter((l) => l !== cb)
      if (pruned.length === 0) {
        map.delete(event)
        return
      }
      map.set(event, pruned)
    }
    removeFromMap(this.hmrClient.customListenersMap)
    removeFromMap(this.newListeners)
  }

  // 统一包成 custom 事件发给服务端；断线错误由 HMRClient.send 统一记日志，这里不处理。
  send<T extends string>(event: T, data?: InferCustomEventPayload<T>): void {
    this.hmrClient.send({ type: 'custom', event, data })
  }

  private acceptDeps(
    deps: string[],
    callback: HotCallback['fn'] = () => {},
    exports?: readonly string[],
  ): void {
    // 真正的注册点：key 是 ownerPath（边界模块），deps 是它声明接受的模块。
    // 同一模块多次 accept 会 push 多条 callback，fetchUpdate 时按 deps 过滤。
    const mod: HotModule = this.hmrClient.hotModulesMap.get(this.ownerPath) || {
      id: this.ownerPath,
      callbacks: [],
    }
    mod.callbacks.push({
      deps,
      fn: callback,
      exports,
    })
    this.hmrClient.hotModulesMap.set(this.ownerPath, mod)
  }
}

// 作用：一台「热更新状态机」，持有所有模块的 accept/dispose/prune/data/监听状态，并负责执行更新。
// 实例化点：client/client.ts（浏览器）、module-runner/runner.ts（SSR）、shared/bundledDevHmr.ts（继承复用）。
// 隔离性：浏览器与 SSR 各一份，互不影响；同一实例内所有 URL 必须属于同一命名空间。
export class HMRClient {
  // hotModulesMap：边界模块 URL -> 它声明的所有 accept 回调。
  public hotModulesMap: Map<string, HotModule> = new Map()
  // disposeMap / pruneMap：模块 URL -> 清理函数；dataMap：模块 URL -> hot.data。
  public disposeMap: Map<string, (data: any) => void | Promise<void>> =
    new Map()
  public pruneMap: Map<string, (data: any) => void | Promise<void>> = new Map()
  public dataMap: Map<string, any> = new Map()
  // customListenersMap 按 event 聚合；ctxToListenersMap 按模块记录“本轮注册了哪些”，
  // 两者配合实现“只清理本模块的陈旧监听”。
  public customListenersMap: CustomListenersMap = new Map()
  public ctxToListenersMap: Map<string, CustomListenersMap> = new Map()
  // currentFirstInvalidatedBy 是「当前正在应用的那次更新」的传播起点：
  // 只在执行 accept 回调的瞬间有值，供用户侧 invalidate 时续接链路。
  public currentFirstInvalidatedBy: string | undefined

  constructor(
    public logger: HMRLogger,
    private transport: NormalizedModuleRunnerTransport,
    // This allows implementing reloading via different methods depending on the environment
    // 浏览器传动态 import()，runner 传 runner.import；这是两端唯一的执行差异。
    private importUpdatedModule: (update: Update) => Promise<ModuleNamespace>,
  ) {}

  // 作用：把事件广播给所有监听者。
  // 调用点：client.ts / module-runner/hmrHandler.ts 在每种 payload 前后调用（vite:beforeUpdate 等）。
  // 失败模式：用 allSettled——一个监听器抛错不能影响其他监听器，也不能阻断更新流程。
  public async notifyListeners<T extends string>(
    event: T,
    data: InferCustomEventPayload<T>,
  ): Promise<void>
  public async notifyListeners(event: string, data: any): Promise<void> {
    const cbs = this.customListenersMap.get(event)
    if (cbs) {
      await Promise.allSettled(cbs.map((cb) => cb(data)))
    }
  }

  public send(payload: HotPayload): void {
    // transport.send 返回 Promise；统一 catch 交给 logger，避免 unhandledRejection。
    // 断线期间 send 会 reject（SendBeforeConnectError 或 socket 已关闭），只记日志、不重试。
    this.transport.send(payload).catch((err) => {
      this.logger.error(err)
    })
  }

  public clear(): void {
    // 全量重置，只应由“整页重载 / runner 重置”这类语义调用；单独清某个模块请用 prunePaths。
    this.hotModulesMap.clear()
    this.disposeMap.clear()
    this.pruneMap.clear()
    this.dataMap.clear()
    this.customListenersMap.clear()
    this.ctxToListenersMap.clear()
  }

  // After an HMR update, some modules are no longer imported on the page
  // but they may have left behind side effects that need to be cleaned up
  // (e.g. style injections)
  // 作用：对一批被剪枝的模块依次执行 dispose 和 prune 回调。
  // 调用点：client.ts 的 handleMessage('prune')、module-runner/hmrHandler.ts 的 'prune' 分支。
  // 顺序：先全部 dispose、再全部 prune（两轮 Promise.all），因为 dispose 可能还要读其他模块的 data。
  // 失败模式：finally 里删 data——无论回调是否抛错，剪枝后都不该再保留状态，避免内存泄漏。
  public async prunePaths(paths: string[]): Promise<void> {
    try {
      await Promise.all(
        paths.map((path) => {
          const disposer = this.disposeMap.get(path)
          if (disposer) return disposer(this.dataMap.get(path))
        }),
      )
      await Promise.all(
        paths.map((path) => {
          const fn = this.pruneMap.get(path)
          if (fn) {
            return fn(this.dataMap.get(path))
          }
        }),
      )
    } finally {
      paths.forEach((path) => this.dataMap.delete(path))
    }
  }

  protected warnFailedUpdate(err: Error, path: string | string[]): void {
    // fetch 类错误通常已由浏览器/网络层打印过，重复打反而噪音；其余错误照常输出。
    if (!(err instanceof Error) || !err.message.includes('fetch')) {
      this.logger.error(err)
    }
    // 固定提示“语法错误或 import 了不存在的模块”，这是 HMR 失败最常见的原因。
    this.logger.error(
      `Failed to reload ${path}. ` +
        `This could be due to syntax errors or importing non-existent ` +
        `modules. (see errors above)`,
    )
  }

  private updateQueue: Promise<(() => void) | undefined>[] = []
  private pendingUpdateQueue = false

  /**
   * buffer multiple hot updates triggered by the same src change
   * so that they are invoked in the same order they were sent.
   * (otherwise the order may be inconsistent because of the http request round trip)
   */
  // 作用：把同一轮的多条 update 攒批处理，保证 accept 回调的执行顺序 = 服务端下发顺序。
  // 调用点：client.ts 的 handleMessage('update') 与 module-runner/hmrHandler.ts 的 'update' 分支。
  // 机制：updateQueue 只存 Promise；pendingUpdateQueue 保证同一轮只 flush 一次——
  //   await Promise.resolve() 把 flush 排到微任务队尾，让本轮同步到达的 update 先全部入队。
  // 失败模式：某条 fetch reject 会让 Promise.all 整体 reject，本轮所有回调都不执行（已 import 的模块留在内存）。
  public async queueUpdate(payload: Update): Promise<void> {
    this.updateQueue.push(this.fetchUpdate(payload))
    if (!this.pendingUpdateQueue) {
      this.pendingUpdateQueue = true
      await Promise.resolve()
      this.pendingUpdateQueue = false
      const loading = [...this.updateQueue]
      this.updateQueue = []
      // loading 是快照：flush 期间新来的 update 会进新的队列、下一轮再处理，不会被本轮吞掉。
      ;(await Promise.all(loading)).forEach((fn) => fn && fn())
    }
  }

  // 作用：单条 Update 的完整处理：找边界 -> 取合格回调 -> 跑 disposer -> import 新模块 -> 返回「应用函数」。
  // 调用点：本文件 queueUpdate（浏览器与 runner 共用）。
  // 关键参数：path = 边界模块 URL；acceptedPath = 要重新 import 的模块 URL。
  // 失败模式：没有边界（模块尚未被加载）时静默返回 undefined，交给后续 update 兜底。
  private async fetchUpdate(update: Update): Promise<(() => void) | undefined> {
    const { path, acceptedPath, firstInvalidatedBy } = update
    const mod = this.hotModulesMap.get(path)
    if (!mod) {
      // In a code-splitting project,
      // it is common that the hot-updating module is not loaded yet.
      // https://github.com/vitejs/vite/issues/721
      // 因此这里不是错误：变化发生在尚未加载的 chunk，没有边界可执行，直接忽略。
      return
    }

    let fetchedModule: ModuleNamespace | undefined
    const isSelfUpdate = path === acceptedPath

    // determine the qualified callbacks before we re-import the modules
    // 先算出合格回调再 import：import 会求值新模块，若此时回调集合还在变，可能漏执行或重复执行。
    const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
      deps.includes(acceptedPath),
    )

    if (isSelfUpdate || qualifiedCallbacks.length > 0) {
      // disposer 必须在 import 之前跑：它要清理旧模块留下的副作用（样式、定时器），
      // 且参数是旧模块的 data 对象（之后会被新模块复用同一引用）。
      const disposer = this.disposeMap.get(acceptedPath)
      if (disposer) await disposer(this.dataMap.get(acceptedPath))
      try {
        fetchedModule = await this.importUpdatedModule(update)
      } catch (e) {
        this.warnFailedUpdate(e, acceptedPath)
      }
    }

    return () => {
      // 这个函数是「应用阶段」：必须等同一轮所有 fetch 都完成才由 queueUpdate 调用，
      // 否则会边下载边执行，出现旧模块已 dispose、新模块还没就绪的中间态。
      try {
        this.currentFirstInvalidatedBy = firstInvalidatedBy
        for (const { deps, fn } of qualifiedCallbacks) {
          // deps 中只有等于 acceptedPath 的槽位给新模块，其余传 undefined：
          // 一次 Update 只重新加载一个模块，多依赖 accept 的其他依赖只能拿到 undefined。
          fn(
            deps.map((dep) =>
              dep === acceptedPath ? fetchedModule : undefined,
            ),
          )
        }
        const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`
        this.logger.debug(`hot updated: ${loggedPath}`)
      } finally {
        // 只在回调执行期间可见，防止模块在 accept 回调外调用 invalidate 时误继承上一次的传播起点。
        this.currentFirstInvalidatedBy = undefined
      }
    }
  }
}
