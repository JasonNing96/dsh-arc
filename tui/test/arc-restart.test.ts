import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeWorkspace } from '../dist/runtime-workspace.js'
import { AcpClient } from '../dist/acp-client.js'
import { resolveRuntimeConfig } from '../dist/runtime-config.js'

test('changing only a Docker image preserves the active conversation and remote native session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-image-upgrade-'))
  const config = resolveRuntimeConfig({ demo: true, cwd: root, stateDir: join(root, 'state'), dshHome: undefined, dshExecutable: undefined })
  // The demo process runs on this host; Docker path validation is covered separately.
  const remote = { host: 'fixture', cwd: root, dshHome: '/data/runtime', node: '/node', entry: '/dsh', arcProfile: 'arc-runtime',
    docker: { image: 'example/arc:1.0.0', dataDir: '/srv/arc', workspace: '/srv/project', user: '1000:1000' } }
  const make = () => new RuntimeWorkspace(config, remote, () => {}, async (location, id, handlers) => {
    process.env.DSH_TUI_DEMO_STORE = join(root, location + '.json')
    return AcpClient.connectDemo(id, location === 'remote' ? remote.cwd : root, handlers)
  })
  let runtime = make()
  try {
    await runtime.start()
    const conversation = runtime.activeUi!.conversation
    assert.equal(await runtime.switchRuntime(), true)
    const session = runtime.activeUi!.sessionId
    await runtime.close()
    remote.docker.image = 'example/arc:1.0.1'
    runtime = make(); await runtime.start()
    assert.equal(runtime.currentLocation, 'remote')
    assert.equal(runtime.home, 'local')
    assert.equal(runtime.activeUi!.conversation, conversation)
    assert.equal(runtime.activeUi!.sessionId, session)
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})

test('shared ARC restores remote native session, logical identity and draft after full UI restart; --new is explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-restart-'))
  const paths = { local: join(root,'local'), remote: join(root,'remote') }
  await Promise.all(Object.values(paths).map(path=>mkdir(path)))
  const config = resolveRuntimeConfig({ demo:true, cwd:paths.local, stateDir:join(root,'state'), dshHome:undefined, dshExecutable:undefined })
  const remote = {host:'fixture',cwd:paths.remote,dshHome:'/fixture',node:'/node',entry:'/dsh'}
  const make = () => new RuntimeWorkspace(config,remote,()=>{}, async (location,id,handlers) => {
    process.env.DSH_TUI_DEMO_STORE = join(root,location+'.json')
    return AcpClient.connectDemo(id,paths[location],handlers)
  })
  let w=make()
  try {
    await w.start(); const conversation=w.activeUi!.conversation
    await w.activeUi!.feed(Buffer.from('local remembered\r'))
    // feed returns before the asynchronous prompt ends.
    while(w.activeUi!.running!=='idle') await new Promise(r=>setTimeout(r,10))
    assert.equal(await w.switchRuntime(),true)
    const sid=w.activeUi!.sessionId
    await w.activeUi!.feed(Buffer.from('跨界面未发送草稿'))
    await w.close();w=make();await w.start()
    assert.equal(w.currentLocation,'remote');assert.equal(w.home,'local')
    assert.equal(w.activeUi!.sessionId,sid);assert.equal(w.activeUi!.conversation,conversation)
    assert.equal(w.activeUi!.uiState.buffer,'跨界面未发送草稿')
    assert.equal(w.activeUi!.displayLines.filter(r=>r.kind==='user').length,1)
    await w.close();w=make();await w.start(true)
    assert.equal(w.currentLocation,'local');assert.notEqual(w.activeUi!.conversation,conversation)
    assert.equal(w.activeUi!.uiState.buffer,'')
  } finally { await w.close();await rm(root,{recursive:true,force:true}) }
})

test('corrupt ARC active pointer fails explicitly without creating a replacement native session', async () => {
  const root=await mkdtemp(join(tmpdir(),'arc-corrupt-'))
  const config=resolveRuntimeConfig({demo:true,cwd:root,stateDir:join(root,'state'),dshHome:undefined,dshExecutable:undefined})
  let count=0
  const make=()=>new RuntimeWorkspace(config,undefined,()=>{},async (_location,id,handlers)=>{count++;return AcpClient.connectDemo(id,root,handlers)})
  let w=make()
  try {
    await w.start();await w.close()
    for(const dir of await readdir(join(root,'state/runtimes'))) {
      const file=join(root,'state/runtimes',dir,'active.json')
      try {await readFile(file);await writeFile(file,'{"version":2}')}catch{}
    }
    w=make();await assert.rejects(w.start(),/索引损坏/);assert.equal(count,1)
  }finally{await w.close();await rm(root,{recursive:true,force:true})}
})

test('closing during initial connection aborts startup and releases both ARC and runtime locks', async () => {
  const root=await mkdtemp(join(tmpdir(),'arc-start-close-'))
  const config=resolveRuntimeConfig({demo:true,cwd:root,stateDir:join(root,'state'),dshHome:undefined,dshExecutable:undefined})
  let entered!:()=>void
  const connecting=new Promise<void>(resolve=>{entered=resolve})
  const w=new RuntimeWorkspace(config,undefined,()=>{},async (_location,_id,_handlers,signal)=>{
    entered()
    return new Promise<never>((_resolve,reject)=>{
      if(signal.aborted) reject(new Error('startup cancelled'))
      else signal.addEventListener('abort',()=>reject(new Error('startup cancelled')),{once:true})
    })
  })
  try {
    const starting=assert.rejects(w.start(),/startup cancelled/)
    await connecting; await w.close(); await starting
    for(const directory of await readdir(join(root,'state/runtimes'))) {
      assert.ok(!(await readdir(join(root,'state/runtimes',directory))).includes('lock.json'))
    }
  }finally{await w.close();await rm(root,{recursive:true,force:true})}
})
