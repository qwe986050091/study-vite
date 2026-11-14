// 文件角色（optimizer/rolldownDepPlugin.ts）
// - 链路位置：依赖预构建（optimizeDeps）。optimizer/index.ts 的 prepareRolldownOptimizerRun 组装
//   rolldown({ input: flatIdDeps, plugins }) 时，本文件提供其中两个内置插件：
//   vite:dep-pre-bundle-assets（样式/资产/SFC/wasm 等外部化）与 vite:dep-pre-bundle
//   （裸依赖解析、哨兵模块、new URL(..., import.meta.url) 重写）。
// - 上游：optimizer/index.ts 的 prepareRolldownOptimizerRun —— 它在 push 本插件之前，会先按需
//   push rolldownCjsExternalPlugin（本文件末尾导出，处理 optimizeDeps.exclude 的 require 转换）。
// - 下游：createBackCompatIdResolver（node/idResolver.ts）→ 复用 Vite 的 resolve.alias / browser
//   字段 / exports 条件 / dedupe，而不是 rolldown 的默认解析；PackageCache 由本文件自建。
// - 关键不变量：
//   1) 本文件只产出「虚拟 id 或 external 标记 + 少量生成代码」，真正的文件读取仍由 rolldown 完成；
//   2) require() 进来的非 JS 资产必须转成 ESM（否则产物里保留 require，浏览器不可执行），
//      而 import 进来的同类资产直接 external，不生成任何代码；
//   3) new URL('./x', import.meta.url) 必须重写成相对 cacheDir/deps 的路径，因为产物模块
//      打平后位置已变，原相对路径会指向不存在的文件。
// - 容易误解：这里不做「打包依赖」的编排（入口与 output 在 optimizer/index.ts），也不做通用
//   CJS→ESM 转换（rolldown 负责）；本文件的职责边界是解析结果与模块形态的桥接。
import path from 'node:path'
import MagicString from 'magic-string'
import type { ImportKind, Plugin, RolldownPlugin } from 'rolldown'
import { exactRegex, prefixRegex } from 'rolldown/filter'
import { stripLiteral } from 'strip-literal'
import { cleanUrl, isWindows } from '../../shared/utils'
import { JS_TYPES_RE, KNOWN_ASSET_TYPES } from '../constants'
import type { Environment } from '../environment'
import { createBackCompatIdResolver } from '../idResolver'
import type { PackageCache } from '../packages'
import { assetImportMetaUrlRE } from '../plugins/assetImportMetaUrl'
import { isModuleCSSRequest } from '../plugins/css'
import { hasViteIgnoreRE } from '../plugins/importAnalysis'
import { browserExternalId, optionalPeerDepId } from '../plugins/resolve'
import {
  escapeRegex,
  flattenId,
  isBuiltin,
  isCSSRequest,
  isDataUrl,
  isExternalUrl,
  isNodeBuiltin,
  moduleListContains,
  normalizePath,
} from '../utils'
// 成对使用的虚拟 id 前缀，配合 vite:dep-pre-bundle-assets 的 resolveId/load 完成
// 「require(资产) → ESM 再导出」的三步转换：
//   1) resolveId 把 require('./a.png') 解析成 externalWithConversionNamespace + 绝对路径；
//   2) load 生成 `export { default } from "vite-dep-pre-bundle-external:<绝对路径>"`；
//   3) rolldown 再解析这条 import，命中 convertedExternalPrefix 分支后归还
//      { id: 绝对路径, external: 'absolute' }，于是资源以 import 形式留在产物里。
// 两个前缀只在本文件内产生与消费，不会出现在最终产物的模块标识里。
const externalWithConversionNamespace =
  'vite:dep-pre-bundle:external-conversion'
const convertedExternalPrefix = 'vite-dep-pre-bundle-external:'

// rolldownCjsExternalPlugin 使用的 facade 命名空间与「非 facade」回退前缀：
// - cjsExternalFacadeNamespace 包住的是「被 require 的外部依赖」，load 出保持 CJS 形状的包装模块；
// - nonFacadePrefix 是包装内部真正的 import 目标，resolveId 收到它时立刻摘前缀并 external，
//   否则 facade 会把自己再包一层，形成无限递归。
const cjsExternalFacadeNamespace = 'vite:cjs-external-facade'
const nonFacadePrefix = 'vite-cjs-external-facade:'

