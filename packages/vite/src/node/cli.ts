import fs from 'node:fs'
// ============================================================================
// 文件角色：命令行入口（bin/vite.js → 本文件）。

// 它只做三件事：解析参数 → 组装 InlineConfig → 调 API。
// 真正的逻辑都在被调方：
//   dev     → createServer（server/index.ts）→ resolveConfig（config.ts）
//   build   → createBuilder + builder.buildApp（build.ts）
//   optimize→ resolveConfig + optimizeDeps（optimizer/index.ts，已废弃）
//   preview → preview（preview.ts）

// 读链路时可以把它当「参数 → 配置字段」的字典：想知道某个 CLI flag 最终
// 落到哪个 config 字段，来这里查；不要指望在这里看到模块处理逻辑。
// ============================================================================
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { inspect } from 'node:util'
import { cac } from 'cac'
import colors from 'picocolors'
import { createBuilder } from './build'
import type { BuildEnvironmentOptions } from './build'
import { commandLockPlugin, createCommandLock } from './commandLock'
import type { InlineConfig } from './config'
import { VERSION } from './constants'
import type { LogLevel } from './logger'
import { createLogger } from './logger'
import type { ServerOptions } from './server'
import type { CLIShortcut } from './shortcuts'

function checkNodeVersion(nodeVersion: string): boolean {
  // Node 版本门槛。低于门槛只警告不退出：
  // 让用户至少能看到「为什么报错」，而不是一个语焉不详的启动失败。
  const currentVersion = nodeVersion.split('.')
  const major = parseInt(currentVersion[0], 10)
  const minor = parseInt(currentVersion[1], 10)
  const isSupported =
    // 支持范围：20.19+ / 22.12+ / 23+。
    // 之所以卡到 minor：这两个 minor 才带 import.meta.dirname 等本仓依赖的能力。
    (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22
  return isSupported
}

if (!checkNodeVersion(process.versions.node)) {
  // eslint-disable-next-line no-console
  console.warn(
    colors.yellow(
      `You are using Node.js ${process.versions.node}. ` +
        `Vite requires Node.js version 20.19+ or 22.12+. ` +
        `Please upgrade your Node.js version.`,
    ),
  )
}

const cli = cac('vite')
// cac 是参数解析器（不是 commander/yargs）。全局 option 与命令 option 分开注册，
// 命令 action 里再合并成 InlineConfig。

// global options
interface GlobalCLIOptions {
  '--'?: string[]
  c?: boolean | string
  config?: string
  base?: string
  l?: LogLevel
  logLevel?: LogLevel
  clearScreen?: boolean
  configLoader?: 'bundle' | 'runner' | 'native'
  profile?: boolean | string
  d?: boolean | string
  debug?: boolean | string
  f?: string
  filter?: string
  m?: string
  mode?: string
  bypassLock?: boolean
  force?: boolean
  w?: boolean
}

interface ExperimentalDevOptions {
  experimentalBundle?: boolean
}

interface BuilderCLIOptions {
  app?: boolean
}

let profileSession = global.__vite_profile_session
let profileCount = 0

export const stopProfiler = (
  log: (message: string) => void,
): void | Promise<void> => {
  if (!profileSession) return
  return new Promise((res, rej) => {
    profileSession!.post('Profiler.stop', (err, { profile }) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const name = global.__vite_profile_name ?? 'vite-profile'
        const count = profileCount++
        const fileName = count === 0 ? name : `${name}-${count}`
        const outPath = path.resolve(`./${fileName}.cpuprofile`)
        fs.writeFileSync(outPath, JSON.stringify(profile))
        log(
          colors.yellow(
            `CPU profile written to ${colors.white(colors.dim(outPath))}`,
          ),
        )
        profileSession = undefined
        res()
      } else {
        rej(err)
      }
    })
  })
}

const filterDuplicateOptions = <T extends object>(options: T) => {
  // cac 对重复传入的选项会收集成数组（例如 --host a --host b），
  // 这里统一取最后一个，符合「命令行后者覆盖前者」的直觉。
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      options[key as keyof T] = value.at(-1)
    }
  }
}
/**
 * removing global flags before passing as command specific sub-configs
 */
  // 把全局 flag 从 options 里摘掉再传给 server/build：
  // 否则 server.cleanGlobalCLIOptions 之后的对象里会混进 --config/--mode 这类
  // 已经由 InlineConfig 顶层字段消费过的键，触发配置校验告警。
