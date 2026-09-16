/** Byte-level fake ACP peer. Uses real newline framing and records both directions. */
import { afterEach } from 'node:test'
import { AcpClient, type AcpEventHandlers } from '../dist/acp-client.js'
import type { StateStore } from '../dist/state-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'

const peers = new Set<{ client: AcpClient; fake: FakeRuntime }>()
afterEach(async () => {
  for (const peer of peers) { await peer.client.dispose(); peer.fake.kill() }
  peers.clear()
})

export interface SentLine {
  id: number | string | null
  method: string
  params: unknown
  result?: unknown
  error?: unknown
}
export interface FakeRuntime {
  send(line: Record<string, unknown> | string): void
  sent: SentLine[]
  kill(): void
}
export async function connectFake(handlers: AcpEventHandlers,
  options: { initializeResult?: Record<string, unknown> } = {},
): Promise<{ client: AcpClient; fake: FakeRuntime }> {
  const outgoing = new PassThrough()
  const incoming = new PassThrough()
  const sent: SentLine[] = []
  const fake: FakeRuntime = {
    sent,
    send(line) { incoming.write(typeof line === 'string' ? line : JSON.stringify(line) + '\n') },
    kill() { outgoing.end(); incoming.end() },
  }
  let pending = ''
  outgoing.setEncoding('utf8')
  outgoing.on('data', (chunk: string) => {
    pending += chunk
    for (;;) {
      const end = pending.indexOf('\n')
      if (end < 0) break
      const raw = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (!raw.trim()) continue
      const message = JSON.parse(raw)
      sent.push({ id: message.id ?? null, method: message.method ?? '', params: message.params,
        result: message.result, error: message.error })
      if (message.method === 'initialize') fake.send({ jsonrpc: '2.0', id: message.id,
        result: options.initializeResult ?? { protocolVersion: 1, agentInfo: { name: 'fake', version: '0' }, agentCapabilities: {}, authMethods: [] } })
      if (message.method === 'authenticate') fake.send({ jsonrpc: '2.0', id: message.id, result: {} })
    }
  })
  const stream = ndJsonStream(Writable.toWeb(outgoing), Readable.toWeb(incoming))
  try {
    const client = await AcpClient.connectStream('test-runtime', stream, handlers)
    const peer = { client, fake }
    peers.add(peer)
    return peer
  } catch (error) { fake.kill(); throw error }
}

/** Fresh temp state dir + opened store; returns cleanup. */
export async function openTestStore(id: string): Promise<{ store: StateStore; cleanup: () => Promise<void> }> {
  const { StateStore } = await import('../dist/state-store.js')
  const dir = await mkdtemp(join(tmpdir(), `dsh-tui-test-${id}-`))
  const store = await StateStore.open(dir, 'test-runtime-id')
  return {
    store,
    cleanup: async () => {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Wait until predicate holds or timeout (ms). */
export async function until(predicate: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

