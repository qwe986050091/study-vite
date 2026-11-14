# Vite 阅读指南

> 目标：顺着注释把「一条请求从浏览器 URL 到磁盘产物」读通，不用再问人。
> 位置一律指到**文件 + 函数名**，不指行号区间（注释会增行，行号必然漂移）。
> 所有结论都来自本仓 `packages/vite/src` 的实际代码，不采信记忆里的旧版本行为。

## 0. 前置知识

- **ESM 与浏览器原生模块**：`<script type="module">`、裸说明符（`import 'lodash'`）浏览器无法解析、`import.meta.url`。
- **HTTP 与 connect 中间件**：`use(fn)` 顺序即处理顺序，`next()` 下传，`res.end()` 短路。
- **rollup 插件接口**：`resolveId / load / transform / buildStart / closeBundle` 的语义与返回值约定（Vite 插件是它的超集）。本仓内核是 rolldown，但这套接口契约基本一致。
- **sourcemap 的串联**：一次 transform 产出的 map 描述「输出 → 输入」，多次 transform 要逆序叠加合成一张。
- **rolldown / oxc 是什么**：rolldown 是 Rust 写的打包器（替代 rollup），oxc 是 Rust 写的解析/转译器（替代本仓里绝大部分 esbuild 的职责）。本仓不克隆它们的源码，只调用其 JS 接口；它们在图中的位置见第 5 节。

## 1. 从哪开始（以及为什么不从最容易想到的入口开始）

**先读 [`server/middlewares/transform.ts`](../packages/vite/src/node/server/middlewares/transform.ts) 的 `viteTransformMiddleware`，再读同文件的 `isTransformRequest`。**

理由：

- 它把「浏览器请求一个模块」这件事压缩成一个函数，并且把后续所有分支都点了名：sourcemap 请求、CSS 直接请求、依赖产物请求、普通模块请求、`?import` / `@id` 前缀、权限拒绝、过期依赖。读完这一个函数，你会得到一张后续所有文件的索引。
- 它与下游的接口非常窄：规范化 URL → `environment.transformRequest(url)` → 按结果发响应 / 按下错误码回 504 / 404。

**不要从这几个地方开始（它们是「最容易想到」但信息密度最低的入口）：**

- `src/node/index.ts`：几乎全是 `export type { ... }`，它只是公共 API 目录，没有执行逻辑。
- `src/node/cli.ts`：yargs 参数解析 + 调 `resolveConfig` + 调 `createServer`。除了「启动命令怎么映射到配置」，读它对理解链路没有帮助。
- `src/node/config.ts` 全文：2,700 行里大半是每个配置项的归一化与兼容处理。只需读 `resolveConfig` 里「plugins → environments → resolvePlugins 调用点」这一段（注释已标出）。
- `index.html` 相关插件（`plugins/html.ts`）：它是「HTML 里的资源怎么变成模块请求」的规则集，应该在第 2 段回头再读，而不是当入口。

## 2. 分段路线

### 段 1 启动与依赖预构建

**入口**：`src/node/cli.ts` → `resolveConfig`（`src/node/config.ts`）→ `_createServer`（`src/node/server/index.ts`）→ `DevEnvironment.listen`（`src/node/server/environment.ts`）。

**结束**：`DepsOptimizer.init()` 跑完，`node_modules/.vite/deps/` 下出现产物与 `_metadata.json`。

**路径**：

