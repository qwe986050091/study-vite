// 文件角色（本文件在链路的哪一段）
// - 位置：dev server 的「模块元数据中枢」。每个 Environment 各持有一份 EnvironmentModuleGraph，
//   由 environment.ts 的构造函数创建（传入 environment 名与 pluginContainer.resolveId）。
// - 上游写入：transformRequest.ts 与 plugins/importAnalysis.ts 在转译、改写 import 之后调用
//   _ensureEntryFromUrl / updateModuleInfo / updateModuleTransformResult，把「谁 import 谁」以及
//   「哪里写了 import.meta.hot.accept」写进图里。
// - 下游读取：server/hmr.ts 的 propagateUpdate 沿 importers 向上找 accept 边界；
//   server/middlewares/transform.ts 用 getModuleByEtag 做 304 命中；server/index.ts 的 watcher 回调
//   先用 onFileChange / onFileDelete 清缓存，再进入 HMR 决策。
// - 关键不变量：url 是浏览器可请求的公开路径（可能带 query），id 是 resolve 后的内部标识，
//   file 是 id 去掉 query 后的磁盘路径；同一个 file 可以对应多个 url/id，所以 fileToModulesMap 的值是 Set。
// - 容易误解：图里并没有为 acceptedHmrDeps 建反向边。accept 只影响 HMR 传播时的剪枝判断，
//   不参与 invalidateModule 的 importer 递归 —— 「A accept B」不会让 A 变成 B 的 importer。
import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rolldown'
import { cleanUrl } from '../../shared/utils'
import { FS_PREFIX } from '../constants'
import { isDirectCSSRequest } from '../plugins/css'
import {
  monotonicDateNow,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from '../utils'
import type { TransformResult } from './transformRequest'

// 图中的一个模块节点。字段分三类：身份（environment/url/id/file/type）、图边
// （importers/importedModules/acceptedHmrDeps/acceptedHmrExports/importedBindings/staticImportedUrls）、
// 缓存与 HMR 状态（transformResult/invalidationState/lastHMRTimestamp 等）。
// 下面每个字段都标注「谁写 / 谁读」，改语义前请先确认这些点，避免只刷新一处。
export class EnvironmentModuleNode {
  // 所属 Environment 名（'client' / 'ssr' / ...）。构造时写；mixedModuleGraph 用它把兼容节点
  // 路由回真实子图，日志与 updateModules 用它区分 client 与 SSR 行为。
  environment: string
  /**
   * Public served url path, starts with /
   */
  url: string
  // 公开 url（以 / 开头，可能带 ?query）。写：_ensureEntryFromUrl 采用 _resolveUrl 的结果，
  // 且 _resolveUrl 会为它补上扩展名。读：HMR payload 的 path/acceptedPath、urlToModuleMap 的键、
  // importAnalysis 判断是否注入 ?t= 时的 moduleUrl 比对、HTML/CSS/asset 插件回写引用 URL。
  /**
   * Resolved file system path + query
   */
  id: string | null = null
  // id 是 resolveId 之后的内部标识（含 query）。初始为 null，只有 _ensureEntryFromUrl 成功后才赋值；
  // 读：getModuleById / idToModuleMap / importedBindings 的键 / transformRequest 计算 etag。
  // file 是 cleanUrl(id)，纯磁盘路径。读：fileToModulesMap 的键、watcher 回调里 getModulesByFile 的入参。
  file: string | null = null
  // 只有三种取值。写：构造函数用 isDirectCSSRequest(url) 决定 js/css；createFileOnlyEntry 改成 'asset'。
  // 读：propagateUpdate 决定 payload 是 js-update 还是 css-update；invalidateModule 用它排除直接 CSS 的
  // soft 失效；updateModules 用它判断 html 是否被当成模块 import 过。
  type: 'js' | 'css' | 'asset'
  // 懒创建的 ModuleInfo，供插件 getModuleInfo 读取。写：pluginContainer.ts 的 getModuleInfo 首次访问时；
  // 本文件不读，也不在失效时清空（它属于处理管线的一部分，见 invalidateModule 内的注释）。
  info?: ModuleInfo
  // resolveId 返回的 meta（插件自定义元数据）。写：_ensureEntryFromUrl；读：pluginContainer 组装 ModuleInfo.meta。
  meta?: Record<string, any>
  // 反向边：谁 import 了我。写：updateModuleInfo 里对每个依赖执行 dep.importers.add(mod)；
  // onFileDelete 里摘除；读：invalidateModule 向上递归、propagateUpdate 向上找 accept 边界、
  // environment.ts 的 invalidateModule 取 importers 作为待更新集合。
  importers: Set<EnvironmentModuleNode> = new Set()

  // 正向边：我 import 了谁（包含 watched/glob 这类非静态依赖）。写：updateModuleInfo 整体替换；
  // 读：onFileDelete 摘反向边、transformRequest 的 soft 失效重写 import 时间戳、mixedModuleGraph 兼容层。
  importedModules: Set<EnvironmentModuleNode> = new Set()

  // import.meta.hot.accept([...]) 声明的被接受依赖。写：updateModuleInfo；读：propagateUpdate 判断
  // importer 是否是边界、invalidateModule 判断要不要跳过 soft 失效。只有 js/css 节点才有实际意义。
  acceptedHmrDeps: Set<EnvironmentModuleNode> = new Set()
  // import.meta.hot.acceptExports([...]) 的部分接受集合（null 表示没写）。写：updateModuleInfo；
  // 读：propagateUpdate —— 它让节点自己成为边界，同时配合 importedBindings 决定能否跳过某个 importer。
  acceptedHmrExports: Set<string> | null = null
  // importer 视角的「我用了被依赖模块的哪些导出」，key 是 dep.id。写：updateModuleInfo（来自 importAnalysis
  // 的静态分析）；读：propagateUpdate 做 acceptExports 的精确匹配。
  importedBindings: Map<string, Set<string>> | null = null
  // 三态：undefined=还没被 importAnalysis 分析过（浏览器没加载过）；false=不能自接受；true=边界。
  // 写：构造函数先置 false，updateModuleInfo 覆盖；读：propagateUpdate 的第一个分支。
  isSelfAccepting?: boolean
  // 转译结果缓存（code/map/etag/ssr）。写：updateModuleTransformResult；失效时被置为 null。
  // 读：维护 etagToModuleMap、transformRequest 的 soft 失效复用、middlewares/transform.ts 的 304 判定。
  transformResult: TransformResult | null = null

  // ssrModule and ssrError are no longer needed. They are on the module runner module cache.
  // Once `ssrLoadModule` is re-implemented on top of the new APIs, we can delete these.
  ssrModule: Record<string, any> | null = null
  ssrError: Error | null = null
  // 这两个字段已废弃：SSR 模块实例与错误现在放在 ModuleRunner 的 evaluatedModules 缓存里（见上面英文注释），
  // 这里只为兼容旧 API 保留；invalidateModule 仍会把它们清空，免得旧调用方读到过期模块。

  // 最近一次 HMR 失效的时间戳（monotonicDateNow）。写：invalidateModule(isHmr=true)、handlePrunedModules；
  // 读：importAnalysis 用它给 import 的 url 注入 ?t=、transformRequest 在 soft 失效时改写 import 时间戳、
  // indexHtml/css/asset 插件给引用 URL 加 ?t=、environment.ts 判断 invalidate 请求是否合法。
  lastHMRTimestamp = 0
  /**
   * `import.meta.hot.invalidate` is called by the client.
   * If there's multiple clients, multiple `invalidate` request is received.
   * This property is used to dedupe those request to avoid multiple updates happening.
   * @internal
   */
  lastHMRInvalidationReceived = false
  // 去重标记的写入方：invalidateModule(isHmr=true) 每轮重置为 false；environment.ts 的 invalidateModule
  // 接住 import.meta.hot.invalidate 后置 true。读取方只有 environment.ts，用来丢弃重复的 invalidate 请求。
  lastInvalidationTimestamp = 0
  // 非 HMR 失效的时间戳（配置文件变更、文件增删等）。写：invalidateModule(isHmr=false)；
  // 读：transformRequest 用 `timestamp > lastInvalidationTimestamp` 判断能否回写缓存，
  // 避免把「处理过程中已被失效」的旧结果重新缓存。
  /**
   * If the module only needs to update its imports timestamp (e.g. within an HMR chain),
   * it is considered soft-invalidated. In this state, its `transformResult` should exist,
   * and the next `transformRequest` for this module will replace the timestamps.
   *
   * By default the value is `undefined` if it's not soft/hard-invalidated. If it gets
   * soft-invalidated, this will contain the previous `transformResult` value. If it gets
   * hard-invalidated, this will be set to `'HARD_INVALIDATED'`.
   * @internal
   */
  invalidationState: TransformResult | 'HARD_INVALIDATED' | undefined
  // 一句话总结这个状态机：undefined=正常；TransformResult=soft 失效（保留旧码，只换 import 时间戳）；
  // 'HARD_INVALIDATED'=必须重新转译。写入方只有 invalidateModule，读取并清空的只有 transformRequest.ts 的
  // handleModuleSoftInvalidation。SSR 下 soft 只是省一次重转译（transformResult.ssr 分支直接复用），
  // 不会改 import 时间戳（时间戳由 ModuleRunner 自己的缓存控制）。
  /**
   * The module urls that are statically imported in the code. This information is separated
   * out from `importedModules` as only importers that statically import the module can be
   * soft invalidated. Other imports (e.g. watched files) needs the importer to be hard invalidated.
   * @internal
   */
  staticImportedUrls?: Set<string>
  // 写入方是 updateModuleInfo（由 importAnalysis 传入的静态 import 子集）；读取方是 invalidateModule：
  // 只有「静态 import 了我」的 importer 才能 soft 失效，watched/glob 这类依赖必须 hard 失效。

  /**
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   */
  // 构造只确定身份，不碰图边。setIsSelfAccepting=false 会让 isSelfAccepting 保持 undefined，
  // propagateUpdate 据此认为「这个模块还没被浏览器加载过」并停止向上传播（#7870 的延迟分析）。
  constructor(url: string, environment: string, setIsSelfAccepting = true) {
    this.environment = environment
    this.url = url
    // 直接 CSS 请求（以 link/style 引入，而非 JS import）单独算一种 type；'asset' 只能由 createFileOnlyEntry 标记。
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }
}

// _resolveUrl 的三元返回：规范化后的 url（可能补过扩展名）、resolvedId、resolveId 给出的 meta。
export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined,
]

