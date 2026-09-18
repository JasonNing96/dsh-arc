# DSH ARC 社区贡献路线调查

日期：2026-09-17。方法：只读核对公开仓库文档、接口源码、GitHub Issues/PR、提交记录，以及本地 ARC v1 实现。没有联系维护者、提交 Issue/PR、转移仓库或安装标准适配器。下列外部状态是日期化快照，不代表已经达成合作。

## 用户确认的方向

下一阶段产品目标：**自主接入与可靠接续**。

社区贡献目标（用户明确认可）：

> “自主接入与可靠接续”可以继续作为下一阶段产品目标，但实现方案应先对照 `dsh-distribution` 的环境身份和 `dsh-std` 的连接边界。我们最值得建立的社区位置，是：ARC 持续提供真实的跨 runtime 接力案例，把公共接口的缺口测出来、补清楚，并让其他工作台能够复用。

这确立了产品与贡献方向；尚未提交上游提案或获得社区采纳。方向摘要见 [社区贡献方向](../community-direction.md)，工程推进边界见 [下一阶段技术路线](../next-stage.md)。

## 1. 结论与社区地图

ARC 有机会贡献公共接口需求、失败场景与一致性证据，继而争取作为独立接力范例收录。当前未发现一个统一机构能够授予覆盖整个 DSH 生态的“社区官方项目”身份。应区分：目录收录、协议贡献、实测兼容、共同维护、组织归属和 DeepSeek 官方采纳。

| 项目 | 调查时的事实 | ARC 参与机会 |
|---|---|---|
| anywhere-labs/dsh-desktop 中的 Community Fabric | Draft、文档为主；没有 runtime、SDK、正式 schema、认证；目录最近提交为 2026-08-16 的 `8734c2cd21db2b31e670c24d9361acdaf14b7e3c` | 聚焦 RFC 的设计反馈与实际反例；不能依赖其为现成 SDK |
| Yan-Zero/dsh-std | 已有协议类型、校验、协商、部分 adapter；整体 early drafts；9 月仍有代码与发布变更 | 优先讨论 Session 导入、连接恢复、跨实现测试 |
| T-Auto/dsh-distribution | Draft；环境身份、发现、数据归属、迁移计划和恢复日志模型；不提供真实文件迁移执行器 | 对齐运行环境与安装实例身份，避免 ARC 自造环境管理体系 |
| T-Auto/dsh-ecosystem-spec | 已重构为协议与范例索引；旧 TUI 时代规则移出工作树 | 独立范例收录；语义修改交给对应协议上游 |
| omdsh-dev/community | 非官方、独立的公共协作入口；强调项目自治 | 展示项目、跨项目提案和兼容问题协调 |

注意：Issue #23 早期链接的 `omdsh-dev/fabric` 当前跳转到 `omdsh-dev/stent`，是另一实现项目。不能把它与 Desktop 仓库内的 Community Fabric 文档草案混成同一仓库。

## 2. Fabric 四份 RFC 与 ARC 的关系

| RFC | 草案边界 | ARC 可提供的证据 |
|---|---|---|
| 0001 Manifest / Capability / Events | 静态声明、协商、generation 范围激活和生命周期；v0.1 刻意小；capability 不等于沙箱 | 缺少检查点能力时在写入前拒绝；插件可选组合 |
| 0002 Runtime / Presentation / Control / Transport / Invocation | 调用目标固定、逐次界面能力快照、独立授权、短期交互、取消与断连；不定义持久 session history | 本地 stdio / SSH 案例、断连失败、禁止隐式重放、目标隔离 |
| 0003 Service Providers / Composition | 明确 provider 选择、scope、冲突、替换和 ownership | 原生与 ARC 执行能力的显式选择；卸载与失败清理 |
| 0004 Provenance / Validation / Effect Ledger | 区分声明、解析、决定、观测、测试、证明；记录 effect 的来源和清理 | 导入来源、投切提交、失败恢复的脱敏证据 |

重要区别：attach 一个 runtime、切换显示视图、继续同一逻辑任务是不同操作。Fabric 的身份与 invocation 规则不能直接代替 ARC 的逻辑会话、Home 和检查点交付语义。RFC 0003 的 provider replacement 同样不自动等于跨 runtime 工作迁移。

## 3. 直接相关的接纳先例

`dsh-std` Issue #11：Portable session runtime capabilities for handoff workflows。

- 提案引用多个社区工作流，提出可协商的会话目录、历史、创建和控制需求。
- 维护者支持方向，要求分开 SessionCatalog、SessionHistory、WorkspaceSessions、AgentControl 与 Model。
- 普通 History client 不应有任意 `append(anyEvent)`；历史导入应使用专门的 `SessionImport` 并验证来源。
- 后续 `9c05b08` 落地部分目录和历史接口，维护者将问题关闭。关闭并不表示完整跨端接力已实现。
- 当前检查的 Session 包与 adapter 说明没有可直接承担 ARC 检查点导入的 SessionImport 实现。

另一个实际接纳先例是 PR #16：外部作者修复 SessionCatalog.create 重试覆盖标题，附回归证据、跨重启限制与明确边界，已合并。这说明小范围、可复现、有测试的贡献存在真实入口。

Issue #4 已讨论远程 Command、Session、Presentation 和 wire。维护者欢迎真实远程 fixtures；但早期评论不能覆盖后来更新的协议正文。当前 connection README 明确说明 consumer-facing ConnectionService / Host provider SPI 尚未完成，不能把设计提案当作完整可用实现。

## 4. 贡献规则与社区倾向

