import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const pins = JSON.parse(readFileSync(new URL('./source-pins.json', import.meta.url)));
const bridge = new URL('./bridge.mjs', import.meta.url).href;
function replace(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Community ARC patch anchor is not unique');
  return source.replace(anchor, replacement);
}
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  const key = Object.keys(pins).find(key => url.endsWith('/lib/types/' + key) && url.includes('dsh-tui'));
  if (!key) return result;
  let source = String(result.source);
  if (createHash('sha256').update(source).digest('hex') !== pins[key]) throw new Error('社区 ARC 版本不匹配，请使用 classic 入口：' + key);
  if (key === 'dsh-adapter/plugin.js') source = replace(source, "import { createChannel } from './channel.js';", `import { createChannel as createNativeChannel } from './channel.js';\nimport { attachArc } from ${JSON.stringify(bridge)};\nfunction createChannel(...args) { return attachArc(createNativeChannel(...args), args[0]); }`);
  if (key === 'screens/Chat.js') {
    source = `import { interceptKey, arcStatus, arcPermission, arcCommand } from ${JSON.stringify(bridge)};\n` + source;
    source = replace(source, 'useInput((input, key, event) => {', `useInput((input, key, event) => { if (interceptKey(input, key, event)) return;`);
    source = replace(source, 'handle?.scrollTo(0);\n            ink?.clearScrollbackAndRedraw();', 'handle?.scrollToBottom();\n            ink?.clearScrollbackAndRedraw();');
    source = replace(source, 'const runExternalCommand = (name, rawInput, images = []) => {', `const runExternalCommand = (name, rawInput, images = []) => { if (!['exit','quit','q','help','status','new'].includes(name)) { channel.notify('社区 ARC MVP 未接入此命令：'+name); return true; }`);
    source = replace(source, "const runCommand = (name, rawInput = '', images = []) => {", `const runCommand = (name, rawInput = '', images = []) => { if (['help','status'].includes(name)) { arcCommand(name, channel); return true; } if (!['exit','quit','q','new'].includes(name)) { channel.notify('社区 ARC MVP 未接入此命令：'+name); return true; }`);
    source = replace(source, '_jsx(PromptInput, { channel: channel,', `_jsx(Text, { wrap: "truncate-end", children: arcStatus() }), arcPermission() ? _jsx(Text, { children: arcPermission() }) : null, _jsx(PromptInput, { channel: channel,`);
  }
  if (key === 'components/PromptInput.js') {
    source = `import { consumeDraftReset, draftChanged, canSubmit, interceptKey } from ${JSON.stringify(bridge)};\n` + source;
    source = replace(source, "const [cursor, setCursor] = React.useState(0);", `const [cursor, setCursor] = React.useState(0);\nReact.useEffect(() => { const saved = consumeDraftReset(); if (saved !== null) { setValue(saved); setCursor(saved.length); } else draftChanged(value); }, [value, channel.agentId, channel.version]);`);
    for (const anchor of ['const submitText = (text, notice) => {','const steerSend = (text) => {','const queueSend = (text) => {']) source = replace(source, anchor, anchor+' if (!canSubmit(text)) { setValue(text); setCursor(text.length); return; }');
    // PromptInput has its own listener: permission/transition keys must not edit the composer.
    // Hook the component's actual listener below, pinned to its source shape.
    const matches = [...source.matchAll(/useInput\(\(input, key(?:, event)?\) => \{/g)];
    if (matches.length !== 1) throw new Error('Unexpected PromptInput key listener count');
    source = replace(source, matches[0][0], matches[0][0]+' if (interceptKey(input, key, event)) return;');
  }
  if (key === 'utils/paths.js') source = replace(source, "export const DATA_DIR = join(homeDir(), '.dsh-tui');", 'export const DATA_DIR = '+JSON.stringify(process.env.DSH_EVAL_PREFS)+';');
  return { ...result, source };
}});