// 单个 Environment 的模块图。四个 Map 是四种「按什么查模块」的索引，键不同、生命周期一致，
// 它们不是四份缓存，而是同一批节点的四套视图：
// - urlToModuleMap：浏览器请求 url → 节点。HMR payload 里写的是 url，transform 中间件也按 url 命中；
//   多个 url 可以指向同一节点（同一 id 的不同 query）。
// - idToModuleMap：resolve 后的 id → 节点。插件 API（getModuleInfo）与 importAnalysis 拿到的是 id。
// - etagToModuleMap：HTTP ETag → 节点，只有 client 环境维护，专门支撑 middlewares/transform.ts 的 304 快路径。
// - fileToModulesMap：磁盘文件 → 节点集合。watcher 只能给文件路径，而一个文件可能对应多个模块
//   （不同 query 的 CSS、?raw、不同 url），所以值必须是 Set。
export class EnvironmentModuleGraph {
  // Environment 名，构造时写入；仅用于日志、调试与兼容层判别。
  environment: string

  // 键是公开 url（已去掉 ?import / ?t=）。
  urlToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // 键是 resolve 后的 id，最权威的索引；getModuleById 直接查它。
  idToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // 键是 transformResult.etag；只在 updateModuleTransformResult 里维护，且只对 client 环境生效。
  etagToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // a single file may corresponds to multiple modules with different queries
  fileToModulesMap: Map<string, Set<EnvironmentModuleNode>> = new Map()
  // 读取方：getModulesByFile（watcher 链路）。因为值是 Set，onFileChange 必须遍历集合并逐个失效。