- `_createServer`：依次建 environments → `environment.init()`（建 pluginContainer）→ 挂中间件 → 覆写 `httpServer.listen`，保证「依赖预构建完成后端口才打开」。
- `DevEnvironment.listen` → `depsOptimizer.init()` → `loadCachedDepOptimizationMetadata`：用 `configHash + lockfileHash` 判断缓存是否可用。**缓存的失效条件**就是这两个 hash 的变化（以及 `--force` / `optimizeDeps.force`）。
- 缓存不可用 → `discoverProjectDependencies` → `scanImports`（`optimizer/scan.ts`）：只做「解析 + load」的图遍历，找出所有需要预构建的裸依赖，产出 `deps` 与 `missing` 两张表。
- → `runOptimizeDeps` → `prepareRolldownOptimizerRun` → `rolldown()`：把每个依赖打成一个 ESM 产物（含 CJS interop 包装）。
- → `commit()`：把 `_metadata.json` 与产物原子地落到 cacheDir。

**获得**：为什么需要预构建（浏览器不认识裸说明符；把几百个 CJS 小文件合成一个 ESM 文件，避免请求瀑布）；`configHash` / `lockfileHash` / `browserHash` 三个 hash 各自管什么；扫描阶段与 dev 阶段共用同一套插件解析（所以 alias / tsconfig paths 在扫描里也生效）。

**衔接**：预构建产物的路径与 `?v=browserHash` 由 `getOptimizedDepPath` 决定，段 2 的 `importAnalysis` 会把裸说明符改写成这个路径。

### 段 2 开发服务器与一次模块请求

**入口**：`viteTransformMiddleware`（`server/middlewares/transform.ts`）。

**结束**：`transformRequest`（`server/transformRequest.ts`）返回 `{ code, map, etag }`，中间件按 `js` / `css` 发回。

**路径**：

- `cachedTransformMiddleware` 先按 `If-None-Match` 尝试 304（不产出内容）。
- `viteTransformMiddleware` 规范化 URL（剥 `?import`、还原 `@id`、CSS 补 `?direct`）→ `environment.transformRequest`。
- `transformRequest`：合并同 URL 并发请求 → `doTransform`（图缓存命中 → `resolveId` → 按 id 再查缓存）→ `loadAndTransform`。
- `loadAndTransform`：权限检查 → `pluginContainer.load` → 插件都不认领时回落读文件 → `pluginContainer.transform` → sourcemap 归一化 → 写回 `moduleGraph`。
- `pluginContainer.transform`（`server/pluginContainer.ts`）：按 `getSortedPlugins` 的顺序串行执行 transform，每个插件的输出是下一个的输入，map 压入 `sourcemapChain`。

**获得**：一条模块请求的完整时序；「缓存存在模块图上而不是 URL 上」；`_pendingRequests` 的合并与「处理期间被失效则丢弃结果」的判据；错误码（`ERR_OUTDATED_OPTIMIZED_DEP` / `ERR_CLOSED_SERVER` / `ERR_DENIED_ID`）到 HTTP 语义的映射。其中 `ERR_OUTDATED_OPTIMIZED_DEP` 由 `plugins/optimizedDeps.ts` 的 `throwOutdatedRequest` 抛出，不是 `registerMissingImport` 抛的。

**衔接**：`pluginContainer` 里的插件顺序由 `resolvePlugins`（`plugins/index.ts`）决定；真正把裸说明符改写成依赖 URL 的是段 3 的 `importAnalysis`。

### 段 3 transform 管线与插件容器

**入口**：`resolvePlugins`（`plugins/index.ts`）→ `EnvironmentPluginContainer.transform`（`server/pluginContainer.ts`）。

**结束**：`importAnalysisPlugin` 的 `transform` 跑完，代码里的 import 全部变成浏览器可请求的 URL。

**路径**：

