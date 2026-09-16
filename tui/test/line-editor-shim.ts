/**
 * Test shim: build first, then import the built line-editor. Tests import
 * this module, which re-exports from ../dist so `npm test` (which runs tsc
 * then node --test) always exercises compiled output.
 */

export { KeyDecoder, decodeKeys, deleteOne, insertAt, shouldSubmit, graphemes, codePoints } from '../dist/line-editor.js'
export { stripControlSequences as stripControl } from '../dist/terminal-ui.js'
