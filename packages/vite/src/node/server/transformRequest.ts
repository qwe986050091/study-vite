import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { init, parse as parseImports } from 'es-module-lexer'
import getEtag from 'etag'
import MagicString from 'magic-string'
import colors from 'picocolors'
import type {
  ModuleType,
  PartialResolvedId,
  SourceDescription,
  SourceMap,
} from 'rolldown'
import { cleanUrl, slash, unwrapId } from '../../shared/utils'
import { checkPublicFile } from '../publicDir'
import type { EnvironmentModuleNode } from '../server/moduleGraph'
import { ssrTransform } from '../ssr/ssrTransform'
import {
  createDebugger,
  ensureWatchedFile,
  injectQuery,
  isObject,
  monotonicDateNow,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBase,
  timeFrom,
} from '../utils'
import type { DevEnvironment } from './environment'
import { isFileLoadingAllowed } from './middlewares/static'
import { isServerAccessDeniedForTransform } from './middlewares/transform'
import { throwClosedServerError } from './pluginContainer'
import {
  applySourcemapIgnoreList,
  extractSourcemapFromFile,
  injectSourcesContent,
} from './sourcemap'

export const ERR_LOAD_URL = 'ERR_LOAD_URL'
export const ERR_LOAD_PUBLIC_URL = 'ERR_LOAD_PUBLIC_URL'
export const ERR_DENIED_ID = 'ERR_DENIED_ID'

const debugLoad = createDebugger('vite:load')
// ============================================================================
// 文件角色：一次模块请求的「resolve → load → transform → 缓存 → sourcemap 归一化」全流程。

// 上游：server/middlewares/transform.ts 的 viteTransformMiddleware，
//       以及 environment.transformRequest()（DevEnvironment 上的公开方法）。
// 下游：pluginContainer 的 resolveId/load/transform，最终落到内置插件
//       （plugins/resolve.ts、plugins/oxc.ts、plugins/importAnalysis.ts …）。

// 本文件最容易被读错的两点：
//   1. 缓存不是「按 URL 存一份字符串」，而是存在 moduleGraph 的 EnvironmentModuleNode
//      上（transformResult），并且有 hard/soft 两种失效语义；
//   2. 同一个 URL 的并发请求会被合并成一次 transform（_pendingRequests），
//      合并的前提是请求开始时间晚于模块最后一次失效时间。
// ============================================================================
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')

export interface TransformResult {
  // transform 的产物。etag 是给 HTTP 304 用的弱校验；
  // deps/dynamicDeps 是 importAnalysis 收集到的依赖清单（供 warmup 与依赖发现）；
  // map 既可能是完整 sourcemap，也可能是 { mappings: '' } 这个「空 map」哨兵。
  code: string
  map: SourceMap | { mappings: '' } | null
  ssr?: boolean
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  /**
   * @deprecated inferred from environment
   */
  ssr?: boolean
}

interface TransformOptionsInternal {
  /**
   * Whether to skip the `server.fs` check.
   */
  skipFsCheck: boolean
}

// TODO: This function could be moved to the DevEnvironment class.
// 作者注：这段逻辑本可以放进 DevEnvironment 类。保留在此的理由是它直接操作
// environment._closing / _pendingRequests / _registerRequestProcessing 三个内部字段，
// 放在一个文件里读起来更像一条直线；概念上它就是 environment.transformRequest。
// It was already using private fields from the server before, and it now does
// the same with environment._closing, environment._pendingRequests and
// environment._registerRequestProcessing. Maybe it makes sense to keep it in
// separate file to preserve the history or keep the DevEnvironment class cleaner,
// but conceptually this is: `environment.transformRequest(url, options)`

  // 请求级入口。做三件事，然后交给 doTransform：
  //   1. server 正在关闭时立刻抛 ERR_CLOSED_SERVER（生产模式下 recoverable=false，不抛）；
  //   2. 记录本次请求开始时间；
  //   3. 合并同 URL 的并发请求。