function cleanGlobalCLIOptions<Options extends GlobalCLIOptions>(
  options: Options,
): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options }
  delete ret['--']
  delete ret.c
  delete ret.config
  delete ret.base
  delete ret.l
  delete ret.logLevel
  delete ret.clearScreen
  delete ret.configLoader
  delete ret.profile
  delete ret.d
  delete ret.debug
  delete ret.f
  delete ret.filter
  delete ret.m
  delete ret.mode
  delete ret.bypassLock
  delete ret.force
  delete ret.w

  // convert the sourcemap option to a boolean if necessary
  if ('sourcemap' in ret) {
    const sourcemap = ret.sourcemap as `${boolean}` | 'inline' | 'hidden'
    ret.sourcemap =
      sourcemap === 'true'
        ? true
        : sourcemap === 'false'
          ? false
          : ret.sourcemap
  }
  if ('watch' in ret) {
    const watch = ret.watch
    ret.watch = watch ? {} : undefined
  }

  return ret
}

/**
 * removing builder flags before passing as command specific sub-configs
 */
function cleanBuilderCLIOptions<Options extends BuilderCLIOptions>(
  options: Options,
): Omit<Options, keyof BuilderCLIOptions> {
  const ret = { ...options }
  delete ret.app
  return ret
}

/**
 * host may be a number (like 0), should convert to string
 */
const convertHost = (v: any) => {
  if (typeof v === 'number') {
    return String(v)
  }
  return v
}

/**
 * base may be a number (like 0), should convert to empty string
 */
const convertBase = (v: any) => {
  if (v === 0) {
    return ''
  }
  return v
}

cli
  .option('-c, --config <file>', `[string] use specified config file`)
  .option('--base <path>', `[string] public base path (default: /)`, {
    type: [convertBase],
  })
  .option('-l, --logLevel <level>', `[string] info | warn | error | silent`)
  .option('--clearScreen', `[boolean] allow/disable clear screen when logging`)
  .option(
    '--configLoader <loader>',
    `[string] use 'bundle' to bundle the config with Rolldown, or 'native' to load using the native runtime (default: bundle)`,
  )
  .option(
    '--profile [name]',
    `[boolean | string] start built-in Node.js inspector`,
  )
  .option('-d, --debug [feat]', `[string | boolean] show debug logs`)
  .option('-f, --filter <filter>', `[string] filter debug logs`)
  .option('-m, --mode <mode>', `[string] set env mode`)
  .option('--bypass-lock', `[boolean] disable process locks`)

