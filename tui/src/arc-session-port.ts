/** Narrow session handoff contract shared by ARC views. */
import type { AcpEventHandlers } from './acp-client.js'
import type { TranscriptEntry } from './state-store.js'

export interface ArcInputState {
  readonly buffer: string
  readonly cursor: number
}

/** Durable-or-memory conversation projection, with no renderer ownership. */
export interface ArcConversationMirror {
  readonly entries: readonly TranscriptEntry[]
  readonly createdAt: number
  readonly conversationId: string
  readonly input: ArcInputState
}

/** Runtime session ownership and durable handoff state, independent of any UI. */
export interface ArcSession {
  readonly clientHandlers: Required<AcpEventHandlers>
  readonly conversation: string | undefined
  readonly sessionId: string | undefined
  readonly running: 'idle' | 'busy' | 'cancelling'
  readonly pendingPermission: unknown
  readonly errorText: string
  readonly unsavedWarning: string
  readonly uiState: ArcInputState
  readonly inputComplete: boolean
  createSession(): Promise<boolean>
  resumeSession(sessionId: string): Promise<boolean>
  saveDraftNow(): Promise<void>
  flushInput(signal?: AbortSignal): Promise<void>
  exportConversationMirror(): Promise<ArcConversationMirror>
  adoptConversation(sessionId: string, source: ArcConversationMirror): Promise<void>
  restoreInput(state: ArcInputState): void
  setActive(active: boolean): void
  onChange(hook: () => void): void
  showError(text: string): void
  setTransition(text: string, cancel?: () => void): void
  close(): Promise<void>
}
