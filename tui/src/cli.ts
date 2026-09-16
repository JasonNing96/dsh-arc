#!/usr/bin/env node
/**
 * Command-line entry for the personal DSH terminal client.
 *
 * @module personal-dsh-tui/cli
 */

import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { errorText } from './acp-client.js'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { loadRemoteConfig } from './remote-config.js'
import { launchCommunity } from './community-launch.js'
import { RuntimeWorkspace } from './runtime-workspace.js'
import { resolveRuntimeConfig, type CliRuntimeOptions } from './runtime-config.js'

const HELP = `dsh-tui — personal DSH 终端客户端（本机 / 服务器）

用法：
  npm --prefix tui run start [-- <选项>]     连接真实 DSH runtime（ACP stdio）
  npm --prefix tui run demo                  连接内置演示 runtime（无模型凭据）

选项：
  --cwd <dir>           工作区目录（默认：当前目录；可为绝对路径或 ~ 开头）
  --dsh-home <dir>      runtime 的 DSH_HOME（默认 ~/.local/share/personal-dsh/runtime）
                        绝不使用也不写入全局 ~/.dsh，除非显式传入
  --state-dir <dir>     TUI 自身状态目录（默认 ~/.local/share/personal-dsh/tui）
  --dsh-executable <p>  显式指定 dsh 可执行文件（默认：项目锁定的 node_modules/.bin/dsh）
  --arc-profile <name>  使用已安装的 ARC 插件 ACP profile，不加载旧 runtime 源码适配器
  --remote-config <p>   单台服务器 JSON 配置（默认 ~/.local/share/personal-dsh/remote.json）
  --ui <classic|community> 界面选择（默认 classic；community 为 ARC MVP）
  --new                 新建会话；默认恢复当前工作区上次 ARC 会话
  --demo                演示模式：内置假 runtime，明确标注 DEMO
  --help, -h            显示本帮助

经典界面快捷键：
  Enter / Alt+Enter 提交 · Ctrl+J 换行（多行输入）· 括号粘贴永不提交
  Ctrl+C 中断当前回合（空闲时按两次退出）· Ctrl+D 空行退出
  Ctrl+S 会话列表 · Ctrl+N 新建会话 · PageUp/PageDown 滚动
  Ctrl+R 本机/服务器投切 · Ctrl+G 重连当前端（不自动重发消息）

社区界面：
  Ctrl+R 投切 · Ctrl+G 重连 · Esc / Ctrl+C 中断当前回合
  权限请求：Ctrl+Y 仅允许本次 · Ctrl+N / Esc 拒绝
  /new 新会话 · /status 当前 ARC 状态 · /help 帮助 · /exit 退出
  与经典界面共用会话和草稿；请先关闭旧入口，不能同时写同一状态目录。

模型与凭据：真实模式使用 --dsh-home 下既有 DSH 设置中的 provider/model；
本客户端不读取、不复制、不显示密钥。
`

function parseArgs(argv: string[]): CliRuntimeOptions & { help: boolean; remoteConfig?: string; ui?: string; fresh?: boolean } {
  const options: CliRuntimeOptions & { demo: boolean; cwd: string | undefined; dshHome: string | undefined; stateDir: string | undefined; dshExecutable: string | undefined; arcProfile?: string; help: boolean; remoteConfig?: string; ui?: string; fresh?: boolean } = {
    demo: false,
    cwd: undefined,
    dshHome: undefined,
    stateDir: undefined,
    dshExecutable: undefined,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = (): string | undefined => argv[index + 1]
    switch (arg) {
      case '--arc-profile': {
        const value = next()
        if (value === undefined) fail('--arc-profile 需要一个名称')
        options.arcProfile = value
        index += 1
        break
      }
      case '--new': options.fresh = true; break
      case '--ui': { const value = next(); if (value !== 'classic' && value !== 'community') fail('--ui 只接受 classic 或 community'); options.ui = value; index++; break }
      case '--remote-config': {
        const value = next()
        if (value === undefined) fail('--remote-config 需要一个路径')
        options.remoteConfig = value
        index += 1
        break
      }
      case '--demo': options.demo = true; break
      case '--help': case '-h': options.help = true; break
      case '--cwd': {
        const value = next()
        if (value === undefined) fail('--cwd 需要一个目录')
        options.cwd = value
        index += 1
        break
      }
      case '--dsh-home': {
        const value = next()
        if (value === undefined) fail('--dsh-home 需要一个目录')
        options.dshHome = value
        index += 1
        break
      }
      case '--state-dir': {
        const value = next()
        if (value === undefined) fail('--state-dir 需要一个目录')
        options.stateDir = value
        index += 1
        break
      }
      case '--dsh-executable': {
        const value = next()
        if (value === undefined) fail('--dsh-executable 需要一个路径')
        options.dshExecutable = value
        index += 1
        break
      }
      default: fail(`未知选项：${arg}`)
    }
  }
  return options
}

function fail(message: string): never {
  process.stderr.write(`dsh-tui: ${message}\n`)
  process.exitCode = 2
  throw new Error(message)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('需要交互式终端（TTY）：请直接在终端中运行；非交互场景请使用 dsh headless')
  }
  const config = resolveRuntimeConfig(options)
  const remotePath = options.remoteConfig === undefined ? resolve(homedir(), '.local/share/personal-dsh/remote.json')
    : resolve(options.remoteConfig.replace(/^~(?=\/|$)/, homedir()))
  if (options.ui === 'community') { await launchCommunity(config, remotePath, options.remoteConfig === undefined, options.fresh ?? false); return }
  const remote = options.demo ? undefined : await loadRemoteConfig(
    options.remoteConfig === undefined ? resolve(homedir(), '.local/share/personal-dsh/remote.json')
      : resolve(options.remoteConfig.replace(/^~(?=\/|$)/, homedir())), options.remoteConfig === undefined)
  const workspace = new RuntimeWorkspace(config, remote, text => { if (rawModeSet) process.stdout.write(text) })
  let resolveLoop: () => void = () => undefined
  const loopDone = new Promise<void>(resolve => { resolveLoop = resolve })
  let finished = false
  const finish = (): void => { if (!finished) { finished = true; resolveLoop() } }
  const onReadable = (): void => {
    let chunk: Buffer | null
    while ((chunk = process.stdin.read()) !== null) workspace.feed(chunk)
  }
  const onResize = (): void => { workspace.setSize(process.stdout.rows, process.stdout.columns) }
  const onSignal = (): void => { finish(); void workspace.close() }
  let rawModeSet = false
  try {
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    workspace.onQuit(finish)
    await workspace.start(options.fresh ?? false)
    if (finished) return
    process.stdin.setRawMode(true)
    rawModeSet = true
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h')
    workspace.setSize(process.stdout.rows, process.stdout.columns)
    process.stdout.on('resize', onResize)
    process.stdin.on('readable', onReadable)
    process.stdin.once('end', finish)
    onReadable()
    await loopDone
  } finally {
    process.stdin.off('readable', onReadable)
    process.stdin.off('end', finish)
    process.stdout.off('resize', onResize)
    if (rawModeSet) {
      process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l')
      try { process.stdin.setRawMode(false) } catch { /* terminal gone */ }
    }
    process.stdin.pause()
    process.stdin.unref()
    await workspace.close()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.stdout.write('\x1b[0m\n')
  }
}

function run(): void {
  main().catch((error: unknown) => {
    process.stderr.write(`dsh-tui: ${errorText(error)}\n`)
    process.exitCode = 1
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run()
}