export function transformRequest(
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal,
): Promise<TransformResult | null> {
  if (environment._closing && environment.config.dev.recoverable)
    // recoverable 是「server 关闭/重启时请求可以安全失败」的开关。
    // dev 默认 true：让旧请求快速失败，由客户端重试；
    // 某些嵌入场景（中间件模式且宿主自己管生命周期）会关掉它，避免误伤。
    throwClosedServerError()

  // This module may get invalidated while we are processing it. For example
  // when a full page reload is needed after the re-processing of pre-bundled
  // dependencies when a missing dep is discovered. We save the current time
  // to compare it to the last invalidation performed to know if we should
  // cache the result of the transformation or we should discard it as stale.

  // A module can be invalidated due to:
  // 1. A full reload because of pre-bundling newly discovered deps
  // 2. A full reload after a config change
  // 3. The file that generated the module changed
  // 4. Invalidation for a virtual module

  // For 1 and 2, a new request for this module will be issued after
  // the invalidation as part of the browser reloading the page. For 3 and 4
  // there may not be a new request right away because of HMR handling.
  // In all cases, the next time this module is requested, it should be
  // re-processed.

  // We save the timestamp when we start processing and compare it with the
  // last time this module is invalidated
  const timestamp = monotonicDateNow()
  // 单调时钟（不是 Date.now），用于和 module.lastInvalidationTimestamp 比较。
  // 这是「这次 transform 的结果还算不算数」的唯一判据：
  // 处理期间若有文件变更把模块置为失效，结果就不能写回缓存。

  url = removeTimestampQuery(url)

  const pending = environment._pendingRequests.get(url)
  // 并发合并：同一 URL 同时有多个请求（典型是多个 importer 都 import 它）时，
  // 后来的请求直接复用前一个的 promise，避免重复跑一遍插件链。
  // 复用前必须确认「前一个请求开始后模块没有被失效」，否则复用的是过期结果。
  if (pending) {
    return environment.moduleGraph.getModuleByUrl(url).then((module) => {
      if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
        // The pending request is still valid, we can safely reuse its result
        return pending.request
      } else {
        // Request 1 for module A     (pending.timestamp)
        // Invalidate module A        (module.lastInvalidationTimestamp)
        // Request 2 for module A     (timestamp)

        // First request has been invalidated, abort it to clear the cache,
        // then perform a new doTransform.
        pending.abort()
        return transformRequest(environment, url, options)
      }
    })
  }

  const request = doTransform(environment, url, options, timestamp)
  // 真正干活。注意它没有 try/catch：异常原样抛给中间件，由中间件翻译成 HTTP 语义。

  // Avoid clearing the cache of future requests if aborted
  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      environment._pendingRequests.delete(url)
      cleared = true
    }
  }

  // Cache the request and clear it once processing is done
  environment._pendingRequests.set(url, {
    request,
    timestamp,
    abort: clearCache,
  })

  return request.finally(clearCache)
}

  // 处理流程：URL → 模块（可能已有缓存）→ 解析 id → 按 id 再查一次缓存 → load+transform。
  // 之所以要按 id 再查一次，是因为不同 URL 可能指向同一个 id（别名、带/不带查询参数）。
