# 架构图资产

| 图 | 状态 | 矢量图 | 可编辑连线 |
|---|---|---|---|
| 01：控制面与两端 runtime | v1.0 | [SVG](01-current-runtime.svg) | [Mermaid](01-current-runtime.mmd) |
| 02：投切准备与提交时序 | v1.0 | [SVG](02-handoff-sequence.svg) | [Mermaid](02-handoff-sequence.mmd) |
| 03：TUI 与 ARC 插件组装 | v1.0 | [SVG](03-plugin-assembly.svg) | [Mermaid](03-plugin-assembly.mmd) |
| 04：多端、个人云与同步职责 | 目标设计 | [SVG](04-target-architecture.svg) | [Mermaid](04-target-architecture.mmd) |
| 05：Home、云与设备 B 的信任边界 | 目标设计 | [SVG](05-trust-boundaries.svg) | [Mermaid](05-trust-boundaries.mmd) |

Markdown 引用 SVG，保证 GitHub 和本地阅读器不因 Mermaid 支持不同而丢图。SVG 使用人工布局，Mermaid 保存可编辑的关系；两者修改时共同核对。`design.html` 内嵌 SVG，可离线查看，手机窄屏可横向滚动大图。

从仓库根目录生成：

```sh
python3 docs/diagrams/render.py
node tools/docs/build.mjs
node tools/docs/verify.mjs
```

生成 HTML 需要已有 `marked`，验证需要已有 `playwright` 和 Chromium。脚本默认从已安装的 distribution 依赖解析 marked；也可以将 `ARC_DOC_NODE_MODULES` 指向已有 Node 依赖目录。`ARC_DOC_CHROMIUM` 可指定已有 Chromium 可执行文件。脚本不会自动下载依赖或浏览器。

验证结果与预览截图默认写入被 git 忽略的 `artifacts/docs-check/`。检查覆盖五图、正文节数、SVG 文本边界与重叠、桌面/手机页面溢出、页面错误和离线资源；不替代产品功能验收，也不自动证明箭头语义正确。