// 预构建阶段要「外部化」的扩展名：这些形态不能交给 rolldown 打包进 deps chunk，
// 必须保留为独立请求，由 dev 中间件按 URL 处理（CSS 注入、资源返回 URL、SFC 交给各自插件）。
// 三个容易疑惑的点：
// - jsx/tsx 是 JS，但仍不打包：它们可能依赖用户的编译器配置（automatic runtime、pragma、
//   tsconfig 的 jsxImportSource 等），预构建侧的 oxc transform 无法复刻，打包会得到错误语义
//   （下方保留的上游英文注释是 esbuild 时代写的，结论在 oxc 内核下同样成立）；
// - vue/svelte/marko/astro/imba 需要各自的 SFC 插件编译，预构建内部没有这些插件；
// - ...KNOWN_ASSET_TYPES 是纯静态资源，只要 URL 正确即可，内容无需被解析。
const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'styl',
  'stylus',
  'pcss',
  'postcss',
  // wasm
  'wasm',
  // known SFC types
  'vue',
  'svelte',
  'marko',
  'astro',
  'imba',
  // JSX/TSX may be configured to be compiled differently from how esbuild
  // handles it by default, so exclude them as well
  'jsx',
  'tsx',
  ...KNOWN_ASSET_TYPES,
]

// 两个哨兵模块命名空间，由下方的 load 生成「运行时报错」或「保底空模块」：
// - optional-peer-dep: 对应 plugins/resolve.ts 里 `${optionalPeerDepId}:${id}:${mainPkg}` 的解析结果，
//   把「未安装的可选 peer」推迟到真正 import 时才抛错，依赖作者的 try/catch 降级路径才得以保留；
// - browser-external: 对应 client 环境把 node 内置模块解析成 `__vite-browser-external:<id>` 的情况，
//   在 dev 里换成可告警的 Proxy 空模块（精确的 browserExternalId 则是显式空模块，不告警）。
const optionalPeerDepNamespace = 'optional-peer-dep:'
const browserExternalNamespace = 'browser-external:'

