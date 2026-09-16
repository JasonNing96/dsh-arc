/** Process-local adapter for the exact pinned ACP build. Never edits node_modules. */
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
const upstreamSha256 = 'dcfa3790c65b58280d812e656ac439fe40303bf9b2f3b45842bdfb2345899cde'
const helper = new URL('./handoff.js', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/@deepseek-ai/dsh-acp/lib/index.js')) return result
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source as Uint8Array).toString('utf8')
    if (createHash('sha256').update(source).digest('hex') !== upstreamSha256) {
      throw new Error('DSH ACP 版本与 TUI 适配器不匹配；请使用已锁定版本并重新验收适配器')
    }
    const replace = (from: string, to: string): void => {
      if (source.split(from).length !== 2) throw new Error('DSH TUI adapter anchor mismatch')
      source = source.replace(from, to)
    }
    source = `import { exportCheckpoint, checkpointSeed } from ${JSON.stringify(helper)};\n` + source
    replace('meta: { cwd: options.cwd },', 'meta: { cwd: options.cwd },\n seed: options.seed,')
    replace('cwd: params.cwd,\n\t\t\t\t\tmcpServers: params.mcpServers,',
      'cwd: params.cwd,\n seed: params._meta?.dshCheckpoint === undefined ? undefined : (() => { try { return checkpointSeed(params._meta.dshCheckpoint, params.cwd); } catch (error) { throw invalidParams(error.message); } })(),\n\t\t\t\t\tmcpServers: params.mcpServers,')
    replace('protocolVersion: PROTOCOL_VERSION,', 'protocolVersion: PROTOCOL_VERSION,\n _meta: { dshTuiAdapter: 1 },')
    replace('ctx.on("agent/inbox/claimed",', `ctx.on("agent/assistant-stream", ({ agent, frame }) => {
      const record = ownedRecord(agent);
      if (!record) return;
      record.outputTail = record.outputTail.then(() => conn.notify("_dsh/stream", { sessionId: agent.session.id, frame })).catch(error => {
        if (record.inflight) record.inflight.outputError = error;
      });
    });
    ctx.on("agent/inbox/claimed",`)
    replace('const connection = agent({ name: "deepseek-harness-acp" })', `const connection = agent({ name: "deepseek-harness-acp" })
      .onRequest("_dsh/checkpoint", value => {
        if (!value || typeof value.sessionId !== "string") throw invalidParams("sessionId required");
        return value;
      }, async ({ params }) => {
        assertOpen();
        const record = requireSession(params.sessionId);
        if (record.inflight || record.agent.status !== "idle") throw invalidParams("请等待当前回合结束后再投切");
        return record.agent.runMaintenance(async () => {
          await record.drainUpdates();
          await ctx.sessions.flush(record.agent.session);
          try { return exportCheckpoint(record.agent.session); } catch (error) { throw invalidParams(error.message); }
        });
      })`)
    return { ...result, source }
  },
})