async function doTransform(
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal,
  timestamp: number,
) {
  const { pluginContainer } = environment

  let module = await environment.moduleGraph.getModuleByUrl(url)
  // 先按 URL 查图。命中说明这个 URL 之前被处理过，可能直接有缓存结果。
  if (module) {
    // try use cache from url
    const cached = await getCachedTransformResult(
      environment,
      url,
      module,
      timestamp,
    )
    if (cached) return cached
  }

  const resolved = module
    // 图里没有这个 URL 时才需要 resolve。
    // 默认 importer 是 root/index.html —— 也就是「浏览器直接请求的入口模块」的语义。
    ? undefined
    : ((await pluginContainer.resolveId(url, undefined)) ?? undefined)

  // resolve
  const id = module?.id ?? resolved?.id ?? url
  // id 的三级来源：图里已有 → resolveId 结果 → URL 本身。
  // 最后这个兜底让「插件都不认识的 URL」也能继续走 load 阶段并给出清晰报错。

  module ??= environment.moduleGraph.getModuleById(id)
  if (module) {
    // if a different url maps to an existing loaded id,  make sure we relate this url to the id
    await environment.moduleGraph._ensureEntryFromUrl(url, undefined, resolved)
    // 不同 URL 映射到同一个 id 时，把 URL 关系补进图里，
    // 否则 HMR 沿 importers 传播时会漏掉这条边。
    // try use cache from id
    const cached = await getCachedTransformResult(
      environment,
      url,
      module,
      timestamp,
    )
    if (cached) return cached
  }

  const result = loadAndTransform(
    environment,
    id,
    url,
    options,
    timestamp,
    module,
    resolved,
  )

  const { depsOptimizer } = environment
  // 登记「这个 id 正在处理」，供 waitForRequestsIdle 与 HMR 的
  // 「等我处理完再发更新」逻辑使用。优化过的依赖不登记：
  // 它们由 depsOptimizer 自己管生命周期，不参与模块图的请求计数。
  if (!depsOptimizer?.isOptimizedDepFile(id)) {
    environment._registerRequestProcessing(id, () => result)
  }

  return result
}

  // 缓存查询。顺序很重要：先试 soft invalidation（可复用旧结果、只改时间戳），
  // 再试完整缓存。soft 必须在前，因为它会把 invalidationState 置空。
async function getCachedTransformResult(
  environment: DevEnvironment,
  url: string,
  module: EnvironmentModuleNode,
  timestamp: number,
) {
  const prettyUrl = debugCache ? prettifyUrl(url, environment.config.root) : ''

  // tries to handle soft invalidation of the module if available,
  // returns a boolean true is successful, or false if no handling is needed
    // soft invalidation：模块内容变了但「结构没变」时，可以复用上一次的 transform 结果，
    // 只把 import 里的 ?t= 时间戳换成新的。见文件末尾 handleModuleSoftInvalidation。
  const softInvalidatedTransformResult = await handleModuleSoftInvalidation(
    environment,
    module,
    timestamp,
  )
  if (softInvalidatedTransformResult) {
    debugCache?.(`[memory-hmr] ${prettyUrl}`)
    return softInvalidatedTransformResult
  }

  // check if we have a fresh cache
  // 完整缓存：transformResult 是上一次的成功产物（含 etag 与 map）。
  const cached = module.transformResult
  if (cached) {
    debugCache?.(`[memory] ${prettyUrl}`)
    return cached
  }
}

  // 真正的 I/O + 插件链。注意这是 async 的：load 可能读磁盘，transform 可能起子进程（css 预处理器）。
