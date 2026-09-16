# dsh-arc 1.0.0

Optional ARC capabilities for DeepSeek Harness, composed with its standard Cordis
Bundle/Profile mechanism. The release distribution is `@jasonning/dsh-arc`.

- `dsh-arc`: `ctx.arc` checkpoint export and durable session import, independent of a UI.
- `dsh-arc/checkpoint`: checkpoint validation and native event encoding.
- `dsh-arc/acp`: optional ACP Stream composition for `_dsh/checkpoint`, `_dsh/stream`
  and checkpoint-backed `session/new`. Normal ACP owns models, tools, approval and cancellation.
- `dsh-arc/tui`: optional commands and status consumer for a colocated workbench.

`dsh-arc-acp` and `dsh-arc-tui` are configuration-only bundles; they do not duplicate
this implementation. Ordinary tool plugins do not depend on ARC.

A checkpoint import creates a cold persisted session, releases its lock, then lets
native ACP resume it. It does not replay tools, move credentials or copy project files.
Logical conversation identity and Home remain separate from native runtime session IDs.

For full handoff, pair the runtime bundles with `dsh-arc-execution` and the versioned
TUI execution-interface extension. The npm distribution assembles these automatically.
See the repository README for native and Docker setup.

Build and test from the repository root:

```sh
npm ci --prefix plugins/dsh-arc
npm test --prefix plugins/dsh-arc
```