// dev
cli
  .command('[root]', 'start dev server') // default command
  .alias('serve') // the command is called 'serve' in Vite's API
  .alias('dev') // alias to align with the script name
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] })
  .option('--port <port>', `[number] specify port`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--cors', `[boolean] enable CORS`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  )
  .option(
    '--experimentalBundle',
    `[boolean] use experimental full bundle mode (this is highly experimental)`,
  )
    // dev 命令的 action。注意这里 createServer 是动态 import 的：
    // CLI 启动路径上不需要立刻加载整个 server 模块图，能把 --help 之类命令的启动成本压到最低。
  .action(
    async (
      root: string,
      options: ServerOptions & ExperimentalDevOptions & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)
      // output structure is preserved even after bundling so require()
      // is ok here
      const { createServer } = await import('./server')
      try {
        const server = await createServer({
          // CLI 参数 → InlineConfig 的映射全部集中在这一处：
          //   root/base/mode/configFile/configLoader/logLevel/clearScreen 直接透传；
          //   server: cleanGlobalCLIOptions(options) 把 --host/--port/--open/--cors 等交给 server 配置；
          //   forceOptimizeDeps 对应 --force（跳过依赖预构建缓存）；
          //   experimental.bundledDev 对应 --experimentalBundle。
          // commandLockPlugin 是并发启动保护（同一项目同时起两个 dev server 会抢缓存目录）。
          root,
          base: options.base,
          mode: options.mode,
          configFile: options.config,
          configLoader: options.configLoader,
          logLevel: options.logLevel,
          clearScreen: options.clearScreen,
          plugins: options.bypassLock ? [] : [commandLockPlugin()],
          server: cleanGlobalCLIOptions(options),
          forceOptimizeDeps: options.force,
          experimental: {
            bundledDev: options.experimentalBundle,
          },
        })

        if (!server.httpServer) {
          // middlewareMode 下没有 httpServer，CLI 无法自己监听，直接报错。
          throw new Error('HTTP server not available')
        }

        await server.listen()
        // 注意 listen 的时序：依赖预构建发生在 listen 内部（见 server/index.ts 对
        // httpServer.listen 的覆写），所以下面打印 "ready in X ms" 时，
        // 依赖一定已经预构建完成——这个耗时是包含预构建的真实启动时间。

        const info = server.config.logger.info

        const modeString =
          options.mode && options.mode !== 'development'
            ? `  ${colors.bgGreen(` ${colors.bold(options.mode)} `)}`
            : ''
        const viteStartTime = global.__vite_start_time ?? false
        const startupDurationString = viteStartTime
          ? colors.dim(
              `ready in ${colors.reset(
                colors.bold(Math.ceil(performance.now() - viteStartTime)),
              )} ms`,
            )
          : ''
        const hasExistingLogs =
          process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0

        info(
          `\n  ${colors.green(
            `${colors.bold('VITE')} v${VERSION}`,
          )}${modeString}  ${startupDurationString}\n`,
          {
            clear: !hasExistingLogs,
          },
        )

        server.printUrls()
        const customShortcuts: CLIShortcut<typeof server>[] = []
        // CLI 快捷键（r 重启、u 打印 URL、q 退出、p 性能分析）。
        // 快捷键是 dev server 的交互层，与请求链路无关。
        if (profileSession) {
          customShortcuts.push({
            key: 'p',
            description: 'start/stop the profiler',
            async action(server) {
              if (profileSession) {
                await stopProfiler(server.config.logger.info)
              } else {
                const inspector = await import('node:inspector').then(
                  (r) => r.default,
                )
                await new Promise<void>((res) => {
                  profileSession = new inspector.Session()
                  profileSession.connect()
                  profileSession.post('Profiler.enable', () => {
                    profileSession!.post('Profiler.start', () => {
                      server.config.logger.info('Profiler started')
                      res()
                    })
                  })
                })
              }
            },
          })
        }
        server.bindCLIShortcuts({ print: true, customShortcuts })
      } catch (e) {
        // 启动失败：用新建的 logger 打（此时还没有 server.config.logger），
        // 并且停掉 profiler，避免 CPU profile 文件不完整。
        const logger = createLogger(options.logLevel)
        logger.error(
          colors.red(`error when starting dev server:\n${inspect(e)}`),
          {
            error: e,
          },
        )
        await stopProfiler(logger.info)
        process.exit(1)
      }
    },
  )

