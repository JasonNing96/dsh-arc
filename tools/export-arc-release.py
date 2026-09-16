#!/usr/bin/env python3
"""Export an explicit public source allowlist, without project history or runtime data."""
import argparse, pathlib, shutil, json
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
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
shutil.copyfile(ROOT/'distribution/dsh-arc-cli/README.md',out/'README.md')
shutil.copyfile(ROOT/'distribution/dsh-arc-cli/LICENSE',out/'LICENSE')
shutil.copyfile(ROOT/'distribution/dsh-arc-cli/THIRD_PARTY_NOTICES.md',out/'THIRD_PARTY_NOTICES.md')
(out/'.gitignore').write_text('node_modules/\nlib/\ndist/\nartifacts/\n__pycache__/\n.DS_Store\n.env\n*.env\n.credentials.yaml\n')
(out/'export-manifest.json').write_text(json.dumps({'sourceFiles':files,'excluded':'Private project docs/history, runtime data, deployment configuration and credentials'},indent=2)+'\n')
print(json.dumps({'output':str(out),'files':len(files)}))
