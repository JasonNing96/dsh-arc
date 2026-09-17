"""Render the five architecture figures as portable, offline SVG assets."""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COLORS = {"blue": "#315bd6", "teal": "#087f83", "muted": "#66758d", "purple": "#7c55bb"}
PALETTE = {
    "plain": ("#ffffff", "#ccd5e3"),
    "blue": ("#eef3ff", "#9eb6f1"),
    "teal": ("#eaf8f6", "#8ecdc6"),
    "purple": ("#f5effc", "#c6afe5"),
    "muted": ("#f4f6fa", "#d9e0ea"),
}


class Figure:
    def __init__(self, name, title, height, status):
        self.name = name
        self.height = height
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="{height}" viewBox="0 0 1280 {height}" role="img" aria-labelledby="{name}-title">',
                      f'<title id="{name}-title">{escape(title)}</title>',
                      '<style>text{font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif;fill:#1b2b45} .small{fill:#617088}</style>',
                      '<rect width="1280" height="100%" fill="#fff"/>', '<defs>']
        for key, color in COLORS.items():
            self.parts.append(f'<marker id="{name}-{key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{color}"/></marker>')
        self.parts.append('</defs>')
        self.text(30, 40, title, 24, weight=650)
        self.text(30, 69, status, 15, color="#617088")

    def text(self, x, y, text, size=17, anchor="start", color=None, weight=400):
        style = f' style="fill:{color}"' if color else ''
        self.parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}"{style}>{escape(text)}</text>')

    def group(self, x, y, w, h, title, note="", planned=False):
        dash = ' stroke-dasharray="7 5"' if planned else ''
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="#f8fafd" stroke="#ced8e8" stroke-width="1.5"{dash}/>')
        self.text(x + 20, y + 29, title, 18, weight=600)
        if note:
            self.text(x + 20, y + 54, note, 14, color="#65748b")

    def box(self, x, y, w, h, title, lines=(), kind="plain", planned=False):
        bg, border = PALETTE[kind]
        dash = ' stroke-dasharray="6 4"' if planned else ''
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{bg}" stroke="{border}" stroke-width="1.4"{dash}/>')
        line_height = 23
        first = y + h / 2 - len(lines) * line_height / 2 + 6
        self.text(x + w / 2, first, title, 18, "middle", weight=600)
        for n, line in enumerate(lines, 1):
            self.text(x + w / 2, first + n * line_height, line, 15, "middle", color="#55657e")

    def edge(self, points, color="blue", both=False, planned=False):
        path = 'M ' + ' L '.join(f'{x} {y}' for x, y in points)
        marker = f'{self.name}-{color}'
        start = f' marker-start="url(#{marker})"' if both else ''
        dash = ' stroke-dasharray="7 5"' if planned else ''
        self.parts.append(f'<path d="{path}" fill="none" stroke="{COLORS[color]}" stroke-width="2" stroke-linejoin="round" marker-end="url(#{marker})"{start}{dash}/>')

    def label(self, x, y, text, color="blue", size=14):
        width = sum(size if ord(c) > 255 else size * .56 for c in text) + 16
        self.parts.append(f'<rect x="{x-width/2:.1f}" y="{y-size+1}" width="{width:.1f}" height="{size+8}" rx="4" fill="#fff" fill-opacity=".98"/>')
        self.text(x, y, text, size, "middle", COLORS[color])

    def save(self):
        self.parts.append('</svg>')
        (ROOT / f'{self.name}.svg').write_text('\n'.join(self.parts), encoding='utf-8')