- `resolvePlugins` 的数组顺序即「同 order 插件之间的顺序」。三条硬规则：解析类插件（`preAlias` → `alias` → `oxcResolvePlugin`）必须靠前；`importAnalysis` 永远最后；用户插件插在 normal 段。
- `pluginContainer` 的 hook 语义：`resolveId` / `load` 是 hookFirst（第一个非空结果胜出），`transform` 是全链串行，`watchChange` / `buildStart` 是并行（`sequential` 可改）。
- 转译：`oxcPlugin`（`plugins/oxc.ts`）负责 TS/JSX → JS；`transformWithOxc` 是它的实现，返回的 tsconfig 文件会被加进 watcher。
- 解析：`oxcResolvePlugin`（`plugins/resolve.ts`）返回的是**插件数组**而不是单个插件。注意本版本的分工：`optimizerResolvePlugin`（`vite:resolve-dev`）处理已预构建依赖与缺失依赖；真正的 `vite:resolve-builtin` 由 rolldown 原生 `viteResolvePlugin` 提供，`resolve.ts` 只负责合并 `resolve` 配置并挂三个回调（`finalizeBareSpecifier` / `finalizeOtherSpecifiers` / `resolveSubpathImports`）。`/@fs/` 由 `server/moduleUrl.ts` 的 `fileToModuleUrl` 产生，`/@id/` 由 `importAnalysis.ts` 的 `wrapId` 产生。
- 改写：`importAnalysisPlugin`（`plugins/importAnalysis.ts`）用 `es-module-lexer` 找 import 区间，逐个 `this.resolve`，再 `MagicString` 改写。它**只消费**解析结果：依赖 URL（`/node_modules/.vite/deps/x.js?v=browserHash`）是在 `resolve.ts` 的 `finalizeBareSpecifier` / `getOptimizedDepId` 里拼好的；非 JS 资源加 `?import`，不合法说明符加 `/@id/` 则确实由本插件完成。

**获得**：「插件顺序为什么不能乱」；Vite 插件接口与 rollup 的兼容层在哪（`PluginContext` 的能力对照注释）；一次 transform 的 sourcemap 是怎么串起来的；`?import`、`/@fs/`、`/@id/`、`?t=`、`\0` 五个约定的产生者与消费者。

**衔接**：缺失依赖会在 `optimizerResolvePlugin` 里调用 `depsOptimizer.registerMissingImport`，把流程送回段 1 的「重新预构建 + 整页刷新」。

### 段 4 HMR

**入口**：`watcher.on('change')`（`server/index.ts`）→ `handleHMRUpdate`（`server/hmr.ts`）。

**结束**：浏览器端 `client.ts` 的 `handleMessage` 执行 `import()` 替换模块，或 `pageReload`。

**路径**：

- 文件变更：`onFileChange` → 各 environment 的 `pluginContainer.watchChange` → `moduleGraph.onFileChange` → `handleHMRUpdate`。
- `updateModules`：从变更模块出发，沿 `importers` 向上找「self-accepting」或「accept 了这个依赖」的边界；找不到就是整页刷新。
- 边界判定依赖 `acceptedHmrDeps` / `isSelfAccepting`（由 `importAnalysis` 从 `import.meta.hot.accept` 里收集）。
- 服务端把 `{ type: 'update', updates: [{ path, acceptedPath, timestamp }] }` 通过 `server/ws.ts` 推给客户端。
- 客户端 `handleMessage` 对每个 update 重新 `import(path + '?t=' + timestamp)`，再调用边界模块注册的 accept 回调；失败则 `pageReload`。
- `moduleGraph`（`server/moduleGraph.ts`）是这一切的数据结构：四张索引表 + `invalidateModule` 的 hard/soft 两种失效。

**获得**：为什么 HMR 需要模块图（需要反向边找边界）；`?t=` 时间戳的真正作用（让浏览器认为是新 URL）；soft invalidation 为什么能只改时间戳不重跑插件链。

**衔接**：SSR 侧不走向 `ws`，而是 `ModuleRunner` 通过 `environment.fetchModule` 拉模块（`ssr/fetchModule.ts`、`module-runner/runner.ts`）。

### 段 5 生产构建

**入口**：`build()` → `createBuilder()` → `buildEnvironment()`（`src/node/build.ts`）。

**结束**：`bundle = await rolldown(rolldownOptions)` 完成，`generateBundle` 系列插件改完产物，写盘。