// 作用：为一次依赖预构建产出两个内置 rolldown 插件（资产外部化 + 依赖解析/哨兵/URL 重写）。
// 调用点：optimizer/index.ts 的 prepareRolldownOptimizerRun，`plugins.push(...rolldownDepPlugin(environment, flatIdDeps, external))`。
// 关键参数：
//   environment —— 提供 resolve 配置、optimizeDeps.extensions、cacheDir、mode，并传给 Vite 解析器；
//   qualified —— Record<flattenId(id), 真实入口文件路径>，即 rolldown input 的 key → src 映射；
//   external —— optimizeDeps.exclude，命中即视为外部依赖，不参与打包。
// 失败模式：本函数自身不抛错；解析失败时 resolveId 返回 undefined，由 rolldown 报
//   "Could not resolve" 并让本次预构建失败（上层据此重试/打印错误），不会静默产出坏包。
export function rolldownDepPlugin(
  environment: Environment,
  qualified: Record<string, string>,
  external: string[],
): RolldownPlugin[] {
  const { isProduction } = environment.config
  const { extensions } = environment.config.optimizeDeps

  // remove optimizable extensions from `externalTypes` list
  // optimizeDeps.extensions 里声明的扩展名表示「要参与预构建」（例如 '.vue'），
  // 因此必须从外部化列表剔除对应项，否则用户加了 extensions 也仍被外部化，配置形同虚设。
  const allExternalTypes = extensions
    ? externalTypes.filter((type) => !extensions.includes('.' + type))
    : externalTypes

  // use separate package cache for optimizer as it caches paths around node_modules
  // and it's unlikely for the core Vite process to traverse into node_modules again
  // 两个 cache 必须分开：同一个包在 import 条件与 require 条件下可能命中不同入口
  // （exports 的 import/require 分支、module/main 字段），共用一个会串味。
  // buildEnd 时统一 clear，避免跨构建复用过期路径。
  const esmPackageCache: PackageCache = new Map()
  const cjsPackageCache: PackageCache = new Map()

  // 作用：把「非 JS 资产」的解析结果转成 rolldown 能理解的模块形态。
  // 三个分支的差异是这里最容易被读错的地方：
  // - require-call 不能标 external，否则产物里会留着 require()（浏览器没有 require）；
  //   改用虚拟 id，交给下方 load 生成 ESM 再导出，从而在产物里变成静态 import；
  // - import / import-dynamic 直接 external:'absolute'：资源不需要进包，路径原样保留；
  // - 其余 kind（如 require-resolve）同样按外部路径处理。
  const resolveAssets = (resolved: string, kind: ImportKind) => {
    if (kind === 'require-call') {
      // here it is not set to `external: true` to convert `require` to `import`
      return {
        id: externalWithConversionNamespace + resolved,
      }
    }
    return {
      id: resolved,
      external: 'absolute' as const,
    }
  }

  // 两个解析器都是 Vite resolver 的包装，不是 rolldown 的默认解析：因此 alias、browser 字段、
  // dedupe、exports conditions 与主链路一致。asSrc:false 表示按「依赖」而非「源码」解析，
  // scan:true 放宽严格性，让未安装的可选 peer 能落到下面的哨兵分支，而不是直接抛错。
  // default resolver which prefers ESM
  const _resolve = createBackCompatIdResolver(environment.getTopLevelConfig(), {
    asSrc: false,
    scan: true,
    packageCache: esmPackageCache,
  })

  // require 侧解析器：isRequire:true 让 exports 走 require 条件、mainFields 偏向 main，
  // 与 Node 的 require 行为对齐（_resolve 偏 ESM）。两者共用调用方传入的 environment。
  // cjs resolver that prefers Node
  const _resolveRequire = createBackCompatIdResolver(
    environment.getTopLevelConfig(),
    {
      asSrc: false,
      isRequire: true,
      scan: true,
      packageCache: cjsPackageCache,
    },
  )

  // 作用：统一解析入口，并在解析前把 importer 从「虚拟入口 id」翻译回真实文件路径。
  // 为什么必须翻译：rolldown 传给 resolveId 的 importer 可能是 input 的 key（flattenId 后的名字，
  // 例如 `pkg__name`），而不是磁盘路径；拿它当基准解析相对 import 会以错误目录为起点。
  // 解析器选择：kind 以 'require' 开头（require-call / require-resolve）才走 CJS 语义。
  // 失败模式：返回 undefined，由调用方决定是外部化还是交给 rolldown 报错。
  const resolve = (
    id: string,
    importer: string | undefined,
    kind: ImportKind,
  ): Promise<string | undefined> => {
    // map importer ids to file paths for correct resolution
    const _importer =
      importer && importer in qualified ? qualified[importer] : importer
    const resolver = kind.startsWith('require') ? _resolveRequire : _resolve
    return resolver(environment, id, _importer)
  }

  // 作用：把 Vite resolver 的结果翻译成 rolldown 的 resolveId 返回值（判断顺序本身有语义）。
  // 顺序的理由：
  //   1) 精确的 browserExternalId 是 package.json browser 字段显式 false 的映射，
  //      语义是「空模块且不告警」，必须最先短路；
  //   2) 带后缀的 browserExternalId（client 环境下 node 内置模块）要换成 browser-external:
  //      虚拟模块 —— dev 用 Proxy 告警，不能当空模块静默吞掉；
  //   3) optional peer 哨兵换成虚拟模块，把报错推迟到真正 import 的时刻；
  //   4) 扩展名命中 externalTypes 的走 resolveAssets（require 还需转换）；
  //   5) 内置模块返回 undefined —— 不在此处改写，交给后续插件与 rolldown 的 platform 逻辑处理；
  //   6) http(s)/data 等外部 URL 不再解析；最后才用 path.resolve 兜底。
  const resolveResult = (id: string, resolved: string, kind: ImportKind) => {
    // An exact browser-external id is an explicit browser:false mapping.
    // Suffixed ids are unsupported Node builtins and still need the warning.
    if (resolved === browserExternalId) {
      return { id: browserExternalId }
    }
    if (resolved.startsWith(browserExternalId)) {
      return {
        id: browserExternalNamespace + id,
      }
    }
    if (resolved.startsWith(optionalPeerDepId)) {
      return {
        id: optionalPeerDepNamespace + resolved,
      }
    }
    if (allExternalTypesReg.test(resolved)) {
      return resolveAssets(resolved, kind)
    }
    if (isBuiltin(environment.config.resolve.builtins, resolved)) {
      return
    }
    if (isExternalUrl(resolved)) {
      return {
        id: resolved,
        external: 'absolute',
      }
    }
    return {
      id: path.resolve(resolved),
    }
  }

  // 该正则允许尾随查询串（?url / ?inline / ?raw 等），保证带 query 的资产同样被外部化。
  // 注意它定义在 resolveResult 之后才初始化，但 resolveResult 只会在 rolldown 调用 hook 时执行，
  // 那时模块顶层已求值完成，不存在 TDZ 问题；不要为了「看起来更早」而重复 new RegExp。
  const allExternalTypesReg = new RegExp(
    `\\.(?:` + allExternalTypes.join('|') + `)(\\?.*)?$`,
  )

  // 作用：把「入口 id」映射回 rolldown 的虚拟入口 id（即 qualified 的 key）。
  // 为什么需要：input 的 key 是 flattenId(id)，rolldown 回传的入口 id 可能是原始包名或 alias 结果，
  // 不翻译就会被当成普通依赖再解析一次，导致入口代码被重复打进 chunk 或解析到别处。
  // 失败模式：不在 qualified 中时返回 undefined，调用方随后会尝试 alias 解析（见下方 resolveId）。
  function resolveEntry(id: string) {
    const flatId = flattenId(id)
    if (flatId in qualified) {
      return {
        id: qualified[flatId],
      }
    }
  }

  // 预构建产物目录（cacheDir/deps），也是 dev 下 /@vite/deps/ 的真实来源；
  // 下面 transform 里 new URL() 的相对路径必须相对它计算，因为打包后的模块就落在这里。
  const bundleOutputDir = path.join(environment.config.cacheDir, 'deps')

  return [
    {
      name: 'vite:dep-pre-bundle-assets',
      // 职责边界：只处理「扩展名命中 allExternalTypesReg」的 id；普通 JS 依赖的解析归下一个插件。
      // resolveId 与 load 成对出现：先判定外部化形态，再为 require 转 import 生成虚拟模块；
      // 任何一方单独看都会误解另一半（虚拟 id 的消费点只在 load 的 filter 里）。
      // externalize assets and commonly known non-js file types
      // See #8459 for more details about this require-import conversion
      resolveId: {
        filter: { id: allExternalTypesReg },
        async handler(id, importer, options) {
          const kind = options.kind
          // if the prefix exist, it is already converted to `import`, so set `external: true`
          // 这条分支是 load 生成的再导出 import 回到解析器：必须摘前缀、归还真实路径并标 external，
          // 否则会再次进入 require 转换，形成「转换 → 生成 import → 再转换」的循环。
          if (id.startsWith(convertedExternalPrefix)) {
            return {
              id: id.slice(convertedExternalPrefix.length),
              external: 'absolute',
            }
          }

          // 解析失败返回 undefined：rolldown 会继续问下一个插件，最终由它报错。
          // 这里的 filter 只保证「id 长得像资产」，不代表一定能解析到文件（可能是包名或缺失资源）。
          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            // `resolved` can be javascript even when `id` matches `allExternalTypes`
            // due to cjs resolution (e.g. require("./test.pdf") for "./test.pdf.js")
            // or package name (e.g. import "some-package.pdf")
            // 所以外部化前必须再用 JS_TYPES_RE 复核真实解析结果：解析后是 JS 就要交回 rolldown
            // 打包（external:false），否则会把一个 JS 文件当成静态资源留在外部。
            if (JS_TYPES_RE.test(resolved)) {
              return {
                // normalize to \\ on windows for esbuild/rolldown behavior difference: https://github.com/sapphi-red-repros/rolldown-esbuild-path-normalization
                // rolldown 在 Windows 上按反斜杠匹配模块标识；不归一化会让同一文件出现两个模块实例。
                id: isWindows ? resolved.replaceAll('/', '\\') : resolved,
                external: false,
              }
            }
            return resolveAssets(resolved, kind)
          }
        },
      },
      load: {
        filter: {
          // 只接管本文件产生的转换 id；其他模块的 load 完全不受影响。
          id: prefixRegex(externalWithConversionNamespace),
        },
        // 作用：为 require 转换出来的虚拟模块生成 ESM 源码（rolldown 内部模块只接受 ESM）。
        // 两个分支的差异：CSS Modules 需要 default/named 导出，调用方才能 `styles.foo`；
        // 普通 CSS 只要副作用（纯 import），额外导出 default 反而会引入无效绑定。
        // 路径用 JSON.stringify 拼接，避免 Windows 反斜杠或引号破坏生成代码。
        handler(id) {
          const path = id.slice(externalWithConversionNamespace.length)
          // import itself with prefix (this is the actual part of require-import conversion)
          const modulePath = JSON.stringify(`${convertedExternalPrefix}${path}`)
          return {
            code:
              isCSSRequest(path) && !isModuleCSSRequest(path)
                ? `import ${modulePath};`
                : `export { default } from ${modulePath};` +
                  `export * from ${modulePath};`,
          }
        },
      },
    },
    {
      // 职责边界：处理所有「裸依赖 / #subpath / @scope 包」的解析，具体分四件事：
      //   1) 入口 id 回填为真实文件路径；2) optimizeDeps.exclude 命中即外部化；
      //   3) 产出浏览器外部/可选 peer 的哨兵模块；4) 重写 new URL(..., import.meta.url)。
      // 不负责：扩展名资产（上一个插件）、exclude 依赖的 require 转 ESM（rolldownCjsExternalPlugin）。
      name: 'vite:dep-pre-bundle',
      // clear package cache when build is finished
      // 缓存只在单次构建内有效：依赖文件可能被改写、optimizeDeps 会重跑，
      // 不清理会拿到上一次构建的入口路径（尤其是切换条件导出时）。
      buildEnd() {
        esmPackageCache.clear()
        cjsPackageCache.clear()
      },
      resolveId: {
        // 只接管「裸模块」：首字符为 # / 字母数字下划线 / @，且第二字符不是 ':'。
        // 于是 node:fs、vite:xxx 等带协议的 id 与 Windows 盘符路径（C:\...）不会被劫持，
        // './'、'../'、'/' 开头的路径也不进入，文件解析仍由 rolldown 自己完成。
        filter: { id: /^[#\w@][^:]/ },
        async handler(id, importer, options) {
          const kind = options.kind

          // optimizeDeps.exclude 命中（moduleListContains 同时匹配子路径）→ 不解析、不打包；
          // external:'absolute' 表示 id 原样保留，后续是否可解析由使用该产物的链路负责。
          if (moduleListContains(external, id)) {
            return {
              id: id,
              external: 'absolute',
            }
          }

          // ensure rolldown uses our resolved entries
          let entry: { id: string } | undefined
          // if this is an entry, return entry namespace resolve result
          // importer 为空 = rolldown 在解析入口。这里必须返回真实文件路径且不能标 external，
          // 否则入口不会被真正打包（预构建结果就是空的）。
          if (!importer) {
            if ((entry = resolveEntry(id))) return entry
            // check if this is aliased to an entry - also return entry namespace
            // 入口可能写成 alias（optimizeDeps.entries / 配置里的 alias），先只做 alias 解析
            // （第四个参数 aliasOnly=true，不触发完整的包解析）再回查 qualified。
            const aliased = await _resolve(environment, id, undefined, true)
            if (aliased && (entry = resolveEntry(aliased))) {
              return entry
            }
          }

          // use vite's own resolver
          // 解析成功才交给 resolveResult 决定模块形态；返回 undefined 时 rolldown 会继续
          // 询问后续插件，最终仍解析不到才报 "Could not resolve"。
          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            return resolveResult(id, resolved, kind)
          }
        },
      },
      load: {
        // 三类哨兵 id 的生成点都在上面的 resolveResult：这里只负责给它们「内容」。
        // exactRegex 与 prefixRegex 的区别很重要：精确 id 是显式空模块，
        // 带前缀的是「需要告警/抛错的占位模块」，两者语义不同不能合并。
        filter: {
          id: [
            exactRegex(browserExternalId),
            prefixRegex(browserExternalNamespace),
            prefixRegex(optionalPeerDepNamespace),
          ],
        },
        handler(id) {
          if (id === browserExternalId) {
            // package.json 的 browser 字段显式写成 false：作者意图就是「这个模块在浏览器里不存在」，
            // 因此给空对象即可，不需要打扰用户。
            return { code: 'module.exports = {}' }
          }
          if (id.startsWith(browserExternalNamespace)) {
            const path = id.slice(browserExternalNamespace.length)
            if (isProduction) {
              // 生产构建只留空对象：告警代码没有调试价值，不应进入最终产物。
              return {
                code: 'module.exports = {}',
              }
            } else {
              // dev 下用 Proxy 拦截任意属性读取并 console.warn，帮助定位
              // 「为什么这里拿到 undefined」。注意仍导出 CJS（module.exports），
              // 以便 rolldown 的 CJS→ESM 互操作能对命名导入做拦截（下方英文注释解释了这个约束）。
              return {
                // Return in CJS to intercept named imports. Use `Object.create` to
                // create the Proxy in the prototype to workaround esbuild issue. Why?
                // In short, esbuild cjs->esm flow:
                // 1. Create empty object using `Object.create(Object.getPrototypeOf(module.exports))`.
                // 2. Assign props of `module.exports` to the object.
                // 3. Return object for ESM use.
                // If we do `module.exports = new Proxy({}, {})`, step 1 returns empty object,
                // step 2 does nothing as there's no props for `module.exports`. The final object
                // is just an empty object.
                // Creating the Proxy in the prototype satisfies step 1 immediately, which means
                // the returned object is a Proxy that we can intercept.
                // Note: Skip keys that are accessed by esbuild and browser devtools.
                code: `\
    module.exports = Object.create(new Proxy({}, {
        get(_, key) {
        if (
            key !== '__esModule' &&
            key !== '__proto__' &&
            key !== 'constructor' &&
            key !== 'splice'
        ) {
            const path = ${JSON.stringify(path)}
            console.warn(\`Module "\${path}" has been externalized for browser compatibility. Cannot access "\${path}.\${key}" in client code. See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
        }
        }
    }))`,
              }
            }
          }

          if (id.startsWith(optionalPeerDepNamespace)) {
            const path = id.slice(optionalPeerDepNamespace.length)
            // 路径格式为 `<peerDep>:<parentDep>`（由 resolve.ts 拼成 `${id}:${mainPkg.name}`，
            // 前缀冒号已被 slice 掉）。parentDep 用于告诉用户是哪个包引入了这个缺失的 peer。
            const [, peerDep, parentDep] = path.split(':')
            return {
              code:
                'module.exports = {};' +
                `const peerDep = ${JSON.stringify(peerDep)};` +
                `const parentDep = ${JSON.stringify(parentDep)};` +
                `throw new Error(\`Could not resolve "\${peerDep}" imported by "\${parentDep}". Is it installed?\`)`,
            }
          }
        },
      },
      transform: {
        // 作用：把依赖源码里的 `new URL('./rel', import.meta.url)` 改写成
        // `new URL('' + '<相对 cacheDir/deps 的路径>', import.meta.url)`。
        // 为什么必须改写：原相对路径以「源码文件」为基准，打包后模块位置变成 deps/chunk-*.js，
        // 不改写会指向不存在的资源。
        // 仍复用主插件 assetImportMetaUrlRE 的匹配规则，保证预构建与 dev 的识别范围一致。
        filter: {
          code: assetImportMetaUrlRE,
        },
        handler(code, id) {
          let s: MagicString | undefined
          // assetImportMetaUrlRE 带 g 标志且有状态（lastIndex），每次处理必须新建实例，
          // 否则会从上次匹配位置继续，导致后续模块漏改写。
          const re = new RegExp(assetImportMetaUrlRE)
          // stripLiteral 把字符串/注释/模板字面量的内容抹成空白但保持长度不变，
          // 这样：1) 字符串里出现的 `new URL(...)` 文本不会被误改；2) match.indices
          // 仍可直接用于原始 code 的切片与替换。
          const cleanString = stripLiteral(code)

          let match: RegExpExecArray | null
          while ((match = re.exec(cleanString))) {
            const [[startIndex, endIndex], [urlStart, urlEnd]] =
              match.indices as Array<[number, number]>
            // `/* @vite-ignore */` 可以让用户跳过改写；检查范围是「new URL(」到 URL 字面量之间，
            // 与 plugins/assetImportMetaUrl.ts 的判定范围保持一致。
            if (hasViteIgnoreRE.test(code.slice(startIndex, urlStart))) continue

            const rawUrl = code.slice(urlStart, urlEnd)

            if (rawUrl[0] === '`' && rawUrl.includes('${')) {
              // We skip dynamic template strings in the optimizer for now as they
              // require complex glob transformation that is handled by the main asset plugin.
              // 动态模板等价于 glob 语义，预构建无法静态展开，留给主 asset 插件在 dev 请求时处理。
              continue
            }

            const url = rawUrl.slice(1, -1)
            // data:/http(s): 自包含，以 / 开头的是 public 路径：都不依赖模块位置，无需改写。
            if (isDataUrl(url) || isExternalUrl(url) || url.startsWith('/')) {
              continue
            }

            if (!s) s = new MagicString(code)

            // we resolve the relative path from the original library file (id) and
            // then rewrite it relative to the bundle (deps) directory.
            // 基准是「原始库文件 id 所在目录」，不是 importer 也不是 cwd：id 才是这条 transform
            // 正在处理的文件，其相对路径只对它自己有意义。
            const absolutePath = path.resolve(path.dirname(id), url)
            if (environment.mode === 'dev') {
              // dev 下该资源会被请求为 /@fs/<绝对路径>；必须登记进 safeModulePaths，
              // 否则静态文件服务（server/middlewares/static.ts）的 fs.allow 校验会拒绝访问
              // （生产构建没有这个概念）。
              // cleanUrl 去掉可能的 ?query，normalizePath 统一成正斜杠。
              environment.safeModulePaths.add(
                normalizePath(cleanUrl(absolutePath)),
              )
            }
            // 产物模块位于 bundleOutputDir 下，因此相对路径要以产物目录为基准重新计算；
            // 这样 cacheDir 迁移或换机器时路径依然成立。
            const relativePath = path.relative(bundleOutputDir, absolutePath)
            const normalizedRelativePath = normalizePath(relativePath)
            s.update(
              startIndex,
              endIndex,
              // NOTE: add `'' +` to opt-out rolldown's transform: https://github.com/rolldown/rolldown/issues/2745
              // 让第一个参数不是「纯字面量」，从而跳过 rolldown 对 new URL(字面量, import.meta.url)
              // 的资产识别与再改写（那会与这里的预构建产物目录语义冲突）。
              `new URL('' + ${JSON.stringify(
                normalizedRelativePath,
              )}, import.meta.url)`,
            )
          }

          // 没有命中任何一处就不返回（undefined），避免无谓的 sourcemap 与全量替换。
          if (s) {
            return {
              code: s.toString(),
              // hires:'boundary' 只在字符边界生成映射，既保持 map 精度又不至于逐字符膨胀。
              map: s.generateMap({ hires: 'boundary' }),
            }
          }
        },
      },
    },
  ]
}

