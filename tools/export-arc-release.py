#!/usr/bin/env python3
"""Export an explicit public source allowlist, without project history or runtime data."""
import argparse, pathlib, shutil, json
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--docs-source',type=pathlib.Path,help='Reviewed public docs directory; defaults to docs/');a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
files=[]
def copy(path):
 if path.suffix == '.tgz' and not str(path).startswith(('distribution/dsh-arc-cli/vendor/','distribution/upstream/')):return
 source=ROOT/path
 if source.is_dir():
  for child in sorted(source.rglob('*')):
   if child.is_file() and not any(part in {'node_modules','lib','dist','__pycache__'} for part in child.relative_to(source).parts):copy(child.relative_to(ROOT))
 else:
  target=out/path;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);files.append(str(path))
for name in ['dsh-arc','dsh-arc-acp','dsh-arc-tui','dsh-arc-execution']:
 copy(pathlib.Path('plugins')/name)
for path in ['tui/src','tui/test','tui/community','tui/package.json','tui/package-lock.json','tui/tsconfig.json','distribution/dsh-arc-cli','distribution/docker','distribution/upstream','distribution/.dockerignore','tools/build-arc-distribution.py','tools/export-arc-release.py','tools/pack-arc-release.py','tools/prepare-arc-native.py']:
 copy(pathlib.Path(path))
# Only the reviewed public documentation set is eligible, never private research trees.
docs_source=(a.docs_source or ROOT/'docs').resolve()
public_docs=['README.md','usage.md','design.md','design.html','history.md','next-stage.md','community-direction.md','research/dsh-community-contribution-2026-09-17.md','research/dsh-desktop-plugin-management-2026-09-17.md','repository-map.md','diagrams/README.md','diagrams/render.py']
for name in ['01-current-runtime','02-handoff-sequence','03-plugin-assembly','04-target-architecture','05-trust-boundaries']:
 for ext in ['svg','mmd']:public_docs.append(f'diagrams/{name}.{ext}')
for name in public_docs:
 source=docs_source/name
 if not source.is_file():raise FileNotFoundError(f'Missing reviewed public document: {source}; set --docs-source to the public docs directory')
 target=out/'docs'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);files.append('docs/'+name)
for path in ['tools/docs/build.mjs','tools/docs/verify.mjs']:copy(pathlib.Path(path))
for name in ['README.md','BUILDING.md','VALIDATION.md']:
 shutil.copyfile(docs_source.parent/name,out/name);files.append(name)
shutil.copyfile(ROOT/'distribution/dsh-arc-cli/LICENSE',out/'LICENSE')
shutil.copyfile(ROOT/'distribution/dsh-arc-cli/THIRD_PARTY_NOTICES.md',out/'THIRD_PARTY_NOTICES.md')
(out/'.gitignore').write_text('node_modules/\nlib/\ndist/\nartifacts/\n__pycache__/\n.DS_Store\n.env\n*.env\n.credentials.yaml\n')
(out/'export-manifest.json').write_text(json.dumps({'sourceFiles':files,'excluded':'Private project docs/history, runtime data, deployment configuration and credentials; only explicitly listed reviewed public docs are included'},indent=2)+'\n')
print(json.dumps({'output':str(out),'files':len(files)}))