**路径**：

- 输入推导：`lib.entry` > `build.ssr` > `rolldownOptions.input` > `config.input` > `root/index.html`。
- 插件分两段：`resolveBuildPlugins().pre`（`prepareOutDirPlugin`、用户的 `rolldownOptions.plugins`）与 `.post`（`buildImportAnalysisPlugin` → 可选 esbuild/terser → license/manifest/ssrManifest/reporter → `nativeLoadFallbackPlugin`）。
- **Vite 自己补的那一层**：输入推导与 HTML 入口、环境相关的 resolve 条件（browser/node）、CSS 抽取与资源 URL、`__VITE_PRELOAD__` 占位符与 `__vite__mapDeps` 注入、manifest、chunk 文件名与 hash。真正的「打包算法」（tree-shaking、chunk 拆分、代码生成）全部在 rolldown 里。
- `plugins/importAnalysisBuild.ts`：build 侧的 import 改写，负责把 marker 替换成 preload 代码、把 `import()` 的依赖签名并进 chunk hash。

**获得**：`build()` 与 `createBuilder()` 的分工（前者是单环境便捷入口，后者是多环境编排）；为什么 dev 与 build 的插件容器不是同一个（dev 由 Vite 执行 hook，build 交给 rolldown）；`build.minify === 'esbuild'` 是 esbuild 在构建链里唯一还活着的位置。

## 3. 分支路线

| 只想懂 | 跳入点 | 必须先补 |
|---|---|---|
| 依赖预构建缺依赖后的「重新预构建 + 整页刷新」 | `optimizer/optimizer.ts` 的 `registerMissingImport`、`optimizer/index.ts` 的 `runOptimizeDeps` | 段 1、段 3 |
| esbuild 插件为什么还能用 | `optimizer/pluginConverter.ts` 的 `convertEsbuildPluginToRolldownPlugin` | 段 1（`esbuildOptions.plugins` 的兼容入口） |
| 静态文件 / `server.fs.allow` 权限 | `server/middlewares/static.ts` 的 `serveStaticMiddleware`、`checkLoadingAccess` | 段 2 |
| CSS 管线 | `plugins/css.ts` 的 `cssPlugin` / `cssPostPlugin`、`cssAnalysisPlugin` | 段 3 |
| worker / wasm / 静态资源 | `plugins/worker.ts`、`plugins/wasm.ts`、`plugins/asset.ts` | 段 3（`?worker` / `?url` 说明符的产生者） |
| HTML 入口与内联脚本 | `server/middlewares/indexHtml.ts` 的 `devHtmlHook`、`plugins/html.ts` 的 `htmlInlineProxyPlugin` | 段 2 开头 |
| SSR / ModuleRunner | `ssr/fetchModule.ts`、`module-runner/runner.ts`、`ssr/ssrTransform.ts` | 段 3、段 4 |
| 全量打包 dev（bundledDev） | `server/bundledDev.ts`、`client/bundledDevClient.ts` | 段 4、段 5 |
| 插件 API 本身 | `node/plugin.ts` 的 `perEnvironmentPlugin`、`Plugin` 类型 | 段 3 |

## 4. 可以跳过的部分

- `packages/vite/src/node/__tests__/`、各目录下的 `*.spec.ts`：测试辅助，不在主链路。
- `plugins/css.ts`、`plugins/html.ts` 里大量的模板字符串与正则常量：只在你要改这两个插件时读。
- `config.ts` 的绝大部分：除了 `resolveConfig` 的装配段，其余是逐项默认值与兼容判断。
- `preview.ts`、`shortcuts.ts`、`logger.ts`、`deprecations.ts`、`create-vite/`、`plugin-legacy/`：与「请求 → 产物」无关。
- `playground/`：集成测试用例，读某条行为时可以用来对照预期，但不是讲解。
- 注释里凡是写「作者判断」而非「代码事实」的段落，按推断看待。

