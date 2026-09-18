# 文档导航

本次整合于 2026-09-18，运行行为仍以 v1.0 为基线。

| 阅读目的 | 入口 | 文档性质 |
|---|---|---|
| 安装并开始使用 | [安装与使用](usage.md) | 当前命令与限制 |
| 理解内核、连线与插件组装 | [设计总稿](design.md) | 已实现架构与明确标记的目标设计 |
| 查看下一阶段要解决的问题 | [技术路线](next-stage.md) | 已确认目标、候选方案及验收出口 |
| 理解社区定位 | [社区贡献方向](community-direction.md) | 已确认的贡献目标 |
| 核对协议与参与规则 | [社区接口调查](research/dsh-community-contribution-2026-09-17.md) | 2026-09-17 证据快照 |
| 了解可复用桌面入口 | [客户端与插件管理调查](research/dsh-desktop-plugin-management-2026-09-17.md) | 公开说明核对，未实测适配 |

## 图形、历史与源码

- [离线图文版](design.html)：单文件，内嵌五张 SVG，不依赖 Figma 权限或在线图表服务。下载后用浏览器打开。
- [图形资产](diagrams/README.md)：五张 SVG 与对应 Mermaid 源码。
- [设计沿革](history.md)：解释从三端设想到 v1.0 插件分发的取舍。
- [仓库导航](repository-map.md)：从需求找到源码、构建工具与配置。
- [安装与使用](usage.md)、[源码构建](../BUILDING.md)、[验收范围](../VALIDATION.md)。

当前命令以 usage 为准，实现范围以设计总稿和 VALIDATION 为准；技术路线不扩大当前功能保证。调查与历史记录保存当时结论，不覆盖后来的实现证据。外部协议进入实现前重新核对并固定版本。修改运行行为时同步修改相关章节和图形，未来方案必须明确标识。

## Documentation in English

The project README, build instructions and validation summary are in English.
The consolidated design note is currently in Chinese; its editable diagrams use
English component and API names. `design.html` is an offline reading copy of
`design.md`, not a separate source of truth.
