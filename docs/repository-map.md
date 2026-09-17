# 开源仓库导航

公开仓库只包含可发布源码、构建输入、文档与许可证。运行数据、主机配置、密钥、私有设计手稿与原项目 git 历史在仓库之外。

```text
dsh-arc/
  README.md                    安装、启动、SSH / Docker、升级与使用范围
  BUILDING.md                  从锁定源码构建发行包
  VALIDATION.md                验收平台、证据范围与限制
  LICENSE                      项目许可证
  THIRD_PARTY_NOTICES.md        上游来源和 TUI 扩展版本说明
  docs/
    README.md                  文档入口
    design.md                  当前设计总稿（内容原稿）
    design.html                自包含离线图文版（生成产物）
    history.md                 设计沿革与被替代的旧操作
    repository-map.md          本文件
    diagrams/                  SVG、Mermaid 源码及渲染脚本
  plugins/
    dsh-arc/                   ctx.arc；检查点和集成实现
    dsh-arc-acp/               ACP 集成 Bundle 配置
    dsh-arc-execution/         独立 TUI 执行驱动
    dsh-arc-tui/               可选同进程命令/状态集成 Bundle
  tui/
    src/                       控制器、传输、状态及保留的旧入口
    test/                      控制器与 UI 等回归用例
    community/                 历史界面适配辅助文件
  distribution/
    dsh-arc-cli/                安装器、运行入口、锁文件和发行组件
    docker/                    Dockerfile
    upstream/                  TUI 接口扩展 patch 与对应源码包
  tools/
    build-arc-distribution.py   构建 ARC 与配套 TUI
    prepare-arc-native.py       按锁文件准备并校验原生组件
    pack-arc-release.py         隔离打包，保持构建清单不变
    export-arc-release.py       显式白名单源码导出
    docs/                      离线文档生成与布局检查
  .github/workflows/           镜像与 Release 资产工作流
  export-manifest.json         导出来源白名单记录，非运行时配置
```

## 从问题定位代码

| 要修改的行为 | 首先阅读 |
|---|---|
| 投切、Home、目标提交和失败恢复 | [ArcController](../tui/src/arc-controller.ts) |
| 活动端索引、草稿、会话镜像与锁 | [StateStore](../tui/src/state-store.ts) |
| UI 与 driver 的组合 | [执行驱动](../plugins/dsh-arc-execution/src/index.ts)、[上游接口 patch](../distribution/upstream/upstream-extension.patch) |
| 检查点内容与限制 | [checkpoint.ts](../plugins/dsh-arc/src/checkpoint.ts) |
| ARC 能力与标准 ACP 组合 | [ARC 服务](../plugins/dsh-arc/src/index.ts)、[ACP 集成](../plugins/dsh-arc/src/acp.ts) |
| SSH / Docker 远端参数 | [remote-config.ts](../tui/src/remote-config.ts)、[ACP 客户端](../tui/src/acp-client.ts) |
| 初始化、升级、安装位置 | [安装器](../distribution/dsh-arc-cli/src/installation.mjs)、[CLI](../distribution/dsh-arc-cli/src/cli.mjs) |

`tui/src` 目前仍是控制器和会话客户端的唯一源码来源。`dsh-arc-execution` 将需要的依赖图编译进自己的包；它不依赖经典 TerminalUi、旧 community loader 或 runtime hook。保留旧入口供历史回归使用，不代表新分发仍靠源码替换运行。本次整理不移动这些源码，避免改变构建路径与既有验收基线。

每个 npm 包保留自己的清单与锁文件。`node_modules`、`lib`、`dist` 和本地测试 `artifacts` 是生成内容，不进入 git。发行所需的 vendor/upstream tarball 是明确保留的构建输入，不能当普通临时文件删除。

## 文档维护

正文改 `docs/design.md`，连线语义改对应 `.mmd`，静态布局改 `docs/diagrams/render.py`。SVG 是人工布局的对应图，需核对与 Mermaid 关系一致。重新生成和校验的命令见 [图形说明](diagrams/README.md)。