// build
cli
  // build 命令。与 dev 的最大区别：不经过 createServer，
  // 而是 createBuilder + buildApp（支持多环境编排）。
  .command('build [root]', 'build for production')
  .option(
    '--target <target>',
    `[string] transpile target (default: 'baseline-widely-available')`,
  )
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .option(
    '--assetsDir <dir>',
    `[string] directory under outDir to place assets in (default: assets)`,
  )
  .option(
    '--assetsInlineLimit <number>',
    `[number] static asset base64 inline threshold in bytes (default: 4096)`,
  )
  .option(
    '--ssr [entry]',
    `[string] build specified entry for server-side rendering`,
  )
  .option(
    '--sourcemap [output]',
    `[boolean | "inline" | "hidden"] output source maps for build (default: false)`,
  )
  .option(
    '--minify [minifier]',
    // 默认压缩器是 oxc，esbuild 只是兼容选项。
    // 选 esbuild 会在 build 的 post 插件段插入 buildEsbuildPlugin（见 build.ts）。
    `[boolean | "oxc" | "terser" | "esbuild"] enable/disable minification, ` +
      `or specify minifier to use (default: oxc)`,
  )
  .option('--manifest [name]', `[boolean | string] emit build manifest json`)
  .option('--ssrManifest [name]', `[boolean | string] emit ssr manifest json`)
  .option(
    '--emptyOutDir',
    `[boolean] force empty outDir when it's outside of root`,
  )
  .option('-w, --watch', `[boolean] rebuilds when modules have changed on disk`)
  .option('--app', `[boolean] same as \`builder: {}\``)
    // build action：先建 builder，再加进程锁（防止两个 build 同时写 outDir），
    // 最后 buildApp() 按环境逐个构建。
  .action(
    async (
      root: string,
      options: BuildEnvironmentOptions & BuilderCLIOptions & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)

      const buildOptions: BuildEnvironmentOptions = cleanGlobalCLIOptions(
        cleanBuilderCLIOptions(options),
      )

      try {
        const inlineConfig: InlineConfig = {
          root,
          base: options.base,
          mode: options.mode,
          configFile: options.config,
          configLoader: options.configLoader,
          logLevel: options.logLevel,
          clearScreen: options.clearScreen,
          build: buildOptions,
          ...(options.app ? { builder: {} } : {}),
        }
        const builder = await createBuilder(inlineConfig, null)
        // 第二个参数 null 表示「不要默认构建哪个环境」，由 buildApp 决定。
        // 这与 build() API 的 createBuilder(config, true) 不同：后者只构建第一个环境。
        if (!options.bypassLock) {
          await createCommandLock(builder.config, 'build', null)
        }
        await builder.buildApp()
        await builder.runDevTools()
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error during build:\n${inspect(e)}`),
          { error: e },
        )
        process.exit(1)
      } finally {
        await stopProfiler((message) =>
          createLogger(options.logLevel).info(message),
        )
      }
    },
  )

// optimize
cli
  // optimize 命令已废弃：依赖预构建现在在 dev server 启动时自动完成。
  // 保留它只是为了兼容脚本，内部仍会打一条 deprecated 警告。
  .command(
    'optimize [root]',
    'pre-bundle dependencies (deprecated, the pre-bundle process runs automatically and does not need to be called)',
  )
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  )
  .action(
    async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
      filterDuplicateOptions(options)
      const { resolveConfig } = await import('./config')
      const { optimizeDeps } = await import('./optimizer')
      try {
        const config = await resolveConfig(
          {
            root,
            base: options.base,
            configFile: options.config,
            configLoader: options.configLoader,
            logLevel: options.logLevel,
            mode: options.mode,
          },
          'serve',
        )
        await optimizeDeps(config, options.force, true)
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error when optimizing deps:\n${inspect(e)}`),
          { error: e },
        )
        process.exit(1)
      }
    },
  )

// preview
cli
  // preview：起一个静态服务器托管 dist，用于验证生产产物。
  // 它复用 indexHtmlMiddleware，所以 HTML 的 fallback 行为与 dev 一致。
  .command('preview [root]', 'locally preview production build')
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] })
  .option('--port <port>', `[number] specify port`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .action(
    async (
      root: string,
      options: {
        host?: string | boolean
        port?: number
        open?: boolean | string
        strictPort?: boolean
        outDir?: string
      } & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)
      const { preview } = await import('./preview')
      try {
        const server = await preview({
          root,
          base: options.base,
          configFile: options.config,
          configLoader: options.configLoader,
          logLevel: options.logLevel,
          mode: options.mode,
          plugins: options.bypassLock ? [] : [commandLockPlugin()],
          build: {
            outDir: options.outDir,
          },
          preview: {
            port: options.port,
            strictPort: options.strictPort,
            host: options.host,
            open: options.open,
          },
        })
        server.printUrls()
        server.bindCLIShortcuts({ print: true })
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error when starting preview server:\n${inspect(e)}`),
          { error: e },
        )
        process.exit(1)
      } finally {
        await stopProfiler((message) =>
          createLogger(options.logLevel).info(message),
        )
      }
    },
  )

cli.help()
cli.version(VERSION)

cli.parse()
