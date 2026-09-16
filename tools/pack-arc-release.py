#!/usr/bin/env python3
"""Pack an isolated copy of the installed runtime; native optional packages stay installable."""
import json,os,pathlib,shutil,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parents[1];base=root/'distribution/dsh-arc-cli';destination=pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='dsh-arc-pack-') as tmp:
 stage=pathlib.Path(tmp)/'package';shutil.copytree(base,stage,copy_function=os.link,symlinks=True)
 p=stage/'package.json';value=json.loads(p.read_text());p.unlink();value['bundleDependencies']=list(value['dependencies'])+list(value.get('optionalDependencies',{}));p.write_text(json.dumps(value,indent=2)+'\n')
 subprocess.run(['npm','pack','--ignore-scripts','--pack-destination',str(destination)],cwd=stage,check=True)
