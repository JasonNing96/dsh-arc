import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { checkpointSeed, exportCheckpoint, validateCheckpoint } from '../dist/handoff.js'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (content: Parameters<typeof createAssistantMessage>[0]['content']) => createAssistantMessage({ content, source: { provider: 'zai', model: 'glm-5.3-flash' } })
const callId = brandString<ToolCallId>('call-test')

test('native seed retains user, assistant, paired tool result without executing tools', () => {
  const messages = [user('A'), assistant([{ type: 'tool-call', id: callId, name: 'read', arguments: '{"file_path":"/source/fixture"}' }]),
    createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'SECRET_FIXTURE_RESULT' }] }),
    assistant([{ type: 'text', text: 'B' }])]
  const cp = { version: 1 as const, sourceCwd: '/source', messages }
  const restored = Session.create(brandString<SessionId>('target'), checkpointSeed(cp, '/target'))
  assert.deepEqual(restored.deriveMessages().slice(0, 4), messages)
  assert.equal(restored.snapshotEvents().filter(event => event.type === 'tool/call').length, 1)
  const again = exportCheckpoint(Session.create(brandString<SessionId>('target-two'), checkpointSeed(cp, '/target'),
    { id: brandString<SessionId>('target-two'), cwd: '/target', createdAt: Date.now(), version: 3, isSeeded: false }))
  assert.deepEqual(again.messages, messages, 'handoff notices never accumulate on repeated switches')
})

test('incomplete tools, unavailable attachments, malformed and oversized checkpoints fail explicitly', () => {
  assert.throws(() => validateCheckpoint({}), /检查点/)
  assert.throws(() => validateCheckpoint({ version: 1, sourceCwd: '/source', messages: [
    assistant([{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }]),
  ] }), /尚未完成/)
  assert.throws(() => validateCheckpoint({ version: 1, sourceCwd: '/source', messages: [
    { ...user('A'), content: [{ type: 'image', source: { type: 'attachment', id: 'missing' } }] },
  ] }), /附件/)
  assert.throws(() => validateCheckpoint({ version: 1, sourceCwd: '/source', messages: [user('x'.repeat(2 * 1024 * 1024))] }), /2 MiB/)
})
