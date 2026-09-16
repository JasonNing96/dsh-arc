# dsh-arc-execution 1.0.0

ARC 的独立 TUI 执行驱动 Bundle。当前依赖本仓库归档的 **上游 session-execution 接口候选补丁**；配套分发版本为 `0.10.1-arc.1.0.0`，npm 原版 TUI 0.10.1 尚没有该接口。

核心控制器和 ACP 会话代码仍只有 `tui/src/` 一份来源。本包的 TypeScript 构建将所需依赖图编译到 `lib/`，tarball 自包含，不引用开发机路径，不加载 TerminalUi、community/loader 或 runtime-hook。两端必须显式配置装有 `dsh-arc` + `dsh-arc-acp` 的 Profile。

安装到含候选 TUI 的独立 Profile 后，配置 `arc-execution` 行的 `local: { cwd, dshHome, stateDir, dshExecutable, arcProfile }`，其中 `dshExecutable` 是 DSH 的 Node CLI 入口文件。自定义 `dsh-tui` 行的 config 时需同时写 `driverId: arc`，后置补丁会整体替换该对象。可选 `remoteConfig` 指向含 `arcProfile` 的现有 SSH JSON 配置。

- `/arc status`：逻辑会话、实际 session、工作目录、Home 和执行端。
- `/arc switch`：空闲时检查点投切。
- `/arc reconnect`：断线后恢复原端会话。
- 默认 `Alt+X` 投切、`Alt+G` 重连。可配置 `switchShortcut` / `reconnectShortcut`，空串关闭；冲突时显示警告并保留命令入口。

同一逻辑会话保留文本历史和草稿；投切不更改 Home。附件、shell、原生 fork/模型切换等未声明的能力明确拒绝。退出与卸载释放本次连接和状态锁，持久化文件仍保留。

安装、升级与使用边界见仓库 README。该公开执行接口扩展尚未被上游接受。