// 把每个 exclude 名字包成整行锚定的正则片段（escapeRegex 先转义元字符）。
// 用 `^...$` 而不是前缀匹配：exclude 声明 'lodash' 不会连带命中 'lodash/fp'，
// 子路径必须显式声明，避免误伤同名前缀的包。
const matchesEntireLine = (text: string) => `^${escapeRegex(text)}$`

// 作用：仅针对 platform==='browser' 的预构建，把「被 require 的 exclude 依赖」转成 ESM import，
//   并用 CJS facade 保持 module.exports 形状（浏览器没有 require，直接 external 会留下不可执行代码）。
// 调用点：optimizer/index.ts 的 prepareRolldownOptimizerRun，
//   `plugins.push(rolldownCjsExternalPlugin(external, platform, environment))`，仅在 external.length > 0 时调用，
//   且位置在 rolldownDepPlugin 之前（先外部化，再谈解析）。
// 关键参数：externals = optimizeDeps.exclude（精确匹配）；platform 决定启用与否；
//   environment 用于构造 require 语义的 resolver（与预构建其它解析保持一致）。
// 失败模式：require 解析异常被 catch 成 undefined（被排除的依赖可能要到运行时才可解析）；
//   只有确认是可选 peer 时才返回抛错哨兵，其余一律 facade，把错误推迟到实际执行时暴露。
// rolldown (and esbuild) doesn't transpile `require('foo')` into `import` statements if 'foo' is externalized
// https://rolldown.rs/in-depth/bundling-cjs#require-external-modules
export function rolldownCjsExternalPlugin(
  externals: string[],
  platform: 'node' | 'browser' | 'neutral',
  environment: Environment,
): Plugin | undefined {
  // Skip this plugin for `platform: 'node'` as `require` is available in Node
  // and that is more accurate than converting to `import`
  // node 平台保留原始 require：运行时可用，且比转 import 更贴近包作者的条件分支意图。
  if (platform === 'node') {
    return undefined
  }
  // Skip this plugin for `platform: 'neutral'` as we are not sure whether `require` is available
  // neutral 无法确定宿主是否有 require，宁可不转换（最坏情况是运行时自行报缺 require）。
  if (platform === 'neutral') {
    return undefined
  }

  // Apply this plugin for `platform: 'browser'` as `require` is not available in browser and
  // converting to `import` would be necessary to make the code work
  // 纯类型收窄，运行时不产生任何代码：此后 platform 一定是 'browser'。
  platform satisfies 'browser'

  // 只匹配 externals 中的精确 id（见 matchesEntireLine）。注意它同时用于 resolveId.filter，
  // 因此 `require('excluded/sub')` 若未在 exclude 中显式声明，不会进入本插件。
  const filter = new RegExp(externals.map(matchesEntireLine).join('|'))

  const packageCache: PackageCache = new Map()
  const resolveRequire = createBackCompatIdResolver(
    environment.getTopLevelConfig(),
    { asSrc: false, isRequire: true, scan: true, packageCache },
  )

  return {
    name: 'cjs-external',
    // 职责边界：只处理 exclude 依赖的 require 转换与 facade 还原；
    // 普通依赖解析仍归 vite:dep-pre-bundle，二者靠 filter 的 id 集合区分。
    resolveId: {
      // 两个入口：
      // - nonFacadePrefix：facade 内部生成的 import 回来时必须先摘前缀，否则会被再次包 facade；
      // - filter：exclude 的精确 id，只有 require 它们才需要转换（见下方 kind 判断）。
      filter: { id: [prefixRegex(nonFacadePrefix), filter] },
      async handler(id, importer, options) {
        if (id.startsWith(nonFacadePrefix)) {
          // 摘掉前缀后标 external：这个 id 就是外部依赖名（或 node 内置模块名），
          // 成品里保留为真实 import，由运行时/宿主解析。
          return {
            id: id.slice(nonFacadePrefix.length),
            external: 'absolute',
          }
        }
        if (options.kind === 'require-call') {
          // A missing optional peer must throw when require() runs, not when
          // an eager ESM facade is evaluated. Reuse the pre-bundler's CJS stub
          // so the dependency's try/catch can still select its fallback.
          // Other excluded deps may intentionally be unresolvable until served.
          // catch 吞掉解析异常是有意的：exclude 的依赖可能是尚未生成的虚拟模块；
          // 只有能确认是 optional peer 时才需要抛错哨兵，其余情况一律 facade。
          const resolved = await resolveRequire(
            environment,
            id,
            importer,
          ).catch(() => undefined)
          if (resolved?.startsWith(optionalPeerDepId)) {
            // 复用预构建的抛错桩（optional-peer-dep:）：延迟到 require 执行时才抛，
            // 这样依赖自己的 try/catch 仍能选到 fallback 实现。
            return { id: optionalPeerDepNamespace + resolved }
          }
          // 返回 facade 虚拟 id，由下方 load 生成「ESM import + module.exports」包装。
          return {
            id: cjsExternalFacadeNamespace + id,
          }
        }
        // 非 require 调用（import / import-dynamic 等）：本来就有 ESM 语义，
        // 直接外部化即可，不做任何包装。
        return {
          id,
          external: 'absolute',
        }
      },
    },
    // 作用：生成 CJS facade 的源码 —— 先用 ESM import 拿到外部模块的命名空间，
    // 再挂回 module.exports，使原来的 require() 调用点在浏览器里也能工作。
    // 为什么必须包一层：require 与 import 的模块形态不同（前者要 module.exports 对象），
    // 单纯改写成 import 会让调用方拿不到期望的导出形状。
    load: {
      filter: { id: prefixRegex(cjsExternalFacadeNamespace) },
      handler(id) {
        const idWithoutNamespace = id.slice(cjsExternalFacadeNamespace.length)
        return {
          // 内置模块用 m.default：rolldown 对 node 内置模块做 CJS interop 时把导出放在 default 上，
          // 展开 `{ ...m }` 会丢掉函数/方法绑定（如 fs 的 API）；
          // 普通包用 `{ ...m }` 复制命名空间，保持命名导入可用。
          code: `\
import * as m from ${JSON.stringify(nonFacadePrefix + idWithoutNamespace)};
module.exports = ${isNodeBuiltin(idWithoutNamespace) ? 'm.default' : '{ ...m }'};
`,
        }
      },
    },
  }
}