def current():
    f = Figure('01-current-runtime', '01  当前运行架构｜工作台控制，两端执行', 900,
               'v1.0 已验收 · TUI 执行驱动组织控制面；ACP 承载消息、事件和检查点，各端独立执行')
    f.group(30, 96, 1220, 235, '电脑 · 工作台进程')
    f.box(60, 172, 300, 105, 'TUI 扩展版 + ARC driver', ['输入与草稿', '增量、工具与权限展示'])
    f.box(470, 172, 320, 105, 'ArcController', ['当前执行端 / 投切事务', '逻辑 conversationId / Home'], 'blue')
    f.box(925, 172, 290, 105, 'StateStore', ['会话镜像与草稿', '活动指针 active.json'], 'teal')
    f.edge([(360, 225), (470, 225)])
    f.label(415, 210, '投切 / 绑定', size=13)
    f.edge([(790, 225), (925, 225)], 'teal')
    f.label(858, 210, '持久化')
    f.group(30, 435, 590, 397, '电脑 · 本地 DSH runtime')
    f.group(660, 435, 590, 397, '服务器 · DSH runtime')
    for x, title in [(60, '本地'), (690, '服务器')]:
        f.box(x, 500, 530, 68, '标准 ACP + dsh-arc-acp', ['对话、取消、权限、ARC 扩展'])
        f.box(x, 645, 205, 84, 'dsh-arc', ['ctx.arc · 检查点'], 'teal')
        f.box(x + 285, 645, 245, 84, f'{title} Agent / Session', ['原生持久化'], 'blue')
        f.box(x, 771, 530, 42, f'{title}工具 / 工作区 / 模型路由', kind='muted')
        f.edge([(x + 95, 568), (x + 95, 645)], 'teal')
        f.label(x + 95, 611, '检查点')
        f.edge([(x + 411, 568), (x + 411, 645)])
        f.label(x + 411, 611, '普通对话 / 授权')
        f.edge([(x + 205, 688), (x + 285, 688)], 'teal')
        f.label(x + 245, 672, '导出 / 暂存', size=12)
        f.edge([(x + 410, 729), (x + 410, 771)])
    f.edge([(535, 277), (535, 375), (325, 375), (325, 500)], both=True)
    f.label(332, 371, 'AcpClient · 本地 stdio')
    f.edge([(725, 277), (725, 375), (955, 375), (955, 500)], both=True)
    f.label(961, 371, 'AcpClient · SSH stdio')
    f.text(35, 866, '请求与事件复用 ACP 连接；检查点经工作台中转。两端没有后台全量同步链路。', 16, color='#617088')
    f.save()


def handoff():
    f = Figure('02-handoff-sequence', '02  投切时序｜准备目标后，再提交可见执行端', 1090,
               '实现路径 · 同一逻辑会话与 Home 保留；目标使用新的原生 session')
    xs = [115, 365, 615, 865, 1135]
    for x, title in zip(xs, ['TUI / 用户', 'ARC 控制器', '源 runtime', '目标 runtime', '本地索引']):
        f.box(x - 90, 100, 180, 58, title, kind='blue' if x == 365 else 'plain')
        f.parts.append(f'<path d="M {x} 158 L {x} 983" stroke="#cbd5e4" stroke-width="1.5" stroke-dasharray="5 5"/>')
    def step(a, b, y, text, color='blue'):
        f.edge([(xs[a], y), (xs[b], y)], color)
        f.label((xs[a] + xs[b]) / 2, y - 12, text, color)
    step(0, 1, 208, '请求投切')
    f.box(235, 237, 460, 55, '检查：空闲、无待决权限；保留源端与草稿', kind='muted')
    step(1, 3, 340, '连接、初始化与能力检查')
    step(1, 2, 408, '请求当前会话检查点')
    step(2, 1, 476, '持久化屏障后的消息', 'teal')
    step(1, 3, 544, '暂存检查点并恢复目标原生 session', 'teal')
    step(3, 1, 612, '返回目标 sessionId 与连接状态', 'teal')
    f.box(235, 638, 700, 55, '准备阶段：没有发送新 prompt；用户仍在源端', kind='muted')
    f.parts.append('<rect x="220" y="718" width="1020" height="78" rx="12" fill="#eaf8f6" stroke="#8ecdc6"/>')
    step(1, 4, 765, '保存最终草稿、镜像与活动指针（提交边界）', 'teal')
    step(1, 0, 840, '发布目标端；保留对话与草稿')
    step(0, 1, 906, '下一条输入')
    step(1, 3, 967, '向已提交的目标发送 prompt')
    f.box(30, 1009, 595, 52, '提交前失败：保留源端', kind='muted')
    f.box(650, 1009, 600, 52, '提交后断连：恢复已提交端，不承诺副作用回滚', kind='muted')
    f.save()