- **DSH 上游**：当前 CONTRIBUTING 不接受外部 PR；欢迎 Discussions、独立插件和文档贡献。官方包不天然比社区包更重要。
- **dsh-std**：Issue / PR 可讨论公共协议。协议变更同步 proposal、类型、校验器、schema、fixtures、测试及包 changelog；公共协议不指定唯一参考产品，产品集成放 adapter。
- **dsh-TUI**：功能先走 Discussions Ideas，由维护者建立跟踪 issue；实现 PR 仅限 write/admin/maintain 协作者或 APPROVED_CONTRIBUTORS。名单不是申请制。Remote PR #319 已关闭且未合并；公开评论不足以确定该 PR 的具体关闭原因，不能猜测。
- **Desktop / Fabric**：欢迎草案讨论；仓库 CONTRIBUTING 同时说明可能不接受与桌面必要功能无关或其他插件收录类 PR。因此先核对维护者接受范围。
- **ecosystem-spec**：协议语义交对应上游；本仓库收录协议、范例、Profile，不接受协议正文、实现代码、conformance suite 的直接复制。范例用 git submodule 固定 revision，并同步 registry 和说明。收录不等于认证，不任命唯一实现。
- **omdsh-dev**：参与不要求加入组织；项目地图是导航。治理文件仍为限时试点提案，规则须资产控制者确认；P-0001 标为 discussion。不能把文档合并理解为跨组织正式授权。

归纳判断：社区偏好可选接口、项目自治、明确失败边界、真实互操作证据。减少维护者审查负担，比提交覆盖多个领域的大改造更合适。

## 5. ARC 已有价值与缺口

已有工程基线：空闲边界投切、检查点大小和工具闭合校验、目标准备、持久化活动指针、提交前失败保留源端、提交后按目标恢复；不重放历史工具。

当前限制：

- 检查点主要为 `version / sourceCwd / messages`，来源提示已有，但完整的机器可验证来源记录、稳定导入身份与回执尚未建立。
- 逻辑会话和 Home 仍使用 local/remote；活动索引 scope 含远端配置，多端登记前须解决身份稳定性及数据迁移。
- ARC 当前 ACP 扩展不是 dsh-std Connection 实现，不能声明兼容；完整 TUI 投切仍依赖明确标识的接口扩展版。
- 当前交付模型可见上下文；不具备指定邮件材料授权、跨端权限同步或信息状态通用协议。

## 6. 建议路线（未执行）

1. 向 dsh-std 对应讨论贡献检查点导入场景：来源、边界、拒绝条件、响应丢失、重复请求和部分完成结果；先确认其归属。
2. 将目录/历史/连接等已有公共能力与 ARC 接力策略分离。Home 和信息状态算法继续作为 ARC 的开放演进内容，不要求进入元协议核心。
3. 在独立 fixture 中验证 TUI 与 headless 调用者；针对具体协议 revision 记录支持范围。无需等待整个标准稳定，也不做整体重写承诺。
4. 有真实互操作证据后，争取 ecosystem-spec 的独立范例收录和跨项目共同维护。

## 7. 一手资料

- [Fabric README](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/README.zh.md)
- [Fabric 提交记录](https://github.com/anywhere-labs/dsh-desktop/commits/master/dsh-community-fabric)
- [RFC 0001](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/docs/rfcs/0001-plugin-manifest-capabilities-events.zh.md)
- [RFC 0002](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/docs/rfcs/0002-runtime-presentation-invocation-transport.zh.md)
- [RFC 0003](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/docs/rfcs/0003-service-providers-and-composition.zh.md)
- [RFC 0004](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/docs/rfcs/0004-provenance-validation-and-diagnostics.zh.md)
- [Community #23](https://github.com/omdsh-dev/community/issues/23)
- [dsh-std #11：维护者意见](https://github.com/Yan-Zero/dsh-std/issues/11#issuecomment-5461521200)
- [dsh-std #11：部分实现完成](https://github.com/Yan-Zero/dsh-std/issues/11#issuecomment-5477598581)
- [dsh-std #4](https://github.com/Yan-Zero/dsh-std/issues/4)
- [dsh-std #7：参与方式](https://github.com/Yan-Zero/dsh-std/issues/7#issuecomment-5421836021)
- [dsh-std PR #16](https://github.com/Yan-Zero/dsh-std/pull/16)
- [Connection 当前实现边界](https://github.com/Yan-Zero/dsh-std/blob/main/packages/connection/README.zh.md)
- [DSH adapter 当前映射](https://github.com/Yan-Zero/dsh-std/blob/main/packages/adapter-dsh/README.zh.md)
- [dsh-std 仓库约定](https://github.com/Yan-Zero/dsh-std/blob/main/AGENTS.md)
- [DSH 上游贡献规则](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.zh.md)
- [TUI 贡献规则](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/contributing.md)
- [TUI Remote PR #319](https://github.com/ccch1mneyyy/dsh-TUI/pull/319)
- [Desktop 贡献规则](https://github.com/anywhere-labs/dsh-desktop/blob/master/CONTRIBUTING.md)
- [dsh-distribution](https://github.com/T-Auto/dsh-distribution)
- [生态索引治理](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/governance/README.md)
- [范例收录规则](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/directory-guide.md)
- [社区项目地图](https://github.com/omdsh-dev/community/blob/main/projects/README.zh-CN.md)
- [社区治理](https://github.com/omdsh-dev/community/blob/main/GOVERNANCE.zh-CN.md)

后续桌面入口调查见 [DSH 客户端与插件管理](dsh-desktop-plugin-management-2026-09-17.md)。
