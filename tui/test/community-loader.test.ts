import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('community source guard refuses a modified upstream file before executing it', async () => {
  const root=await mkdtemp(join(tmpdir(),'arc-source-pin-'))
  try {
    const dir=join(root,'dsh-tui/lib/types/utils'); await mkdir(dir,{recursive:true})
    const path=join(dir,'paths.js');await writeFile(path,'throw new Error("UNVERIFIED_SOURCE_EXECUTED")')
    const result=spawnSync(process.execPath,['--import',fileURLToPath(new URL('../community/loader.mjs',import.meta.url)),
      '--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path).href)})`],{encoding:'utf8',timeout:5000})
    assert.notEqual(result.status,0)
    assert.match(result.stderr,/社区 ARC 版本不匹配/)
    assert.doesNotMatch(result.stderr,/Error: UNVERIFIED_SOURCE_EXECUTED/)
  }finally{await rm(root,{recursive:true,force:true})}
})
