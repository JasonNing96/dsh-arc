# DSH 独立客户端与插件管理调查

日期：2026-09-17。问题：是否已有类似一体化桌面工作台的客户端，把 DSH 插件发现、安装、配置和管理集中起来，降低使用门槛？

方法：读取项目当前 README、产品说明与 GitHub Releases/资产列表。未下载安装、未运行客户端，以下功能属于项目公开说明，不是本机实测结果；release tag 不保证默认分支所有功能都已发布。相同的“DSH Desktop”名称对应多个独立项目，必须同时记录仓库所有者。

## 判断

已有多种可以下载的独立客户端。它们覆盖了桌面化、插件市场和本地管理；跨产品统一的兼容判断、环境发现与跨 runtime 工作接续仍需要额外的协议与适配。

如果“类似 Notion”指统一侧栏、对话工作区、扩展中心和图形化配置，FlashingChen/dsh-desktop-hub 最贴近这一产品形态。如果主要希望管理已有 DSH profile，MAXeaglet/dsh-plugin-manager 更直接。macOS 日常桌面入口可优先评估 anywhere-labs/dsh-desktop。以上是候选评估次序，不是已验证稳定性排名。

## 候选对照

| 项目 | 当前公开能力 | 平台与发行快照 | 边界 |
|---|---|---|---|
| [DSH Desktop Hub](https://github.com/FlashingChen/dsh-desktop-hub) | 同窗口的 Harness、Plugin、MCP、Skills 管理；内置运行时；扩展目录与图形化配置 | v0.3.8，2026-08-28；macOS arm64 DMG、Windows x64 EXE | README 标为预览版；目前固定 web profile，profile 切换仍在 roadmap；不能推断管理任意 ARC_HOME |
| [DSH Desktop / anywhere-labs](https://github.com/anywhere-labs/dsh-desktop) | 自带运行环境、工作配置、更新与恢复；内置 Community Market 发现、安装、卸载 | v2.0.10，2026-09-13；macOS Universal DMG、Windows x64 EXE | Market 针对当前 Desktop Profile；其当前市场文档明确不提供启用/禁用，不能把其他市场的功能套在它身上 |
| [dsh-plugin-manager](https://github.com/MAXeaglet/dsh-plugin-manager) | 独立 Tauri GUI + CLI；profile 切换；插件启停、安装、移除、排序、JSON 配置、导入导出与启动 Web | v0.2.5，2026-08-15；macOS Apple Silicon、Windows、Linux 安装资产 | 直接管理 profile 文件；不挂载为 DSH 插件；与当前 DSH 版本、ARC 非默认数据目录的兼容尚未实测 |
| [EAC Launcher](https://github.com/zouyuxuan122/DSH-EAC-Launcher) | 多实例、版本升级/回退、插件市场、快照回滚、启动故障诊断 | v1.1.0，2026-09-05；Windows x64 EXE | EAC 专用实例管理器，不能宣称所有 DSH 发行物通用；目录隔离不等于安全沙箱 |
| [DSH Desktop / qinyre](https://github.com/qinyre/dsh-Desktop) | 自带运行时和市场，Skills/MCP 管理；插件启动故障隔离及独立托盘管理入口 | v0.1.19，2026-09-04；Windows、Linux | 当前发行资产没有 macOS；故障识别与恢复能力本轮未实测 |
| [dsh-dpx](https://github.com/T-Auto/dsh-dpx) | 命名隔离环境、安装、发现、启动，采用 dsh-distribution 描述符 | desktop-v0.2.7，2026-09-16；Windows 桌面 EXE | 实验性、Windows 优先；macOS/Linux 主要是 CLI 环境，不是现成的跨平台图形插件中心 |

EAC 主客户端另见 [DSH-EAC/DSH-Desktop-EAC](https://github.com/DSH-EAC/DSH-Desktop-EAC)：公开介绍包含插件市场、保护中心和多种桌面功能。发行列表并存 v5、AIO 与 v6 alpha，9 月 13 日的最新条目为 `aio-v6.9.3-alpha.1`；不能把各版本功能与安装包混为一个已验证稳定产品。

## 管理界面与规范的区别

这些客户端能降低“安装、配置、查看和恢复”的门槛。界面统一仍不能证明任意插件组合兼容：插件的 DSH 版本要求、服务依赖、配置、私有状态与运行端授权仍有各自边界。

独立的 [dsh-market](https://github.com/dsh-market/dsh-market/blob/main/README.zh.md) 可被不同桌面项目复用。其公开说明包括插件浏览、宿主版本要求展示、安装、启停与更新等；它是装进 DSH 的市场插件，与 anywhere-labs 的 Community Market 不是同一个包。目录收录、静态兼容声明和实际运行测试也不是同一层证据。

## 与 ARC 的关系

建议继续让桌面客户端管理交互、扩展和本地配置，让 ARC 专注运行环境接入与同一工作接续。后续可给客户端提供选端、能力检查、投切和状态展示接口，无需先自行开发另一整套桌面工作台或插件市场。

潜在适配评估首先检查：

1. 能否针对独立数据目录/profile 试用，保留现有正式 ARC 环境；
2. 使用哪个 DSH 版本、是否暴露可替换执行接口，而非只有插件安装按钮；
3. 插件安装位置属于工作台还是目标 runtime；
4. 能否消费稳定 runtime 身份，清楚显示 Home 与当前执行端；
5. 关闭窗口、断连和重新启动后，接力状态与原生会话如何恢复。

本轮未验证任何桌面产品可直接接管现有 ARC 投切。独立管理器也不能因能编辑普通 profile，就被描述为自动识别我们的发行布局。

## 发行与功能来源

- [Hub README](https://github.com/FlashingChen/dsh-desktop-hub)、[v0.3.8 发行](https://github.com/FlashingChen/dsh-desktop-hub/releases/tag/v0.3.8)
- [anywhere-labs Desktop README](https://github.com/anywhere-labs/dsh-desktop)、[v2.0.10 发行](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.10)
- [Community Market 当前操作边界](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-market/README.zh.md)
- [独立 Plugin Manager](https://github.com/MAXeaglet/dsh-plugin-manager)、[v0.2.5 发行](https://github.com/MAXeaglet/dsh-plugin-manager/releases/tag/v0.2.5)
- [EAC Launcher](https://github.com/zouyuxuan122/DSH-EAC-Launcher)、[v1.1.0 发行](https://github.com/zouyuxuan122/DSH-EAC-Launcher/releases/tag/v1.1.0)
- [qinyre Desktop](https://github.com/qinyre/dsh-Desktop)、[v0.1.19 发行](https://github.com/qinyre/dsh-Desktop/releases/tag/v0.1.19)
- [DPX README](https://github.com/T-Auto/dsh-dpx)、[desktop-v0.2.7 发行](https://github.com/T-Auto/dsh-dpx/releases/tag/desktop-v0.2.7)
- [EAC 主客户端发行列表](https://github.com/DSH-EAC/DSH-Desktop-EAC/releases)

已确认的社区方向与上轮证据见 [社区贡献路线调查](dsh-community-contribution-2026-09-17.md)。