## 5. 三块外部依赖在图里的位置（本仓不克隆它们的源码）

| 外部件 | 在图里的位置 | 为什么放在这里 |
|---|---|---|
| **rolldown** | ① 生产构建：`build.ts` 的 `buildEnvironment` 里 `await rolldown(rolldownOptions)`；② 依赖预构建：`optimizer/index.ts` 的 `runOptimizeDeps` → `prepareRolldownOptimizerRun` 里的 `rolldown({...})`；③ `plugins/index.ts` 里的 `nativeJsonPlugin` / `nativeAliasPlugin` / `nativeLoadFallbackPlugin` 是 rolldown 自带插件 | 打包算法（tree-shaking、chunk 拆分、代码生成）在这里；Vite 只负责把配置、插件序列、虚拟模块喂进去。dev 阶段**不**调用 rolldown 打包（除非开 bundledDev） |
| **oxc** | `plugins/oxc.ts` 的 `transformWithOxc`（`rolldown/utils` 的 `transformSync`/`transform`）；扫描阶段的 TS 片段转译（`optimizer/scan.ts` 里同样走 oxc）；`pluginContainer` 的 `this.parse` 用 rolldown 的 `parseAst` | 转译是「单文件语法级」操作，发生在 `pluginContainer.transform` 的中间段，不参与模块图；把它放在插件链里，dev 与 build 才能共用同一套转译 |
| **esbuild** | 只剩三处：`build.minify === 'esbuild'` 时的 `buildEsbuildPlugin`；`config.esbuild.banner/footer` 的 `esbuildBannerFooterCompatPlugin`；`optimizeDeps.esbuildOptions.plugins` 经 `pluginConverter.ts` 转换成 rolldown 插件 | 它是历史兼容面，不是主线。读链路时可以整段跳过；只有用户显式配置 `minify: 'esbuild'` 或旧 esbuild 插件时才进入 |

## 6. 已知坑（读的时候会撞上）

- **`server.moduleGraph` / `server.pluginContainer` / `server.hot` 都是兼容代理**：默认转发到 client environment。读代码看到它们时，先确认当前是哪个 environment，否则会误以为「只有一个图」。
- **`transform` 的 `ssr` 标志来自 `environment.config.consumer`**，不是调用方传的。同一个 URL 在 client 与 ssr 下走两条独立管线，缓存也各一份。
- **`transformResult` 的 etag 与 HTTP etag 是同一个值**，但 CSS 的「直接请求」与「被 import」两种身份可能共享同一 etag，缓存中间件因此跳过 CSS。
- **`?t=` 时间戳只在 client 侧用于触发重新请求**；SSR 侧参考它只为记录 `lastHMRTimestamp`，不靠 URL 变化。
- **`soft invalidation` 只改 import 说明符里的时间戳**，前提是「源码结构没变」。它复用上一次的 `transformResult`，所以 `module.transformResult` 在 soft 期间是空的，不要误判为「没缓存」。
- **`optimizeDeps.disabled` / `noDiscovery`** 会让 `depsOptimizer` 为 undefined，此时 `importAnalysis` 不再改写裸依赖，链路在段 3 就分叉到浏览器原生解析（会失败）。读到这里不要以为是 bug。
- **`env.recoverable` 为 false（生产化嵌入）时，关闭/重启期间不抛 `ERR_CLOSED_SERVER`**，请求会排队而不是快速失败——这是两条不同的关闭语义。
- 本仓是 **Vite 8.3.8**：没有 `rollup()` 调用，`rollupVersion` 只是为了插件兼容而存在；任何「rollup 打包」的说法在这里都是过时的。

## 7. 注释索引

本指南配套的源码注释覆盖以下文件（口径：`DENSITY-CALIBER v1` 的 X = 注释行 ÷ 代码行，Y = 去掉空注释行后的同一比值；两列相等说明没有空注释凑数；实测于 2026-11-14，Vite 8.3.8）：

