/** Community renderer adapter. ARC ownership lives exclusively in ArcController. */
import { ArcController } from '../dist/arc-controller.js';
import { TerminalUi, stripControlSequences } from '../dist/terminal-ui.js';
import { graphemes } from '../dist/line-editor.js';
import { loadRemoteConfig } from '../dist/remote-config.js';
import { readFileSync } from 'node:fs';
let workspace, projection, ready = false, pendingReset = true, lastConversation, closing = false;
let repaint = () => {}, noticeTimer;
export function arcStatus() { return projection?.arcStatus ?? 'ARC 连接中'; }
export function arcPermission() { return projection?.arcPermission || projection?.arcNotice || ''; }
export function arcCommand(name) {
  if (!projection) return;
  projection.arcNotice = name === 'help' ? 'ARC：Ctrl+R 投切 · Ctrl+G 重连 · Esc 中断\n/new 新会话 · /exit 退出 · 权限 Ctrl+Y 允许本次 / Ctrl+N 拒绝' : `模型 ${projection.model}\n原生会话 ${workspace?.activeUi?.sessionId ?? '连接中'}\n工作目录 ${projection.cwd}`;
  clearTimeout(noticeTimer); repaint();
  noticeTimer = setTimeout(() => { projection.arcNotice = ''; repaint(); }, 8000); noticeTimer.unref();
}
class CommunitySession extends TerminalUi {
  render() {} // Reuse tested session state/editor/permissions; never emit classic terminal frames.
}
export function consumeDraftReset() {
  if (!ready || !pendingReset) return null;
  pendingReset = false; return workspace.activeUi?.uiState.buffer ?? '';
}
export function draftChanged(value) { if (ready && !pendingReset) workspace.activeUi?.updateDraft(value); }
export function canSubmit(text = '') {
  const ui = workspace?.activeUi;
  if (!ready || closing || !ui) return false;
  if (workspace.switching || ui.running !== 'idle' || ui.pendingPermission || !workspace.connected) {
    ui.showError('当前不能发送，草稿保留；请等待回合结束或 Ctrl+G 恢复连接'); return false;
  }
  if (/^\s*[!/@]/.test(text)) { ui.showError('此入口暂不支持 !shell、@附件或未知斜杠命令，输入保留'); return false; }
  return true;
}
const consumed = new WeakSet();
export function interceptKey(input, key, event) {
  const token = event && typeof event === 'object' ? event : key;
  if (consumed.has(token)) return true;
  const result = handleKey(input, key);
  if (result) consumed.add(token);
  return result;
}
function handleKey(input, key) {
  const ui = workspace?.activeUi;
  if (!ui) return false;
  if (ui.pendingPermission) {
    if (key.pageUp || key.pageDown || key.wheelUp || key.wheelDown) return false;
    if (key.ctrl && input === 'y') ui.decidePermission('allow');
    else if ((key.ctrl && input === 'n') || key.escape) ui.decidePermission('reject');
    else if (key.ctrl && input === 'c') void ui.cancel();
    return true;
  }
  if (workspace.switching) {
    if (key.escape || key.ctrl && input === 'c') void ui.feed(Buffer.from('\x03'));
    return !!(key.return || key.tab || key.escape || key.ctrl && ['r', 'g', 'c'].includes(input));
  }
  if (key.ctrl && input === 'r') { void workspace.switchRuntime(); return true; }
  if (key.ctrl && input === 'g') { void workspace.switchRuntime(true); return true; }
  if (key.escape && ui.running !== 'idle') { void ui.cancel(); return true; }
  return false;
}
export function attachArc(channel, ctx) {
  const launch = JSON.parse(readFileSync(process.env.DSH_ARC_LAUNCH, 'utf8'));
  const p = { rows: [], agentId: 'arc-starting', status: 'starting', working: false, cancelPending: false,
    agentBindingGeneration: 0, model: '连接中', provider: 'runtime', configuredProvider: undefined, configuredModel: undefined,
    cwd: launch.config.cwd, displayCwd: launch.config.cwd, sessionTitle: 'ARC 连接中', sessionColor: '',
    loadedContext: undefined, contextWindow: undefined, lastUsage: undefined, contextSegments: {}, gitBranch: undefined,
    subagents: [], backgroundJobs: [], pending: [], todos: [], activeToolCount: 0, responseChars: 0,
    lastUserText: '', turnStart: 0, goal: undefined, reasoningEffort: undefined, autoRecapOnOpen: false,
    arcStatus: 'ARC 连接中', arcPermission: '', arcNotice: '',
    commandList: channel.commandList.filter(c => ['exit', 'quit', 'q', 'help', 'status', 'new'].includes(c.name)) };
  projection = p;
  for (const key of Object.keys(p)) Object.defineProperty(channel, key, { enumerable: true, configurable: true, get: () => p[key], set() {} });
  const refresh = () => {
    const ui = workspace?.activeUi;
    if (!ui || closing || !ready) return;
    const conversation = ui.conversation ?? 'arc-starting';
    if (lastConversation !== conversation) { lastConversation = conversation; pendingReset = true; p.agentBindingGeneration++; }
    p.agentId = conversation; p.model = launch.config.mode === 'demo' ? 'DEMO · 无模型' : stripControlSequences(workspace.model);
    const working = ui.running !== 'idle';
    if (working && !p.working) p.turnStart = Date.now();
    p.working = working; p.status = p.working ? 'running' : 'idle'; p.cancelPending = ui.running === 'cancelling';
    p.cwd = workspace.currentLocation === 'local' ? launch.config.cwd : launch.remote.cwd;
    p.displayCwd = `${workspace.currentLocation.toUpperCase()} ${p.cwd}`;
    p.sessionTitle = `ARC ${workspace.currentLocation.toUpperCase()} · Home ${workspace.home} · ${conversation.slice(0,8)}`;
    const restored = ui.projectionEntries.at(-1)?.text.startsWith('已恢复会话');
    p.arcStatus = `${p.sessionTitle} · ${!workspace.connected ? '已断开 Ctrl+G 重连' : workspace.switching ? '投切中 Esc 取消' : restored ? '已恢复会话' : '已连接'} · Ctrl+R 投切`;
    p.rows = []; const toolRows = new Map();
    for (const entry of ui.projectionEntries) {
      const content = stripControlSequences(entry.text);
      const id = entry.seq < 0 ? 1000000 - entry.seq : entry.seq + 1;
      if (entry.kind === 'tool') {
        const row = { id, kind: 'tool', text: '', tool: { callId: entry.toolCallId, name: content, argsText: '', status: 'running', startedAt: entry.time } };
        toolRows.set(entry.toolCallId, row); p.rows.push(row);
      } else if (entry.kind === 'tool_result' && toolRows.has(entry.toolCallId)) {
        const row = toolRows.get(entry.toolCallId); row.tool.resultText = content; row.tool.status = entry.toolStatus === 'failed' ? 'error' : entry.toolStatus === 'completed' ? 'ok' : 'running';
      } else p.rows.push({ id, kind: entry.kind === 'thought' ? 'reasoning' : ['user','assistant'].includes(entry.kind) ? entry.kind : 'notice', text: content, time: entry.time, streaming: !!entry.streaming, fresh: !!entry.streaming });
    }
    p.activeToolCount = [...toolRows.values()].filter(r => r.tool.status === 'running').length;
    const info = [ui.errorText, ui.unsavedWarning, ui.transitionNotice].filter(Boolean).join('\n');
    if (info) p.rows.push({ id: 2000001, kind: 'notice', text: stripControlSequences(info) });
    const permission = ui.pendingPermission;
    p.arcPermission = permission ? `权限请求：${stripControlSequences(String(permission.toolCall?.title ?? '工具操作')).slice(0,160)}\nCtrl+Y 仅允许本次 · Ctrl+N / Esc 拒绝 · PgUp/PgDn 查看完整请求` : '';
    if (permission) p.rows.push({ id: 2000002, kind: 'notice', text: stripControlSequences(`权限请求 · ${workspace.currentLocation.toUpperCase()}\n${permission.toolCall?.title ?? '工具操作'}\n${JSON.stringify(permission.toolCall?.rawInput ?? {})}\nCtrl+Y 仅允许本次 · Ctrl+N 拒绝 · Esc 拒绝`) });
    channel.emit();
  };
  repaint = refresh;
  const unsupported = name => { workspace?.activeUi?.showError(`社区 ARC MVP 暂不支持：${name}`); return false; };
  channel.submit = text => {
    if (!canSubmit(text)) return;
    const ui = workspace.activeUi; ui.restoreInput({ buffer: text, cursor: graphemes(text).length });
    void ui.submit();
  };
  channel.cancel = () => workspace?.activeUi?.cancel();
  channel.newSession = async () => {
    if (!canSubmit()) return false;
    const ok = await workspace.activeUi.createSession(); if (ok) { pendingReset = true; refresh(); } return ok;
  };
  for (const name of ['steer','interruptAndDeliver','runLocalCommand','resumeTo','rewindTo','rewindToNode','forkSession','switchWorkspace','switchModel','switchPreset','compact','backgroundCurrent','dispatchBackgroundAgent','attachToAgent','replyToAgent','sideQuestion','initWorkspace','runPermissionPreset','cycleMode','stageImage','stageComposerImage','runExternalCommandOutcome','exportSession','renameSession','deleteSession','runExternalCommand']) channel[name] = () => unsupported(name);
  channel.listSessions = async () => []; channel.listWorkspaces = async () => [];
  channel.listFiles = async () => []; channel.listFileCandidates = async () => [];
  channel.commandCompletions = () => []; channel.listSkills = () => [];
  channel.setResumeTarget = () => {}; channel.recapRecent = async () => undefined;
  const start = (async () => {
    const remote = launch.config.mode !== 'demo' && launch.remoteConfig ? await loadRemoteConfig(launch.remoteConfig, launch.remoteOptional) : undefined;
    launch.remote = remote;
    workspace = new ArcController(launch.config, remote, (client, store, config) => new CommunitySession(client, store, config, () => {}));
    workspace.onChange(refresh);
    await workspace.start(launch.fresh); ready = true; refresh();
  })().catch(async error => {
    p.arcStatus = 'ARC 启动失败；请查看错误，/exit 退出后处理';
    p.rows.push({ id: 2000003, kind: 'notice', text: `ARC 启动失败：${error.message}` }); channel.emit(); await workspace?.close();
  });
  ctx.effect(() => async () => { closing = true; const stopping = workspace?.close(); await start; await stopping; await workspace?.close(); }, 'ARC shared controller');
  return channel;
}
