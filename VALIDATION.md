# v1.0 validation — 2026-09-16

- Core: 9 unit tests passed. TUI/controller: 109 unit tests passed.
- CLI lifecycle: 4 tests passed (initialization, rollback, upgrade, data retention).
- Installed npm package: 11 real PTY checks passed with deterministic streamed model output.
- Docker (Linux arm64): 13 PTY checks passed, including same-conversation handoff,
  draft retention, restart after upgrade, cancellation, persistent native sessions and
  automatic container cleanup. This suite uses a local SSH stand-in and a loopback model.
- Container Bash/node-pty: non-root UID, `/workspace` mount and file access verified.
- Linux x64: the complete package installed offline on the SSH server.
- Real SSH + GLM-5.3-Flash: 8 checks passed using three submitted model prompts.
  Local → SSH → local retained the marker and exactly three user messages;
  both independent runtime processes exited cleanly. The test used the machine's
  configured SOCKS proxy for SSH after direct-network failures.

Required native binaries are included for macOS/Linux arm64/x64. Executable coverage
is macOS arm64, Linux arm64 Docker, and Linux x64 native. macOS x64 was not executed.

Earlier failed attempts remain in private development evidence: tarball file resolution,
peer dependency packaging, absent cross-platform native libraries, registry connection
resets, host socket exhaustion, and a corrected compressed-session filename assertion.
These failures were investigated, not counted as passing runs.

No business sessions, model keys, SSH keys, host configuration or private development
history are included in this public source export.