async function loadAndTransform(
  environment: DevEnvironment,
  id: string,
  url: string,
  options: TransformOptionsInternal,
  timestamp: number,
  mod?: EnvironmentModuleNode,
  resolved?: PartialResolvedId,
) {
  const { config, pluginContainer, logger } = environment
  const prettyUrl =
    debugLoad || debugTransform ? prettifyUrl(url, config.root) : ''

  const moduleGraph = environment.moduleGraph

    // 加载期文件访问检查：虚拟模块（\0 开头）不查；其余按 fs.strict 规则判定。
    // 这一层挡的是「插件通过 id 读到了 root 之外的文件」，与静态文件服务的检查点不同。
  if (
    !options.skipFsCheck &&
    id[0] !== '\0' &&
    isServerAccessDeniedForTransform(environment, id)
  ) {
    const err: any = new Error(`Denied ID ${id}`)
    err.code = ERR_DENIED_ID
    err.id = id
    throw err
  }

  let code: string | null = null
  // ---- load 阶段 ----
  let map: SourceDescription['map'] = null
  let moduleType: ModuleType | undefined

  // load
  const loadStart = debugLoad ? performance.now() : 0
  const loadResult = await pluginContainer.load(id)
  // 先问插件。内置插件里能 load 的有：asset、json、wasm、worker、css(部分)、
  // html inline proxy、优化依赖代理等。返回 null 表示「我不负责」。

  if (loadResult == null) {
    // 插件都不认领时回落成「按 UTF-8 读文件」。
    // 二进制资源若走到这里说明缺少对应插件，读出来的是乱码——注释里明确要求插件先认领。
    const file = cleanUrl(id)

    // try fallback loading it from fs as string
    // if the file is a binary, there should be a plugin that already loaded it
    // as string
    // only try the fallback if access is allowed, skip for out of root url
    // like /service-worker.js or /api/users
    if (options.skipFsCheck || isFileLoadingAllowed(config, slash(file))) {
      try {
        code = await fsp.readFile(file, 'utf-8')
        debugLoad?.(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'EISDIR') {
          throw e
        }
      }
      if (code != null && environment.pluginContainer.watcher) {
        // 文件首次被读到时挂到 watcher 上。dev server 只监听 root 与显式依赖，
        // 被插件 load 出来的 root 外文件必须在这里补登记，否则改动不会触发 HMR。
        ensureWatchedFile(
          environment.pluginContainer.watcher,
          file,
          config.root,
        )
      }
    }
    if (code) {
      // 源码里可能自带 sourceMappingURL（例如预编译产物）。先剥出 map，
      // 后面插件的 sourcemap 会与它串联，最终 map 才能指回原始源文件。
      try {
        const extracted = extractSourcemapFromFile(code, file, logger)
        if (extracted) {
          code = extracted.code
          map = extracted.map
        }
      } catch (e) {
        logger.warn(`Failed to load source map for ${file}.\n${e}`, {
          timestamp: true,
        })
      }
    }
  } else {
    debugLoad?.(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
      moduleType = loadResult.moduleType
    } else {
      code = loadResult
    }
  }
  if (code == null) {
    // load 不出内容：区分「public 目录里的文件」与「文件不存在」两种文案。
    // public 文件是常见误用（import 了 public 里的资源），错误信息直接给出正确写法。
    const isPublicFile = checkPublicFile(url, environment.getTopLevelConfig())
    let publicDirName = path.relative(config.root, config.publicDir)
    if (publicDirName[0] !== '.') publicDirName = '/' + publicDirName
    const msg = isPublicFile
      ? `This file is in ${publicDirName} and will be copied as-is during ` +
        `build without going through the plugin transforms, and therefore ` +
        `should not be imported from source code. It can only be referenced ` +
        `via HTML tags.`
      : `Does the file exist?`
    const importerMod: EnvironmentModuleNode | undefined =
      moduleGraph.idToModuleMap.get(id)?.importers.values().next().value
    const importer = importerMod?.file || importerMod?.url
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})${
        importer ? ` in ${importer}` : ''
      }. ${msg}`,
    )
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL
    throw err
  }
  if (moduleType === undefined) {
    // 模块类型推断：rolldown 需要知道按 js/jsx/ts/tsx/json/css/text 哪种语法解析。
    // 插件可以显式给 moduleType；没给时按扩展名猜，只有非 js 才覆盖默认值。
    const guessedModuleType = getModuleTypeFromId(id)
    if (guessedModuleType && guessedModuleType !== 'js') {
      moduleType = guessedModuleType
    }
  }

  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  // ensure module in graph after successful load
  mod ??= await moduleGraph._ensureEntryFromUrl(url, undefined, resolved)
  // load 成功后才把模块正式建档。失败不建档，避免图里留下永远 load 不出的节点。

  // transform
  const transformStart = debugTransform ? performance.now() : 0
  const transformResult = await pluginContainer.transform(code, id, {
    // ---- transform 阶段 ----
    // 这里传入 inMap，插件链上每个插件返回的 map 会被串成一条链（见 pluginContainer 的
    // TransformPluginContext.sourcemapChain）。
    inMap: map,
    moduleType,
  })
  const originalCode = code
  if (transformResult.code === originalCode) {
    // no transform applied, keep code as-is
    debugTransform?.(
      timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`),
    )
  } else {
    debugTransform?.(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }

  let normalizedMap: SourceMap | { mappings: '' } | null
  // map 归一化：插件可能返回字符串（旧 rollup 风格）或对象；
  // 没有 map 时置 null，后续按「无 sourcemap」处理。
  if (typeof map === 'string') {
    normalizedMap = JSON.parse(map)
  } else if (map) {
    normalizedMap = map as SourceMap | { mappings: '' }
  } else {
    normalizedMap = null
  }

  if (normalizedMap && 'version' in normalizedMap && mod.file) {
    // sourcemap 后处理三件事：
    //   1. injectSourcesContent：把源文件内容写进 map，DevTools 才能显示原始代码；
    //   2. applySourcemapIgnoreList：node_modules 默认折叠进 ignore list；
    //   3. 把绝对 sources 改成相对路径，否则 DevTools 里显示的路径不可读。
    if (normalizedMap.mappings) {
      await injectSourcesContent(normalizedMap, mod.file, logger)
    }

    const sourcemapPath = `${mod.file}.map`
    applySourcemapIgnoreList(
      normalizedMap,
      sourcemapPath,
      config.server.sourcemapIgnoreList,
      logger,
    )

    if (path.isAbsolute(mod.file)) {
      let modDirname
      for (
        let sourcesIndex = 0;
        sourcesIndex < normalizedMap.sources.length;
        ++sourcesIndex
      ) {
        const sourcePath = normalizedMap.sources[sourcesIndex]
        if (sourcePath) {
          // Rewrite sources to relative paths to give debuggers the chance
          // to resolve and display them in a meaningful way (rather than
          // with absolute paths).
          if (path.isAbsolute(sourcePath)) {
            modDirname ??= path.dirname(mod.file)
            normalizedMap.sources[sourcesIndex] = path.relative(
              modDirname,
              sourcePath,
            )
          }
        }
      }
    }
  }

  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  const topLevelConfig = environment.getTopLevelConfig()
  const result = environment.config.dev.moduleRunnerTransform
    // SSR / ModuleRunner 环境需要额外一遍 ssrTransform：把 ESM 改写成
    // 可在 runner 里执行的形态（import → __vite_ssr_import__ 等）。
    // 普通 dev 客户端不走这里，所以这一步是 SSR 与 client 的最后一个分叉。
    ? await ssrTransform(code, normalizedMap, url, originalCode, {
        json: {
          stringify:
            topLevelConfig.json.stringify === true &&
            topLevelConfig.json.namedExports !== true,
        },
      })
    : ({
        code,
        map: normalizedMap,
        // etag 基于最终 code 的弱校验。它同时用于 HTTP 304 与 moduleGraph 的 etag 索引，
        // 因此同一 URL 的相同内容必须得到相同 etag。
        etag: getEtag(code, { weak: true }),
      } satisfies TransformResult)

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp)
    // 只有当「请求开始时间晚于最后一次失效时间」时才写缓存。
    // 否则说明处理期间文件被改了，这份结果已经过期，写进去会污染后续请求。
    moduleGraph.updateModuleTransformResult(mod, result)

  return result
}

