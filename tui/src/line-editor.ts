/**
 * Incremental key decoder and grapheme-safe buffer editing.
 *
 * KeyDecoder is a persistent stateful decoder: stdin chunks are accumulated,
 * so UTF-8 sequences, bracketed-paste markers, and CSI sequences split across
 * reads never corrupt into stray characters or accidental submits. Editing
 * operates on grapheme clusters (Intl.Segmenter), so CJK text, combining
 * marks, and emoji with modifiers backspace/move as single visible units.
 *
 * Submit semantics: Enter (CR) or Alt+Enter submits; Ctrl+J (LF) inserts a
 * newline; bracketed paste inserts verbatim and never submits.
 *
 * @module personal-dsh-tui/line-editor
 */

/** A key event decoded from raw stdin bytes. */
export interface KeyEvent {
  /** 'enter' | 'alt-enter' | 'newline' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'backspace' | 'delete' | 'tab' | 'escape' | 'paste' | 'char' | 'ctrl-<x>' */
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  /** Insertable text for 'char' / 'paste'. */
  readonly text: string
}

const ESC = 0x1b
const PASTE_START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]
const CSI_BODY = /^[\x20-\x3f]*/
const CSI_FINAL = /^[\x40-\x7e]/
const CTRL_NAMES: Record<number, string> = {
  0x00: '@', 0x01: 'a', 0x02: 'b', 0x03: 'c', 0x04: 'd', 0x05: 'e', 0x06: 'f',
  0x07: 'g', 0x0b: 'k', 0x0c: 'l', 0x0e: 'n', 0x0f: 'o', 0x10: 'p', 0x11: 'q',
  0x12: 'r', 0x13: 's', 0x14: 't', 0x15: 'u', 0x16: 'v', 0x17: 'w', 0x18: 'x',
  0x19: 'y', 0x1a: 'z', 0x1c: '\\', 0x1d: ']', 0x1e: '^', 0x1f: '_',
}

const MAX_BUFFER = 4 * 1024 * 1024

/** Stateful stdin key decoder; feed chunks, receive complete events. */
export class KeyDecoder {
  private buf: Uint8Array = new Uint8Array(0)

  /** Feed one stdin chunk; returns all events that became complete. */
  push(chunk: Buffer): KeyEvent[] {
    if (this.buf.length + chunk.length > MAX_BUFFER) {
      this.buf = new Uint8Array(0)
      throw new Error('输入超过 4 MiB，已丢弃；请缩短粘贴内容')
    }
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const events: KeyEvent[] = []
    for (;;) {
      const event = this.takeOne()
      if (event === undefined) break
      events.push(event)
    }
    return events
  }

  get hasPendingBytes(): boolean { return this.buf.length > 0 }

  get pendingEscape(): boolean {
    return this.buf.length === 1 && this.buf[0] === ESC
  }

  /** Called only after a short idle interval distinguishes Escape from CSI/Alt. */
  flushEscape(): KeyEvent[] {
    return this.pendingEscape ? [this.giveUpEscape()] : []
  }

  private takeOne(): KeyEvent | undefined {
    const b = this.buf
    if (b.length === 0 || b.length > MAX_BUFFER) return undefined
    const head = b[0]
    if (head === undefined) return undefined
    if (head === ESC) {
      if (startsWith(b, PASTE_START)) {
        const end = indexOfBytes(b, PASTE_START.length, PASTE_END)
        if (end === -1) return undefined // wait for the rest of the paste
        const text = utf8Decode(b.subarray(PASTE_START.length, end))
        this.buf = b.subarray(end + PASTE_END.length)
        return { name: 'paste', ctrl: false, alt: false, text }
      }
      if (b[1] === 0x5b) {
        // CSI: ESC [ params final. Wait until a final byte arrives.
        const body = CSI_BODY.exec(latin1(b, 2))?.[0] ?? ''
        const afterBody = 2 + body.length
        const finalByte = latin1(b, afterBody, afterBody + 1)
        if (!CSI_FINAL.test(finalByte)) {
          return finalByte.length === 0 ? undefined : this.giveUpEscape()
        }
        const seq = latin1(b, 0, afterBody + 1)
        this.buf = b.subarray(afterBody + 1)
        return decodeCsi(seq)
      }
      if (b.length >= 2) {
        // Alt + char: decode one complete UTF-8 scalar after ESC.
        const len = utf8Length(b[1] ?? 0)
        if (b.length < 1 + len) return undefined
        const text = utf8Decode(b.subarray(1, 1 + len))
        this.buf = b.subarray(1 + len)
        if (text === '\r' || text === '\n') return { name: 'alt-enter', ctrl: false, alt: true, text: '' }
        return { name: 'char', ctrl: false, alt: true, text }
      }
      return undefined
    }
    if (head === 0x0d) {
      this.buf = b.subarray(1)
      return { name: 'enter', ctrl: false, alt: false, text: '' }
    }
    if (head === 0x0a) {
      this.buf = b.subarray(1)
      return { name: 'newline', ctrl: false, alt: false, text: '\n' }
    }
    if (head === 0x09) {
      this.buf = b.subarray(1)
      return { name: 'tab', ctrl: false, alt: false, text: '\t' }
    }
    if (head === 0x7f || head === 0x08) {
      this.buf = b.subarray(1)
      return { name: 'backspace', ctrl: head === 0x08, alt: false, text: '' }
    }
    if (head < 0x20) {
      this.buf = b.subarray(1)
      const label = CTRL_NAMES[head] ?? 'unknown'
      return { name: `ctrl-${label}`, ctrl: true, alt: false, text: '' }
    }
    const len = utf8Length(head)
    if (b.length < len) return undefined // incomplete UTF-8 scalar: wait
    const text = utf8Decode(b.subarray(0, len))
    this.buf = b.subarray(len)
    return { name: 'char', ctrl: false, alt: false, text }
  }