| 文件 | X / Y | 在链路中的角色 |
|---|---|---|
| `cli.ts` | 16.2% / 16.2% | 参数 → InlineConfig 的字典。**密度低是有意的**：445 行代码里大半是一行一个 `.option()`，逐条注释只能是复述 |
| `server/index.ts` | 43.4% / 43.4% | dev server 装配与中间件顺序总表 |
| `server/middlewares/indexHtml.ts` | 50.7% / 50.7% | HTML 入口、`transformIndexHtml` 的 hook 链、内联脚本代理 |
| `server/middlewares/transform.ts` | 39.6% / 39.6% | 一次模块请求的入口与错误码映射 |
| `server/transformRequest.ts` | 41.8% / 41.8% | resolve → load → transform → 缓存 |
| `server/pluginContainer.ts` | 30.0% / 30.0% | 插件 hook 顺序、兼容层、sourcemap 串联 |
| `server/environment.ts` | 41.6% / 41.6% | 每个 environment 的运行时对象 |
| `server/moduleGraph.ts` | 84.5% / 84.5% | 四张索引表与失效语义（代码几乎是纯声明，所以比值高） |
| `server/hmr.ts` | 36.9% / 36.9% | 失效传播与 accept 边界 |
| `server/ws.ts` | 44.5% / 44.5% | HMR 传输层 |
| `plugins/index.ts` | 32.9% / 32.9% | 内置插件顺序 |
| `plugins/importAnalysis.ts` | 54.3% / 54.3% | dev 侧 import 改写 |
| `plugins/importAnalysisBuild.ts` | 30.2% / 30.2% | build 侧 import 改写与 preload |
| `plugins/oxc.ts` | 48.8% / 48.8% | TS/JSX 转译（替代 esbuild） |
| `plugins/resolve.ts` | 67.2% / 67.2% | 内置解析插件组与 `tryNodeResolve` |
| `optimizer/index.ts` | 61.3% / 61.3% | 预构建主流程与缓存失效 |
| `optimizer/scan.ts` | 60.4% / 60.4% | 扫描阶段 |
| `optimizer/optimizer.ts` | 63.3% / 63.3% | 运行期缺依赖发现与重打包 |
| `optimizer/rolldownDepPlugin.ts` | 67.1% / 67.1% | 预构建内部的解析/外部化插件 |
| `optimizer/pluginConverter.ts` | 44.0% / 44.0% | esbuild 插件 → rolldown 插件 |
| `build.ts` | 36.6% / 36.6% | 生产构建编排与 rolldown 调用 |
| `client/client.ts` | 45.3% / 45.3% | 浏览器端 HMR 客户端 |
| `shared/hmr.ts` | 46.0% / 46.0% | 两端共用的 HMR 协议工具 |

合计 23 个文件：注释行 6,845（含上游原有英文注释），代码行 14,649，按口径 X = 46.7%、Y = 46.7%、空注释行 0。本次新增 4,562 行 = 4,540 行整行注释 + 22 行注释块内的空行分段；删除 23 行全部是注释行（代码行删除数 0）。所有文件都与 HEAD 做了「去掉整行注释后逐行比对」，代码完全一致。

未覆盖但可能需要的：`plugins/css.ts`、`plugins/html.ts`、`server/middlewares/static.ts`、`ssr/fetchModule.ts`、`module-runner/*`、`server/bundledDev.ts`。这些文件目前只有上游注释，读它们时请以代码为准。

## 8. 推送到 study 仓时的排除项

推送快照排除了 `.github/workflows/`（上游 CI 配置）：当前 `gh` token 的 scope 只有 `gist / read:org / repo`，没有 `workflow`，含这些文件会被 GitHub 拒绝；它们与本指南的阅读链路无关。除该目录外，源码与 `docs/annotation/` 均按本地提交原样推送。