def plugins():
    f = Figure('03-plugin-assembly', '03  插件组装｜界面、执行驱动与 runtime 分层', 980,
               'v1.0 已验收 · 配套 TUI 0.10.1-arc.1.0.0 提供执行接口扩展；不代表上游已经接受。')
    f.group(30, 110, 1220, 455, '工作台 Profile · arc-ui')
    f.box(65, 220, 285, 100, 'TUI 编辑与展示', ['Chat / PromptInput', '流式事件 / 权限交互'])
    f.box(480, 220, 320, 100, '通用会话执行接口', ['提交 / 订阅 / 取消', '权限 / 快照 / 关闭'], 'blue')
    f.box(930, 175, 280, 76, '默认原生驱动', ['未启用 ARC 的路径'], 'muted')
    f.box(915, 355, 295, 90, 'dsh-arc-execution', ['可选 ARC driver'], 'teal')
    f.box(480, 440, 320, 85, 'ArcController + StateStore', ['会话映射 / Home / 草稿 / 提交'], 'teal')
    f.edge([(350, 270), (480, 270)])
    f.edge([(800, 242), (860, 242), (860, 213), (930, 213)], 'muted')
    f.edge([(800, 285), (855, 285), (855, 400), (915, 400)], 'teal')
    f.label(933, 306, 'driverId: arc', 'teal')
    f.edge([(1060, 445), (1060, 483), (800, 483)], 'teal')
    f.group(30, 655, 1220, 230, '两个独立 runtime Profile · arc-runtime（本地、SSH 服务器或容器）')
    f.box(75, 745, 310, 82, '标准 ACP + dsh-arc-acp', ['对话、权限与 ARC 扩展'])
    f.box(485, 745, 280, 82, 'dsh-arc · ctx.arc', ['检查点导出 / 校验 / 导入'], 'teal')
    f.box(865, 745, 335, 82, 'DSH Agent / Session / Tools', ['各端自己的模型与工作区'])
    f.edge([(570, 525), (570, 610), (15, 610), (15, 786), (75, 786)], both=True)
    f.label(330, 600, '本地 stdio / SSH stdio')
    f.edge([(385, 786), (485, 786)], 'teal')
    f.edge([(765, 786), (865, 786)], 'teal')
    f.edge([(230, 827), (230, 859), (1030, 859), (1030, 827)])
    f.label(630, 858, '标准对话、工具与权限仍由原生 DSH 负责')
    f.text(35, 935, '普通工具无需依赖 ARC；dsh-arc-tui 是另一种同进程命令集成，不是完整投切的必装组件。', 16, color='#617088')
    f.save()


def target():
    f = Figure('04-target-architecture', '04  目标架构｜多端协同，云同步与云执行分离', 1070,
               '目标设计 · 图中的 ARC 协作契约是逻辑接口，不要求部署中央 ARC 服务器。')
    f.box(200, 107, 880, 77, '一个用户 · 电脑 / 手机 / 自定义工作台', ['当前以 TUI 为主；移动入口与多端并发规则后续验证'])
    f.box(160, 263, 960, 94, 'ARC 协作契约', ['Home 与承接关系 · 信息交付范围 · 授权检查接入 · 审计关联'], 'purple', True)
    f.edge([(640, 184), (640, 263)], 'purple', planned=True)
    specs = [(35, '电脑 runtime', '可作为 Home；现场信息与本地工具', '本地或在线模型 provider'),
             (455, '个人云 runtime', '可作为 Home；承接云端任务', '云端模型 provider'),
             (875, '设备 B runtime', '独立资源授权与查询工具', '工程资料 / 数据库')]
    for x, title, desc, sub in specs:
        f.group(x, 458, 370, 300, title, planned=True)
        f.box(x + 20, 531, 330, 84, desc.split('；')[0], [desc.split('；')[1]] if '；' in desc else [], 'blue')
        f.box(x + 20, 675, 330, 58, sub, kind='teal')
        f.edge([(x + 185, 615), (x + 185, 675)], planned=True)
    for cx, label in [(220, '投切 / 范围委派'), (640, '投切 / 范围委派'), (1060, '受限资源请求')]:
        f.edge([(cx, 357), (cx, 531)], 'purple', planned=True)
        f.label(cx, 411, label, 'purple')
    f.box(160, 894, 960, 87, '可选同步服务', ['获准对话、工作记录、关键资产与版本；不需要为同步启动 Agent'], 'teal', True)
    f.edge([(120, 758), (120, 937), (160, 937)], 'teal', planned=True)
    f.label(230, 831, '获准同步 · 电脑', 'teal')
    f.edge([(640, 758), (640, 894)], 'teal', planned=True)
    f.label(640, 831, '获准同步 · 云端', 'teal')
    f.edge([(1080, 145), (1260, 145), (1260, 937), (1120, 937)], 'teal', planned=True)
    f.label(1150, 831, '查看获准内容', 'teal')
    f.text(35, 1035, '同一人的逻辑个人云不等于单个物理进程。Home、执行位置、推理位置与云保留策略分别表达。', 16, color='#617088')
    f.save()