  /** ESC followed by something that cannot extend a sequence: emit Escape. */
  private giveUpEscape(): KeyEvent {
    this.buf = this.buf.subarray(1)
    return { name: 'escape', ctrl: false, alt: false, text: '' }
  }
}

function decodeCsi(seq: string): KeyEvent {
  const params = seq.slice(2, -1)
  const final = seq.at(-1) ?? ''
  const mod = Number.parseInt(params.split(';')[1] ?? '1', 10)
  const ctrl = Number.isFinite(mod) && mod >= 5 && mod <= 8
  const plain = { ctrl: false, alt: false, text: '' }
  switch (final) {
    case 'A': return { name: 'up', ...plain }
    case 'B': return { name: 'down', ...plain }
    case 'C': return { name: 'right', ctrl, alt: false, text: '' }
    case 'D': return { name: 'left', ctrl, alt: false, text: '' }
    case 'H': return { name: 'home', ...plain }
    case 'F': return { name: 'end', ...plain }
    default:
      break
  }
  if (final === '~') {
    if (params === '3') return { name: 'delete', ...plain }
    if (params === '1' || params === '7') return { name: 'home', ...plain }
    if (params === '4' || params === '8') return { name: 'end', ...plain }
    if (params === '5') return { name: 'pageup', ...plain }
    if (params === '6') return { name: 'pagedown', ...plain }
  }
  return { name: 'escape', ...plain }
}

function startsWith(b: Uint8Array, prefix: readonly number[]): boolean {
  if (b.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (b[i] !== prefix[i]) return false
  }
  return true
}

function indexOfBytes(haystack: Uint8Array, from: number, needle: readonly number[]): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function latin1(b: Uint8Array, start: number, end?: number): string {
  let out = ''
  const stop = end ?? b.length
  for (let i = start; i < stop && i < b.length; i += 1) {
    out += String.fromCharCode(b[i] ?? 0)
  }
  return out
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf8', { fatal: false }).decode(bytes)
}

function utf8Length(byte: number): number {
  if (byte < 0x80) return 1
  if (byte >= 0xc2 && byte <= 0xdf) return 2
  if (byte >= 0xe0 && byte <= 0xef) return 3
  if (byte >= 0xf0 && byte <= 0xf4) return 4
  return 1 // invalid lead byte: consume one byte, never stall the stream
}

/** Decode a complete in-memory chunk (tests, one-shot use). */
export function decodeKeys(buffer: Buffer): KeyEvent[] {
  const decoder = new KeyDecoder()
  return [...decoder.push(buffer), ...decoder.flushEscape()]
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Split text into grapheme clusters (user-visible characters). */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment)
}

/** Split text into code points. */
export function codePoints(text: string): string[] {
  return Array.from(text)
}

/** Insert text at the grapheme cursor. */
export function insertAt(buffer: string, cursor: number, text: string): { buffer: string; cursor: number } {
  const units = graphemes(buffer)
  const at = Math.min(Math.max(cursor, 0), units.length)
  const inserted = graphemes(text)
  return {
    buffer: [...units.slice(0, at), ...inserted, ...units.slice(at)].join(''),
    cursor: graphemes(units.slice(0, at).join('') + text).length,
  }
}

/** Delete one grapheme before (back) or at (forward) the cursor. */
export function deleteOne(buffer: string, cursor: number, direction: 'back' | 'forward'): { buffer: string; cursor: number } {
  const units = graphemes(buffer)
  const at = Math.min(Math.max(cursor, 0), units.length)
  if (direction === 'back') {
    if (at === 0) return { buffer, cursor: at }
    return { buffer: [...units.slice(0, at - 1), ...units.slice(at)].join(''), cursor: at - 1 }
  }
  if (at >= units.length) return { buffer, cursor: at }
  return { buffer: [...units.slice(0, at), ...units.slice(at + 1)].join(''), cursor: at }
}

/**
 * Whether this key submits the buffer. Enter and Alt+Enter submit; Ctrl+J
 * (newline) and paste never submit.
 */
export function shouldSubmit(key: KeyEvent): boolean {
  return key.name === 'enter' || key.name === 'alt-enter'
}

/** Monospace display width of one grapheme (best effort: CJK/emoji wide). */
export function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0
  if (cp >= 0x0300 && cp <= 0x036f) return 0 // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

/** Total display width of a string. */
export function displayWidth(text: string): number {
  let width = 0
  for (const g of graphemes(text)) width += graphemeWidth(g)
  return width
}