  /**
   * @internal
   */
  _unresolvedUrlToModuleMap: Map<
    string,
    EnvironmentModuleNode | Promise<EnvironmentModuleNode>
  > = new Map()
  // 上面这张表的两个作用：1) 并发去重 —— 同一 url 的多个请求在 resolveId 完成前共享同一个 Promise，
  // 不会重复建节点；2) 快路径 —— 连扩展名都没有的原始 url 也能直接命中。
  // 写入方只有 _setUnresolvedUrlToModule（先写 Promise，resolved 后再写节点覆盖）。

  /**
   * @internal
   */
  _resolveId: (url: string) => Promise<PartialResolvedId | null>
  // 由 Environment 注入的 resolver，实际是 pluginContainer.resolveId（见 environment.ts 构造函数）。
  // 返回 null 表示没解析出来，此时 _resolveUrl 退化为「用原 url 当 id」。

  /** @internal */
  _hasResolveFailedErrorModules: Set<EnvironmentModuleNode> = new Set()
  // 记录「因为 import 解析失败而抛错」的模块。写：plugins/importAnalysis.ts 在解析失败时 add，
  // invalidateModule 时 delete；读：hmr.ts 的 handleHMRUpdate 在 create 事件时把它们补进待更新模块，
  // 这样新建出的文件能让错误覆盖层自动消失。