def trust():
    f = Figure('05-trust-boundaries', '05  受限委派｜每个资源边界独立检查', 1110,
               '目标场景 · 本地邮件工作保持 Home；云只承接获准调研；设备 B 自行决定可返回的信息。')
    for x, title in [(30, '本地 · Home 信任边界'), (450, '云 · 协作 runtime 边界'), (870, '设备 B · 资源边界')]:
        f.group(x, 105, 380, 875, title, planned=True)
    f.box(55, 188, 330, 82, '选定邮件 / 私有背景', ['登录状态不等于全量读取授权'])
    f.box(55, 350, 330, 92, '划定子任务与外发材料', ['限定问题、字段与接收方'], 'teal')
    f.box(475, 350, 330, 92, '承接范围内调研', ['保留主任务 Home'], 'blue')
    f.box(475, 530, 330, 82, '获准公开搜索', ['搜索词也需要出站范围检查'])
    f.box(895, 350, 330, 92, '独立授权检查', ['任务 / 请求方 / 资源 / 接收方'], 'purple')
    f.box(895, 530, 330, 82, '工程数据库 / 查询工具', ['确定性权限限制实际访问'])
    f.box(895, 698, 330, 82, '结果出站检查', ['记录获准范围与实际交付对象'], 'teal')
    f.box(475, 825, 330, 92, '调研结果与引用', ['关联执行记录、返回本地'])
    f.box(55, 825, 330, 92, '核对结果，完成本地文书', ['结合未外发的私有背景'])
    f.edge([(220, 270), (220, 350)])
    f.edge([(385, 396), (475, 396)], 'teal')
    f.label(430, 325, '仅交付获准材料', 'teal', 13)
    f.edge([(640, 442), (640, 530)])
    f.edge([(640, 612), (640, 825)])
    f.edge([(735, 350), (735, 295), (1060, 295), (1060, 350)], 'purple')
    f.label(920, 285, '另行申请工程信息', 'purple')
    f.edge([(1060, 442), (1060, 530)], 'purple')
    f.edge([(1060, 612), (1060, 698)], 'teal')
    f.edge([(895, 739), (840, 739), (840, 476), (735, 476), (735, 442)], 'teal')
    f.label(834, 668, '获准结果', 'teal', 13)
    f.edge([(475, 871), (385, 871)], 'teal')
    f.label(430, 804, '回收结果与引用', 'teal', 13)
    for x, label in [(220, '本地记录：依据 / 交付 / 采用'), (640, '云端记录：承接 / 工具 / 来源'), (1060, 'B 端记录：访问 / 判断 / 出站')]:
        f.text(x, 954, label, 14, 'middle', '#617088')
    f.box(30, 1004, 1220, 72, '读取、处理、外发、保存、转委派分别授权', ['Home 权限不自动传给云；多层审计不自动等于防篡改证明'], 'muted')
    f.save()


if __name__ == '__main__':
    for render in [current, handoff, plugins, target, trust]:
        render()
    print('Rendered 5 SVG figures')
