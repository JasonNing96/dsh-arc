/** Version-pinned opt-in community renderer, with classic as the unchanged fallback. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RuntimeConfig } from './runtime-config.js'
export async function launchCommunity(config: RuntimeConfig, remoteConfig: string, remoteOptional: boolean, fresh: boolean): Promise<void> {
  const home = process.env.DSH_COMMUNITY_HOME ?? join(homedir(), '.local/share/personal-dsh/community-ui')
  const pkg = join(home, 'profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json')
  try { if (JSON.parse(await readFile(pkg, 'utf8')).version !== '0.10.1') throw new Error('version') }
  catch { throw new Error('社区入口尚未安装或版本不匹配。运行 python3 tools/install-community-tui.py；也可用 --ui classic。') }
  const temp = await mkdtemp(join(tmpdir(), 'dsh-arc-launch-'))
  const path = join(temp, 'launch.json')
  await writeFile(path, JSON.stringify({ config, remoteConfig, remoteOptional, fresh }), { mode: 0o600 })
  try {
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../community/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)), '--profile', 'dsh-tui'], {
      cwd: config.cwd, stdio: 'inherit', env: { ...process.env, DSH_HOME: home, DSH_EVAL_PREFS: join(home, 'preferences'), DSH_ARC_LAUNCH: path },
    })
    const terminate = (): void => { child.kill('SIGTERM') }
    process.on('SIGTERM', terminate); process.on('SIGINT', terminate)
    try {
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`社区入口退出（${String(code)}）；可用 --ui classic 回退`))) })
    } finally { process.off('SIGTERM', terminate); process.off('SIGINT', terminate) }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