  // 依赖注入 resolver：图本身不关心解析规则，只负责调用与缓存。
  constructor(
    environment: string,
    resolveId: (url: string) => Promise<PartialResolvedId | null>,
  ) {
    this.environment = environment
    this._resolveId = resolveId
  }

  // 作用：按浏览器 url 查节点。调用点：server/index.ts onFileAddUnlink（public 文件查 etag）、
  // middlewares 与插件在拿到请求 url 后查询。
  // 关键参数：rawUrl 允许带 ?import / ?t= / 不带扩展名，内部统一归一化。
  // 失败模式：resolveId 抛错会向上传播（importAnalysis 依赖这个行为给出带位置的解析错误）。
  async getModuleByUrl(
    rawUrl: string,
  ): Promise<EnvironmentModuleNode | undefined> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    // 快路径的意义：请求 url 可能不带扩展名（/src/main），而图里存的是补过扩展名的 url，
    // 所以先查原始 url 索引，避免每次都跑一遍 resolveId。
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    const mod = this._getUnresolvedUrlToModule(rawUrl)
    if (mod) {
      return mod
    }

    const [url] = await this._resolveUrl(rawUrl)
    return this.urlToModuleMap.get(url)
  }

  // 作用：按 id 查节点。调用点：pluginContainer.ts getModuleInfo、transformRequest.ts。
  // 先剥掉 ?t=：同一模块在不同 HMR 轮次里的 url 时间戳不同，但 id 不变。
  getModuleById(id: string): EnvironmentModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  // 作用：watcher 的唯一查询入口。返回 Set（同一文件多个模块），调用方要自己遍历；
  // 返回 undefined 表示该文件从未进过图（例如纯文本资源），调用方据此跳过 HMR。
  getModulesByFile(file: string): Set<EnvironmentModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  // 作用：文件内容变更时，把该文件对应的所有模块 hard 失效。
  // 调用点：server/index.ts onFileChange（watcher 的 change 回调），先于 handleHMRUpdate。
  // 注意：这里不设 isHmr，所以写的是 lastInvalidationTimestamp；浏览器可见的 lastHMRTimestamp 由
  // updateModules 后续再推进。
  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      // seen 在多个模块之间共享，避免同一节点被重复递归失效（一个文件多个 query 时很容易重复到达）。
      const seen = new Set<EnvironmentModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  // 作用：文件被删除时只拆反向边（把本模块从每个被依赖者的 importers 里摘掉），不删节点、不广播。
  // 调用点：server/index.ts onFileAddUnlink（unlink 分支），随后才进入 handleHMRUpdate('delete')。
  // 后果：节点仍留在 idToModuleMap/urlToModuleMap 里，只是不再有 importer；真正的 prune 广播由
  // importAnalysis 在下一次 updateModuleInfo 发现「不再被 import」时触发（hmr.ts handlePrunedModules）。
  onFileDelete(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      mods.forEach((mod) => {
        mod.importedModules.forEach((importedMod) => {
          importedMod.importers.delete(mod)
        })
      })
    }
  }

  // 作用：把节点标记为失效，并沿 importers 向上决定谁必须 hard、谁可以 soft 失效。
  // 调用点：本文件 onFileChange / invalidateAll；server/hmr.ts updateModules（isHmr=true）；
  //   server/environment.ts invalidateModule（import.meta.hot.invalidate 的服务端处理）；
  //   optimizer 重打包后的 fullReload 走 invalidateAll。mixedModuleGraph 会转发给 client/ssr 两张图。
  // 关键参数：
  //   seen —— 本轮已访问节点，用于终止环与重复递归（跨调用方共享）；
  //   timestamp —— monotonicDateNow()，同时充当 HMR 时间戳与失效时间戳；
  //   isHmr —— true 写 lastHMRTimestamp，false 写 lastInvalidationTimestamp，两者消费者完全不同；
  //   softInvalidate —— 只更新 import 时间戳、不重跑 transform 的失效。
  // 失败模式：没有异常路径；但 soft 对 SSR 只是省一次重转译（不改 import 时间戳），
  //   且直接 CSS 文件永远不能 soft（见下方传播分支）。
  invalidateModule(
    mod: EnvironmentModuleNode,
    seen: Set<EnvironmentModuleNode> = new Set(),
    timestamp: number = monotonicDateNow(),
    isHmr: boolean = false,
    /** @internal */
    softInvalidate = false,
  ): void {
    // 先保存旧状态：下面的 seen 去重要比较「失效前后状态是否变化」，连续 soft→hard 必须继续处理。
    const prevInvalidationState = mod.invalidationState

    // Handle soft invalidation before the `seen` check, as consecutive soft/hard invalidations can
    // cause the final soft invalidation state to be different.
    // If soft invalidated, save the previous `transformResult` so that we can reuse and transform the
    // import timestamps only in `transformRequest`. If there's no previous `transformResult`, hard invalidate it.
    if (softInvalidate) {
      // soft 的语义：保留旧 transformResult 的代码，只把里面 import 的 ?t= 换成新的
      // （由 transformRequest.ts handleModuleSoftInvalidation 完成）。因此它依赖旧结果存在；
      // 不存在就退化成 hard。用 ??= 是为了「已经 soft 过」的节点保留最初那份结果，
      // 而不是被第二次 soft 覆盖成 null。
      mod.invalidationState ??= mod.transformResult ?? 'HARD_INVALIDATED'
    }
    // If hard invalidated, further soft invalidations have no effect until it's reset to `undefined`
    else {
      // hard 把状态钉死成 'HARD_INVALIDATED'；同一轮里后续的 soft 由于 ??= 不会再覆盖它。
      mod.invalidationState = 'HARD_INVALIDATED'
    }

    // Skip updating the module if it was already invalidated before and the invalidation state has not changed
    // 去重条件：访问过「且」状态没变，才真正返回。若状态从 soft 升级为 hard，必须继续往下走，
    // 否则这条 importer 链上的模块会漏失效。
    if (seen.has(mod) && prevInvalidationState === mod.invalidationState) {
      return
    }
    seen.add(mod)

    if (isHmr) {
      // 两个副作用：推进 lastHMRTimestamp（浏览器据此拼 ?t= 强制重新请求模块）；
      // 重置 lastHMRInvalidationReceived（新一轮 HMR 允许再次调用 invalidate）。
      mod.lastHMRTimestamp = timestamp
      mod.lastHMRInvalidationReceived = false
    } else {
      // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started
      // processing being done for this module
      // 非 HMR 的时间戳只服务 transformRequest 的「处理中失效」判断，浏览器不感知。
      mod.lastInvalidationTimestamp = timestamp
    }

    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    // etag 是 304 缓存的对外句柄，必须在清 transformResult 之前取出并删表，
    // 否则 etagToModuleMap 会留下一条指向「已失效节点」的脏映射。
    const etag = mod.transformResult?.etag
    if (etag) this.etagToModuleMap.delete(etag)

    mod.transformResult = null

    // 已废弃字段也要清空，兼容仍从节点上读 ssrModule 的旧代码。
    mod.ssrModule = null
    mod.ssrError = null

    mod.importers.forEach((importer) => {
      // 已被 importer accept 的模块不再往上走：边界之上无需失效，这是 HMR 剪枝的核心。
      if (!importer.acceptedHmrDeps.has(mod)) {
        // If the importer statically imports the current module, we can soft-invalidate the importer
        // to only update the import timestamps. If it's not statically imported, e.g. watched/glob file,
        // we can only soft invalidate if the current module was also soft-invalidated. A soft-invalidation
        // doesn't need to trigger a re-load and re-transform of the importer.
        // But we exclude direct CSS files as those cannot be soft invalidated.
        // soft/hard 的选择：
        // - importer 静态 import 了我 → 代码里有可改的 import 语句，只需换时间戳（soft）；
        // - 否则（watched/glob/CSS @import 之类的隐式依赖）→ 代码里没有指向我的 import，必须 hard；
        // - 例外补偿：如果我自己就是 soft 失效（softInvalidate=true），importer 也可以跟着 soft；
        // - 直接 CSS 文件没有 JS 代码可改时间戳，所以一律 hard。
        const shouldSoftInvalidateImporter =
          (importer.staticImportedUrls?.has(mod.url) || softInvalidate) &&
          importer.type === 'js'
        this.invalidateModule(
          importer,
          seen,
          timestamp,
          isHmr,
          shouldSoftInvalidateImporter,
        )
      }
    })

    // 失效后这个节点不再算「解析失败」，下一次 create 事件不用再补它。
    this._hasResolveFailedErrorModules.delete(mod)
  }

  // 作用：一次性失效整张图。调用点：optimizer.ts 的 fullReload（依赖重打包后缓存里的 import
  // 路径可能过期）、配置变更后的手动兜底。
  // 共享同一个 timestamp 与 seen，保证一轮内所有节点的失效状态一致。
  invalidateAll(): void {
    const timestamp = monotonicDateNow()
    const seen = new Set<EnvironmentModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   *
   * @param staticImportedUrls Subset of `importedModules` where they're statically imported in code.
   *   This is only used for soft invalidations so `undefined` is fine but may cause more runtime processing.
   */
  // 作用：importAnalysis 每次转译完一个模块后，用最新分析结果整体替换该模块的出边与 accept 信息。
  // 调用点：plugins/importAnalysis.ts（静态 import 改写后、以及 CSS/HTML 等特殊分支）、
  //   plugins/css.ts（@import 依赖）、mixedModuleGraph 的兼容转发。
  // 关键参数：importedModules / acceptedModules 允许传 url 字符串（内部 ensureEntryFromUrl）或已有节点；
  //   importedBindings 为 null 表示没做静态绑定分析；staticImportedUrls 只用于 soft 失效判定。
  // 返回值：不再被任何人 import 的依赖集合，importAnalysis 拿它去 handlePrunedModules 发 prune。
  // 失败模式：ensureEntryFromUrl 内部 resolveId 抛错会让整个 Promise reject（importAnalysis 会补 pos 再抛）。
  async updateModuleInfo(
    mod: EnvironmentModuleNode,
    importedModules: Set<string | EnvironmentModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | EnvironmentModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,
    /** @internal */
    staticImportedUrls?: Set<string>,
  ): Promise<Set<EnvironmentModuleNode> | undefined> {
    mod.isSelfAccepting = isSelfAccepting
    const prevImports = mod.importedModules
    let noLongerImported: Set<EnvironmentModuleNode> | undefined

    let resolvePromises = []
    // 用下标而不是 push：importedModules 是 Set，遍历顺序即插入顺序；先按 index 占位，
    // 并发 resolve 完成后按原顺序回填，保证 nextImports 的顺序与源码 import 顺序一致。
    let resolveResults: Array<EnvironmentModuleNode> = Array.from({
      length: importedModules.size,
    })
    let index = 0
    // update import graph
    for (const imported of importedModules) {
      const nextIndex = index++
      if (typeof imported === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(imported).then((dep) => {
            // 建反向边：写的是 dep.importers，不是 mod.importers。
            dep.importers.add(mod)
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        imported.importers.add(mod)
        resolveResults[nextIndex] = imported
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    const nextImports = new Set(resolveResults)
    // 整体替换而不是增量合并：importAnalysis 给的是全量结果，增量合并会留下已删除的 import。
    mod.importedModules = nextImports

    // remove the importer from deps that were imported but no longer are.
    prevImports.forEach((dep) => {
      if (!mod.importedModules.has(dep)) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          // 摘完反向边后没人用了，交给调用方去 prune（发 prune payload 并推进 HMR 时间戳）。
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })

    // update accepted hmr deps
    // 注意：重建 accept 集合时不加反向边，也不动 importers —— accept 与 import 是两套正交关系。
    resolvePromises = []
    resolveResults = Array.from({ length: acceptedModules.size })
    index = 0
    for (const accepted of acceptedModules) {
      const nextIndex = index++
      if (typeof accepted === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted).then((dep) => {
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        resolveResults[nextIndex] = accepted
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    mod.acceptedHmrDeps = new Set(resolveResults)
    mod.staticImportedUrls = staticImportedUrls

    // update accepted hmr exports
    // 部分接受信息与 importedBindings 一起写入，供 propagateUpdate 判断
    // 「importer 是不是只用了被 acceptExports 覆盖的那几个导出」。
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings
    return noLongerImported
  }

  // 作用：把 url 变成图里的节点（没有就建），这就是「url → file → id」三级推断的入口。
  // 调用点：transformRequest.ts（另一条重载会传入已 resolve 的结果）、plugins/importAnalysis.ts、
  //   plugins/css.ts、ssr/fetchModule.ts、server/index.ts 的 indexHtml 中间件。
  // 关键参数：setIsSelfAccepting=false 表示「先建条目、先别标记为已分析」，让 propagateUpdate 之后
  //   把 undefined 当成「未加载」而停止传播（#7870 的延迟分析）。
  // 失败模式：resolveId 失败不抛错，而是用原 url 当 id（见 _resolveUrl），保证图里仍有一个可索引的节点。
  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
  ): Promise<EnvironmentModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, setIsSelfAccepting)
  }

  /**
   * @internal
   */
  // 与 ensureEntryFromUrl 相同，额外接收调用方已经算好的 resolve 结果，避免二次 resolveId
  // （importAnalysis 在改写 import 时手上已经有 resolved 了）。
  async _ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
    // Optimization, avoid resolving the same url twice if the caller already did it
    resolved?: PartialResolvedId,
  ): Promise<EnvironmentModuleNode> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    // 三级推断第一级：先剥掉协议层噪声（?import、?t=），让 /src/a.js?t=1 与 /src/a.js 命中同一个原始 url 键。
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    // 第二级快路径：原始 url 命中 _unresolvedUrlToModuleMap（值可能是未完成的 Promise，await 后即节点）。
    let mod = this._getUnresolvedUrlToModule(rawUrl)
    if (mod) {
      return mod
    }
    const modPromise = (async () => {
      // 第三级：resolveId → resolvedId → id，命中 idToModuleMap 就复用节点（url 可能只是它的别名）。
      const [url, resolvedId, meta] = await this._resolveUrl(rawUrl, resolved)
      mod = this.idToModuleMap.get(resolvedId)
      if (!mod) {
        mod = new EnvironmentModuleNode(
          url,
          this.environment,
          setIsSelfAccepting,
        )
        // resolve 结果里的 meta 只在新节点建立时写一次；同一 id 的后续 url 不覆盖它。
        if (meta) mod.meta = meta
        // 注册顺序是 url → id → file，三张表要么同时有、要么同时没有；
        // 缺一张就会出现「按 file 找不到、按 url 找得到」的不一致。
        this.urlToModuleMap.set(url, mod)
        mod.id = resolvedId
        this.idToModuleMap.set(resolvedId, mod)
        const file = (mod.file = cleanUrl(resolvedId))
        let fileMappedModules = this.fileToModulesMap.get(file)
        if (!fileMappedModules) {
          fileMappedModules = new Set()
          this.fileToModulesMap.set(file, fileMappedModules)
        }
        // 一个文件可以对应多个模块（不同 query / 不同 type），所以这里是 Set。
        fileMappedModules.add(mod)
      }
      // multiple urls can map to the same module and id, make sure we register
      // the url to the existing module in that case
      // 复用场景：带/不带扩展名、同一文件的 ?raw 与 ?url 都会落到同一 id，这里只补 url 索引。
      else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod)
      }
      this._setUnresolvedUrlToModule(rawUrl, mod)
      return mod
    })()

    // Also register the clean url to the module, so that we can short-circuit
    // resolving the same url twice
    // 关键：在 await 之前就把 Promise 写进表，让并发的同 url 请求共享同一次 resolve，避免重复建节点。
    this._setUnresolvedUrlToModule(rawUrl, modPromise)
    return modPromise
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  // 这类节点没有真实请求 url，也就不进 urlToModuleMap / idToModuleMap，只能按 file 查（HMR 触发用）。
  // url 用 /@fs/ 前缀伪造一个，只是为了让日志和 prune payload 里有个可读名字。
  createFileOnlyEntry(file: string): EnvironmentModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    // 复用条件：同 file、同 url 或同 id、且 type 为 asset，避免每次 CSS 转译都新建一个等价节点。
    for (const m of fileMappedModules) {
      if ((m.url === url || m.id === file) && m.type === 'asset') {
        return m
      }
    }

    const mod = new EnvironmentModuleNode(url, this.environment)
    mod.type = 'asset'
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx) and the ?import query
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  // 作用：给入口请求返回规范化的 [url, id, meta]。调用点：transformRequest.ts 的 resolve 阶段、
  // indexHtml 中间件。命中已建节点就直接用节点上的值，避免重复 resolveId。
  async resolveUrl(url: string): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const mod = await this._getUnresolvedUrlToModule(url)
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta]
    }
    return this._resolveUrl(url)
  }

  // 作用：写入转译结果并同步 etag 索引。调用点：transformRequest.ts（正常转译与 soft 失效重算两条路径）。
  // etag 表只维护 client 环境：SSR 结果不走 HTTP 缓存，etag 没有消费者。
  updateModuleTransformResult(
    mod: EnvironmentModuleNode,
    result: TransformResult | null,
  ): void {
    if (this.environment === 'client') {
      // 先删旧 etag 再写新 etag；顺序反了会在新旧 etag 相同时误删刚写入的映射。
      const prevEtag = mod.transformResult?.etag
      if (prevEtag) this.etagToModuleMap.delete(prevEtag)
      if (result?.etag) this.etagToModuleMap.set(result.etag, mod)
    }

    mod.transformResult = result
  }

  // 作用：ETag → 节点，供 middlewares/transform.ts 做 304 快速路径（命中即直接回 304，连文件都不读）。
  getModuleByEtag(etag: string): EnvironmentModuleNode | undefined {
    return this.etagToModuleMap.get(etag)
  }

  /**
   * @internal
   */
  _getUnresolvedUrlToModule(
    url: string,
  ): Promise<EnvironmentModuleNode> | EnvironmentModuleNode | undefined {
    return this._unresolvedUrlToModuleMap.get(url)
  }
  /**
   * @internal
   */
  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<EnvironmentModuleNode> | EnvironmentModuleNode,
  ): void {
    this._unresolvedUrlToModuleMap.set(url, mod)
  }

  /**
   * @internal
   */
  // 作用：真正调用 resolveId 并规范化 url。调用点：getModuleByUrl / resolveUrl / _ensureEntryFromUrl。
  // 关键点：resolvedId = resolveId 的结果，缺失时退回 url（能让图里仍有节点，真正的解析错误由
  // importAnalysis 报出）。
  // 失败模式：_resolveId 抛错会原样向上传播。
  async _resolveUrl(
    url: string,
    alreadyResolved?: PartialResolvedId,
  ): Promise<ResolvedUrl> {
    const resolved = alreadyResolved ?? (await this._resolveId(url))
    const resolvedId = resolved?.id || url
    // resolveId 返回的 id 可能带扩展名而 url 没有（/src/main → /src/main.ts）。
    // 这里把扩展名补回 url，保证「带/不带扩展名」最终映射到同一节点。
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId))
      if (ext) {
        const pathname = cleanUrl(url)
        if (!pathname.endsWith(ext)) {
          // 只替换 pathname 部分，query 原样保留（例如 /src/main?v=1 → /src/main.ts?v=1）。
          url = pathname + ext + url.slice(pathname.length)
        }
      }
    }
    // 三个例外（上面的条件）：url 与 id 相同、虚拟模块（\0 前缀）、virtual: 协议。
    // 虚拟模块的「扩展名」没有语义，补上去反而会破坏 id 匹配。
    return [url, resolvedId, resolved?.meta]
  }
}
