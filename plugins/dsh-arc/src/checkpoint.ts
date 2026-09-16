/** Versioned portable context: model messages, never files, policies or pending work. */
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createSystemMessage, freezeMessage, type Message, type AssistantMessage, type ToolResultMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

export interface Checkpoint {
  version: 1
  sourceCwd: string
  messages: Message[]
}
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024

export function validateCheckpoint(value: unknown): Checkpoint {
  const cp = value as Checkpoint
  if (!cp || cp.version !== 1 || typeof cp.sourceCwd !== 'string' || !cp.sourceCwd.startsWith('/') || !Array.isArray(cp.messages)) {
    throw new Error('不支持的会话检查点')
  }
  if (Buffer.byteLength(JSON.stringify(cp)) > MAX_CHECKPOINT_BYTES) throw new Error('上下文超过 2 MiB，暂不支持投切；原会话保留')
  const pending = new Set<string>()
  const used = new Set<string>()
  for (const raw of cp.messages) {
    const message = freezeMessage(raw)
    if (message.role === 'system') throw new Error('投切检查点不能包含源端系统提示')
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        if (message.role !== 'assistant' || used.has(block.id)) throw new Error('工具调用身份重复或无效')
        pending.add(block.id); used.add(block.id)
      } else if (block.type === 'tool-result') {
        if (message.source.kind !== 'tool' || !pending.delete(block.toolCallId)) throw new Error('工具结果缺少匹配调用')
        if (block.content.some(part => part.type !== 'text')) throw new Error('当前 MVP 暂不搬运附件，请保留在原端继续')
      } else if (block.type !== 'text' && block.type !== 'reasoning') {
        throw new Error('当前 MVP 暂不搬运附件，请保留在原端继续')
      }
    }
  }
  if (pending.size) throw new Error('工具调用尚未完成，不能投切')
  return cp
}

/** Keep the current model-visible surface, including existing compaction/recall. */
export function exportCheckpoint(session: Session): Checkpoint {
  return validateCheckpoint({ version: 1, sourceCwd: session.header.cwd,
    messages: session.deriveMessages().filter(message => message.role !== 'system' &&
      !(message.source.kind === 'plugin' && (message.source.plugin === 'dsh-tui-handoff' ||
        ['instructions', 'catalog', 'snapshot'].includes(message.source.form ?? '')))) })
}

/** Build a balanced native seed. No inbox input or tool execution is replayed. */
export function checkpointSeed(value: unknown, cwd: string) {
  const cp = validateCheckpoint(value)
  const session = Session.create(brandString<SessionId>('dsh-tui-checkpoint'))
  let step = 1
  let assistantSeen = false
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step })
  session.append('system/message', { turn: 1, step, message: createSystemMessage('', 'dsh-tui-handoff') }, { surfaceOp: 'append' })
  for (const message of cp.messages) {
    if (assistantSeen && message.source.kind !== 'tool') {
      session.append('step/end', { turn: 1, step })
      session.append('step/start', { turn: 1, step: ++step })
      assistantSeen = false
    }
    if (message.role === 'assistant') {
      if (message.source.kind !== 'model') throw new Error('无效的 assistant 来源')
      session.append('assistant/message', { turn: 1, step, message: message as AssistantMessage, stream: [] }, { surfaceOp: 'append' })
      for (const block of message.content) if (block.type === 'tool-call') {
        session.append('tool/call', { turn: 1, step, callId: block.id, name: block.name, arguments: block.arguments })
      }
      assistantSeen = true
    } else if (message.source.kind === 'tool') {
      session.append('tool/result', { turn: 1, step, message: message as ToolResultMessage }, { surfaceOp: 'append' })
    } else {
      session.append('user/message', message as UserMessage, { surfaceOp: 'append' })
    }
  }
  session.append('step/end', { turn: 1, step })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-tui-handoff', form: 'notice', summary: '执行位置已切换' },
    content: [{ type: 'text', text: `Runtime handoff: the preceding messages are historical context from ${JSON.stringify(cp.sourceCwd)}. Execution now takes place at ${JSON.stringify(cwd)}. Previous tool results describe the source environment; files were NOT transferred. Do not assume old paths exist or repeat completed actions. Use the current runtime tools and workspace instructions.` }] }), { surfaceOp: 'append' })
  return session.snapshotEvents()
}
