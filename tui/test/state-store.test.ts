/**
 * Behavior tests for the state store: atomic mirrors, safe session ids,
 * drafts, resume bookkeeping, and cross-runtime namespace isolation.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StateStore, safeSegment } from '../dist/state-store.js'
async function freshStore(name: string): Promise<{ store: StateStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-tui-state-${name}-`))
  const store = await StateStore.open(dir, 'runtime-a')
  return {
    store,
    dir,
    cleanup: async () => {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('append creates a mirror, then extends it with monotonic seq', async () => {
  const { store, cleanup } = await freshStore('append')
  try {
    await store.append('sess-1', '/tmp/w', { kind: 'user', text: '第一句' })
    await store.append('sess-1', '/tmp/w', { kind: 'assistant', text: '回复' })
    await store.append('sess-1', '/tmp/w', { kind: 'tool', text: '读文件', toolCallId: 't1', toolStatus: 'in_progress' })
    const mirror = await store.loadMirror('sess-1')
    assert.ok(mirror !== null)
    assert.equal(mirror.entries.length, 3)
    assert.deepEqual(mirror.entries.map(entry => entry.seq), [0, 1, 2])
    assert.equal(mirror.cwd, '/tmp/w')
    assert.equal(mirror.resumedAt, null)
  } finally {
    await cleanup()
  }
})

test('session ids never reach the filesystem as paths', async () => {
  const { store, cleanup } = await freshStore('safeids')
  try {
    const evil = '../../escape/attempt'
    await store.append(evil, '/tmp/w', { kind: 'user', text: 'x' })
    const files = await readdir(join(store.directory, 'sessions'))
    assert.ok(files.every(file => /^[0-9a-f]{64}\.json(\..*)?$/.test(file) || file.startsWith('lock')))
    const mirror = await store.loadMirror(evil)
    assert.equal(mirror?.sessionId, evil)
  } finally {
    await cleanup()
  }
})

test('safeSegment is injective-enough and path-free', () => {
  assert.match(safeSegment('../../../etc/passwd'), /^[0-9a-f]{64}$/)
  assert.match(safeSegment('normal-id'), /^[0-9a-f]{64}$/)
  assert.notEqual(safeSegment('a'), safeSegment('b'))
})

test('mirror files are owner-only (0600)', async () => {
  const { store, cleanup } = await freshStore('perms')
  try {
    await store.append('sess-perm', '/tmp/w', { kind: 'user', text: 'x' })
    const path = join(store.directory, 'sessions', `${safeSegment('sess-perm')}.json`)
    const info = await stat(path)
    // POSIX: owner read/write only.
    assert.equal(info.mode & 0o077, 0)
  } finally {
    await cleanup()
  }
})

test('drafts save, load, and clear', async () => {
  const { store, cleanup } = await freshStore('drafts')
  try {
    await store.saveDraft('sess-1', '未完成的输入')
    assert.equal(await store.loadDraft('sess-1'), '未完成的输入')
    await store.saveDraft('sess-1', '')
    assert.equal(await store.loadDraft('sess-1'), '')
    assert.equal(await store.loadDraft('never'), '')
  } finally {
    await cleanup()
  }
})

test('markResumed and markUnresumable persist', async () => {
  const { store, cleanup } = await freshStore('resume')
  try {
    await store.append('sess-1', '/tmp/w', { kind: 'user', text: 'x' })
    await store.markResumed('sess-1')
    let mirror = await store.loadMirror('sess-1')
    assert.ok(mirror?.resumedAt !== null)
    await store.markUnresumable('sess-1', 'cwd mismatch')
    mirror = await store.loadMirror('sess-1')
    assert.equal(mirror?.unresumableReason, 'cwd mismatch')
  } finally {
    await cleanup()
  }
})

test('listMirrors orders by recency and skips corrupt files', async () => {
  const { store, cleanup } = await freshStore('list')
  try {
    await store.append('old', '/tmp/w', { kind: 'user', text: 'x' })
    await new Promise(resolve => { setTimeout(resolve, 15) })
    await store.append('new', '/tmp/w', { kind: 'user', text: 'y' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(store.directory, 'sessions', 'not-a-hash.json'), '{broken', 'utf8')
    const mirrors = await store.listMirrors()
    assert.equal(mirrors.length, 2)
    assert.equal(mirrors[0]?.sessionId, 'new')
  } finally {
    await cleanup()
  }
})

test('different runtime identities use different namespaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-ns-'))
  try {
    const a = await StateStore.open(dir, 'runtime-a')
    const b = await StateStore.open(dir, 'runtime-b')
    assert.notEqual(a.directory, b.directory)
    await a.append('sess-1', '/tmp/w', { kind: 'user', text: 'in a' })
    assert.equal(await b.loadMirror('sess-1'), null)
    await a.close()
    await b.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writes are durable JSON the process can re-read (resume across restart)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-restart-'))
  try {
    {
      const store = await StateStore.open(dir, 'runtime-a')
      await store.append('sess-1', '/tmp/w', { kind: 'user', text: '历史' })
      await store.markResumed('sess-1')
      await store.close()
    }
    {
      const store = await StateStore.open(dir, 'runtime-a')
      const mirror = await store.loadMirror('sess-1')
      assert.deepEqual(
        mirror?.entries.map(entry => [entry.kind, entry.text]),
        [['user', '历史']],
      )
      assert.ok(mirror?.resumedAt !== null)
      await store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('atomic writes leave no temp residue', async () => {
  const { store, cleanup } = await freshStore('atomic')
  try {
    for (let index = 0; index < 5; index += 1) {
      await store.append('sess-1', '/tmp/w', { kind: 'user', text: `line ${String(index)}` })
    }
    const files = await readdir(join(store.directory, 'sessions'))
    assert.deepEqual(files, [`${safeSegment('sess-1')}.json`])
  } finally {
    await cleanup()
  }
})

test('two concurrent opens of the same runtime are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-lock-'))
  try {
    const first = await StateStore.open(dir, 'runtime-a')
    assert.equal(first.locked, true)
    // A second open in the same process must NOT steal the live lock.
    await assert.rejects(StateStore.open(dir, 'runtime-a'), (error: unknown) => {
      assert.match((error as Error).message, /另一个 TUI 进程|pid/)
      return true
    })
    // After a clean close the lock is releasable again.
    await first.close()
    const second = await StateStore.open(dir, 'runtime-a')
    assert.equal(second.locked, true)
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stale lock is refused and preserved for explicit recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-stale-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    // A pid that is definitely not a live TUI: kernel pid 0 wraparound trick —
    // use a very large pid that nothing holds.
    const root = join(dir, 'runtimes', safeSegment('runtime-a'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'sessions'), { recursive: true })
    await mkdir(join(root, 'drafts'), { recursive: true })
    await writeFile(join(root, 'lock.json'), JSON.stringify({ pid: 4_000_000, startedAt: 1 }), 'utf8')
    await assert.rejects(StateStore.open(dir, 'runtime-a'), /状态锁/)
    assert.equal(JSON.parse(await readFile(join(root, 'lock.json'), 'utf8')).pid, 4_000_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('close only releases its own lock (token check)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-token-'))
  try {
    const first = await StateStore.open(dir, 'runtime-a')
    // Simulate another process replacing the lock while we run.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(first.directory, 'lock.json'),
      JSON.stringify({ pid: process.pid + 1, startedAt: Date.now(), token: 'foreign' }),
      'utf8',
    )
    await first.close() // must NOT remove the foreign lock
    const raw = await readFile(join(first.directory, 'lock.json'), 'utf8')
    assert.equal((JSON.parse(raw) as { token: string }).token, 'foreign')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('simultaneous opens have exactly one winner, even while the lock is being initialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-contenders-'))
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => StateStore.open(dir, 'same')))
    const winners = results.filter(result => result.status === 'fulfilled')
    assert.equal(winners.length, 1)
    for (const winner of winners) await winner.value.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
