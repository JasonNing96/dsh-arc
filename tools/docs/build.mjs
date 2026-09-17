/** Generate an offline reading copy; Markdown and diagram sources remain authoritative. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const require = createRequire(process.env.ARC_DOC_NODE_MODULES
  ? join(resolve(process.env.ARC_DOC_NODE_MODULES), '__arc_docs__.cjs')
  : join(root, 'distribution/dsh-arc-cli/package.json'));
const { marked } = await import(pathToFileURL(require.resolve('marked')).href);
const names = ['01-current-runtime', '02-handoff-sequence', '03-plugin-assembly', '04-target-architecture', '05-trust-boundaries'];
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let figureIndex = 0;
let input = readFileSync(join(root, 'docs/design.md'), 'utf8').replace(/^# .*\n/, '');
input = input.replace(/```mermaid\n([\s\S]*?)```/g, (_, block) => {
  const name = names[figureIndex++];
  if (!name) throw new Error('Unexpected Mermaid diagram');
  const svg = readFileSync(join(root, 'docs/diagrams', name + '.svg'), 'utf8');
  const source = readFileSync(join(root, 'docs/diagrams', name + '.mmd'), 'utf8');
  if (block.trim() !== source.trim()) throw new Error('Mermaid source mismatch: ' + name);
  return `<figure id="${name}"><div class="diagram">${svg}</div><figcaption>图 ${figureIndex} · <a href="diagrams/${name}.svg">SVG</a> · <a href="diagrams/${name}.mmd">Mermaid</a></figcaption><details><summary>可编辑连线源码</summary><pre><code>${escape(source)}</code></pre></details></figure>\n\n`;
});
if (figureIndex !== names.length) throw new Error('Expected five diagrams');
let content = marked.parse(input);
const headings = [];
content = content.replace(/<h2>(.*?)<\/h2>/g, (_, title) => {
  const id = `section-${headings.length + 1}`;
  headings.push({ id, title });
  return `<h2 id="${id}">${title}</h2>`;
});
content = content.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-wrap"><table>$1</table></div>');
const toc = headings.map(h => `<a href="#${h.id}">${h.title}</a>`).join('\n');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH ARC · 设计总稿 v1.0</title>
<style>
:root{--ink:#172840;--muted:#5c6d82;--blue:#315bd6;--line:#dce4ef;--teal:#087f83;--paper:#fff;scroll-behavior:smooth}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:#eef2f7;font:17px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}code{font: .87em/1.7 "SFMono-Regular",Consolas,monospace;background:#f0f3f8;border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}pre{padding:22px;background:#f3f6fb;border:1px solid var(--line);border-radius:9px;overflow:auto;line-height:1.7}pre code{padding:0;background:none;white-space:pre;overflow-wrap:normal}
nav{position:fixed;top:0;bottom:0;left:0;width:236px;padding:32px 24px;overflow:auto;background:#f8fafd;border-right:1px solid var(--line);font-size:13px}nav strong{display:block;font-size:21px;margin-bottom:5px}nav small{color:var(--muted)}nav .toc{margin-top:26px}nav a{display:block;color:#40536b;padding:8px 0;line-height:1.5}
main{margin:36px 32px 80px 272px;max-width:1360px;background:var(--paper);box-shadow:0 10px 40px #142b4810;border-radius:16px;overflow:hidden}.cover{background:#12243d;color:white;padding:58px 58px 48px}.eyebrow{font-size:12px;letter-spacing:2.2px;color:#94b1d9}.cover h1{font-size:62px;line-height:1.15;margin:16px 0 0;letter-spacing:-1.5px}.cover .english{font-size:19px;color:#b6c9e2;margin:8px 0 25px}.cover .lead{font-size:27px;font-weight:500;line-height:1.55;margin:0}.chips{display:flex;gap:10px;flex-wrap:wrap;margin-top:30px}.chips span{border:1px solid #49617f;padding:5px 12px;font-size:12px;border-radius:5px;color:#dce9fa}.meta{padding:20px 58px;background:#f3f7fc;color:var(--muted);border-bottom:1px solid var(--line);font-size:14px}.content{padding:10px 58px 46px}
h2{font-size:29px;line-height:1.45;margin:55px 0 24px;padding-top:18px;border-top:2px solid #e4eaf3;scroll-margin-top:22px}h3{font-size:21px;margin:34px 0 15px}p{margin:16px 0}strong{font-weight:650}blockquote{margin:20px 0;padding:12px 22px;border-left:4px solid var(--teal);background:#f1f8f7}ol,ul{padding-left:25px}li{padding-left:5px;margin:9px 0}
.table-wrap{overflow-x:auto;margin:24px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.75}th,td{border-bottom:1px solid var(--line);text-align:left;vertical-align:top;padding:13px 15px}th{background:#edf2f9;color:#274163;font-weight:650}tr:nth-child(even) td{background:#fafbfd}td:first-child{min-width:130px}td code{font-size:12px}figure{margin:26px -24px 30px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;break-inside:avoid}.diagram{overflow-x:auto}.diagram svg{display:block;width:100%;height:auto;min-width:780px}figcaption{padding:12px 24px;background:#f5f8fc;color:var(--muted);font-size:13px;border-top:1px solid var(--line)}details{padding:12px 24px;font-size:13px;background:#fafcfe}summary{cursor:pointer;color:#627087}details pre{font-size:12px}.source{font-size:12px;vertical-align:super;margin-left:2px}.footer{padding:25px 58px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media(min-width:1920px){main{margin-left:auto;margin-right:auto;transform:translateX(100px)}}
@media(max-width:1450px){nav{display:none}main{margin:24px auto 60px;width:calc(100% - 48px);max-width:1330px}.content{padding:10px 44px 40px}.cover{padding:46px}.meta,.footer{padding-left:46px;padding-right:46px}}
@media(max-width:700px){body{font-size:16px}main{width:100%;margin:0;border-radius:0}.cover{padding:34px 24px}.cover h1{font-size:48px}.cover .lead{font-size:23px}.content{padding:4px 23px 30px}.meta,.footer{padding:17px 24px}h2{font-size:25px}figure{margin-left:-12px;margin-right:-12px}.table-wrap{margin-right:-10px}}
@media print{body{background:#fff;font-size:11pt}nav,details{display:none}main{margin:0;width:100%;max-width:none;box-shadow:none;transform:none!important}.cover{padding:28px;color:#172840;background:#eef3fb;break-after:avoid}.cover h1{font-size:38px}.cover .english,.cover .eyebrow{color:#526780}.cover .lead{font-size:20px}.chips{display:none}.content{padding:0 20px}.meta,.footer{padding:14px 20px}h2{font-size:20px;break-after:avoid;margin-top:28px}h3{break-after:avoid}.diagram svg{min-width:0}figure{margin:15px 0;break-inside:avoid}table{font-size:9pt}.table-wrap{overflow:visible}tr{break-inside:avoid}a{color:inherit}.source{font-size:8pt}}
</style></head><body>
<nav><strong>DSH ARC</strong><small>设计总稿 · v1.0<br>2026-09-17</small><div class="toc">${toc}</div><a href="design.md">Markdown 原稿 ↗</a></nav>
<main><header class="cover"><div class="eyebrow">ARCHITECTURE NOTE / 2026.09</div><h1>DSH ARC</h1><p class="english">Agent Relay Control</p><p class="lead">工作有归属，执行可接力。<br>多个独立 runtime，延续同一个会话。</p><div class="chips"><span>小核心 · 明确边界</span><span>控制面 / 数据面</span><span>可选插件 · 独立运行时</span><span>5 张架构图</span></div></header>
<div class="meta">产品与架构评审稿 · 源码与既有验收整合 · 已实现、后续目标、开放研究分别标注<br>本页内嵌全部矢量图，无需 Figma 权限或在线图表服务即可阅读。</div>
<article class="content">${content}</article>
<footer class="footer">DSH ARC Design v1.0 · 2026-09-17 · Markdown 为内容原稿，SVG 为离线图形资产。<br>状态是有日期的证据快照；最新迁移结论以项目独立验收记录为准。</footer></main></body></html>`;
const output = resolve(directory, '../../docs/design.html');
writeFileSync(output, html, 'utf8');
console.log(`Built ${output}: ${names.length} diagrams, ${headings.length} sections, no remote resources`);