/**
 * When a module is soft-invalidated, we can preserve its previous `transformResult` and
 * return similar code to before:
 *
 * - Client: We need to transform the import specifiers with new timestamps
 * - SSR: We don't need to change anything as `ssrLoadModule` controls it
 */
  // soft invalidation 的复用逻辑。
  // 触发场景：模块被 invalidateModule(soft=true) 标记，通常来自 HMR 的「依赖变了但我自己没变」判断。
  // 核心洞察：源码没变，只有被 import 模块的 ?t= 时间戳要更新，所以不必重跑插件链，
  // 只对 import 说明符做一次字符串替换即可。
async function handleModuleSoftInvalidation(
  environment: DevEnvironment,
  mod: EnvironmentModuleNode,
  timestamp: number,
) {
  const transformResult = mod.invalidationState
  // invalidationState 有两种取值：'HARD_INVALIDATED' 或上一次的 TransformResult。
  // 取出后立刻清空——soft 结果只能用一次，下一次必须重新判断。

  // Reset invalidation state
  mod.invalidationState = undefined

  // Skip if not soft-invalidated
  if (!transformResult || transformResult === 'HARD_INVALIDATED') return

  if (mod.transformResult) {
    throw new Error(
      `Internal server error: Soft-invalidated module "${mod.url}" should not have existing transform result`,
    )
  }

  let result: TransformResult
  // For SSR soft-invalidation, no transformation is needed
  if (transformResult.ssr) {
    // SSR 侧不需要改时间戳：runner 的模块缓存由 ssrLoadModule/ModuleRunner 自己控制，
    // 它直接引用模块对象，不靠 URL 上的 ?t= 触发重新加载。
    result = transformResult
  }
  // We need to transform each imports with new timestamps if available
  else {
    await init()
    // 客户端侧：重新解析 import 区间，只改「指向已变更 importer」的那些说明符。
    // moduleUrl 的推导必须与 plugins/importAnalysis.ts 完全一致
    // （剥 base、剥 ?import、unwrap /@id/），否则匹配不上，改动会被静默跳过。
    const source = transformResult.code
    const s = new MagicString(source)
    const [imports] = parseImports(source, mod.id || undefined)

    for (const imp of imports) {
      let rawUrl = source.slice(imp.start, imp.end)
      if (imp.type === 'import-meta') continue

      const hasQuotes = rawUrl[0] === '"' || rawUrl[0] === "'"
      if (hasQuotes) {
        rawUrl = rawUrl.slice(1, -1)
      }

      const urlWithoutTimestamp = removeTimestampQuery(rawUrl)
      // moduleUrl must be derived the same way as importAnalysis
      const moduleUrl = unwrapId(
        stripBase(
          removeImportQuery(urlWithoutTimestamp),
          environment.config.base,
        ),
      )
      for (const importedMod of mod.importedModules) {
        if (importedMod.url !== moduleUrl) continue
        if (importedMod.lastHMRTimestamp > 0) {
          // lastHMRTimestamp：该模块最近一次 HMR 更新时打的时间戳。
          // 只有大于 0 才说明它变过；替换成 ?t=<ts> 后浏览器会把它当成新 URL 重新请求。
          const replacedUrl = injectQuery(
            urlWithoutTimestamp,
            `t=${importedMod.lastHMRTimestamp}`,
          )
          const start = hasQuotes ? imp.start + 1 : imp.start
          const end = hasQuotes ? imp.end - 1 : imp.end
          s.overwrite(start, end, replacedUrl)
        }

          // 顺带预热静态 import（非 dynamic）：soft 失效后这些依赖大概率马上会被请求，
          // 提前 transform 可以把瀑布式请求压平。preTransformRequests=false 时跳过。
        if (
          imp.type !== 'dynamic' &&
          environment.config.dev.preTransformRequests
        ) {
          // pre-transform known direct imports
          environment.warmupRequest(moduleUrl)
        }

        break
      }
    }

    // Update `transformResult` with new code. We don't have to update the sourcemap
    // as the timestamp changes doesn't affect the code lines (stable).
    const code = s.toString()
    result = {
      ...transformResult,
      code,
      etag: getEtag(code, { weak: true }),
    }
  }

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp)
    environment.moduleGraph.updateModuleTransformResult(mod, result)

  return result
}

// https://github.com/rolldown/rolldown/blob/cc66f4b7189dfb3a248608d02f5962edb09b11f8/crates/rolldown/src/utils/normalize_options.rs#L95-L111
// 扩展名 → rolldown ModuleType 的映射，抄自 rolldown 的 normalize_options。
// 为什么不用 mime 库：这里需要的是「解析器类型」，不是 MIME。
const defaultModuleTypes: Record<string, ModuleType | undefined> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  json: 'json',
  txt: 'text',
  css: 'css',
}

// https://github.com/rolldown/rolldown/blob/bf53a100edf1780d5a5aa41f0bc0459c5696543e/crates/rolldown/src/utils/load_source.rs#L53-L89
export function getModuleTypeFromId(id: string): ModuleType | undefined {
  // 从 id 里找第一个能识别的扩展名（不只查最后一段，以支持 /a/b.ts.js 这类复合扩展）。
  // 找不到返回 undefined，由 rolldown 自己按内容猜。
  let pos = -1
  while ((pos = id.indexOf('.', pos + 1)) >= 0) {
    const ext = id.slice(pos + 1)
    const moduleType = defaultModuleTypes[ext]
    if (moduleType) {
      return moduleType
    }
  }
}
