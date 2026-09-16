/** One explicitly configured SSH runtime. No credentials are stored here. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export interface RemoteConfig {
  readonly arcProfile?: string
  readonly host: string
  readonly cwd: string
  readonly dshHome: string
  readonly node: string
  readonly entry: string
  /** Host paths for container execution through SSH; ACP paths stay inside the container. */
  readonly docker?: { readonly image: string; readonly workspace: string; readonly dataDir: string; readonly user: string; readonly envFile?: string }
}

export function parseRemoteConfig(value: unknown): RemoteConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器配置必须为 JSON 对象')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['host', 'cwd', 'dshHome', 'node', 'entry', 'arcProfile', 'docker'].includes(key)) throw new Error(`未知服务器配置项：${key}`)
  }
  const host = record.host
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)) {
    throw new Error('host 必须是 ~/.ssh/config 中的主机别名或主机名')
  }
  const path = (key: string): string => {
    const item = record[key]
    if (typeof item !== 'string' || !item.startsWith('/') || /[\x00-\x1f\x7f]/.test(item)) {
      throw new Error(`${key} 必须是服务器上的绝对路径（不能包含控制字符）`)
    }
    return posix.normalize(item)
  }
  const profile = record.arcProfile
  if (profile !== undefined && (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile))) {
    throw new Error('arcProfile 必须是有效的 profile 名称')
  }
  let docker: RemoteConfig['docker']
  if (record.docker !== undefined) {
    if (!record.docker || typeof record.docker !== 'object' || Array.isArray(record.docker)) throw new Error('docker 必须是对象')
    const value = record.docker as Record<string, unknown>
    for (const key of Object.keys(value)) {
      if (!['image', 'workspace', 'dataDir', 'user', 'envFile'].includes(key)) throw new Error(`未知 Docker 配置项：${key}`)
    }
    if (typeof value.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value.image)) throw new Error('Docker image 无效')
    if (typeof value.user !== 'string' || !/^\d+:\d+$/.test(value.user)) throw new Error('Docker user 必须是 uid:gid')
    const hostPath = (key: string): string => {
      const item = value[key]
      if (typeof item !== 'string' || !item.startsWith('/') || /[\x00-\x1f\x7f,]/.test(item)) throw new Error(`Docker ${key} 必须是绝对路径且不能含逗号或控制字符`)
      return posix.normalize(item)
    }
    docker = { image: value.image, user: value.user, workspace: hostPath('workspace'), dataDir: hostPath('dataDir'),
      ...(value.envFile === undefined ? {} : { envFile: hostPath('envFile') }) }
    if (record.cwd !== '/workspace' || record.dshHome !== '/data/runtime' || profile !== 'arc-runtime') {
      throw new Error('Docker runtime 使用 /workspace、/data/runtime 和 arc-runtime profile')
    }
  }
  return { host, cwd: path('cwd'), dshHome: path('dshHome'), node: path('node'), entry: path('entry'),
    ...(profile === undefined ? {} : { arcProfile: profile as string }), ...(docker === undefined ? {} : { docker }) }
}

export async function loadRemoteConfig(path: string, optional = false): Promise<RemoteConfig | undefined> {
  try { return parseRemoteConfig(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`无法读取服务器配置 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function remoteIdentity(remote: RemoteConfig): string {
  const identity = remote.docker === undefined ? `ssh\0${remote.host}\0${remote.dshHome}` : `ssh-docker\0${remote.host}\0${remote.docker.dataDir}`
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

/** SSH invokes a remote shell; quote every variable as one literal shell word. */
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }

export function remoteSshArgs(remote: RemoteConfig): string[] {
  const adapter = remote.arcProfile === undefined ? ` --import ${shellQuote(posix.join(remote.dshHome, 'tui-adapter/runtime-hook.js'))}` : ''
  const native = `cd -- ${shellQuote(remote.cwd)} && exec env DSH_HOME=${shellQuote(remote.dshHome)} PATH=${shellQuote(posix.dirname(remote.node))}:"$PATH" ${shellQuote(remote.node)}${adapter} ${shellQuote(remote.entry)} --profile ${shellQuote(remote.arcProfile ?? 'acp')}`
  const container = remote.docker
  const command = container === undefined ? native : 'exec ' + [
    'docker', 'run', '--rm', '-i', '--init', '--user', container.user, '--label', 'dsh-arc.runtime=1',
    '--mount', `type=bind,src=${container.dataDir},dst=/data`,
    '--mount', `type=bind,src=${container.workspace},dst=/workspace`,
    '--workdir', '/workspace', '--env', 'DSH_ARC_HOME=/data',
    ...(container.envFile === undefined ? [] : ['--env-file', container.envFile]), container.image, 'runtime',
  ].map(shellQuote).join(' ')
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', remote.host, command]
}
