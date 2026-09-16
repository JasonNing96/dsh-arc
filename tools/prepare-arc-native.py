#!/usr/bin/env python3
"""Include locked native optional dependencies for supported macOS/Linux CPU pairs."""
import base64,concurrent.futures,hashlib,io,json,pathlib,tarfile,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1];BASE=ROOT/'distribution/dsh-arc-cli'
lock=json.loads((BASE/'package-lock.json').read_text());selected={}
for key,m in lock['packages'].items():
 if not set(m.get('os',[]))&{'darwin','linux'} or not set(m.get('cpu',[]))&{'x64','arm64'}:continue
 if 'musl' in key:continue
 if m.get('resolved') and m.get('integrity'):selected[key]=m

def prepare(item):
 key,m=item;target=BASE/key
 if (target/'package.json').exists() and json.loads((target/'package.json').read_text())['version']==m['version']:return key
 data=subprocess.run(['curl','--fail','--silent','--show-error','--location','--retry','1','--max-time','45',m['resolved']],capture_output=True,check=True,timeout=100).stdout
 algorithm,expected=m['integrity'].split('-',1)
 if base64.b64encode(hashlib.new(algorithm,data).digest()).decode()!=expected:raise RuntimeError('Native archive integrity mismatch: '+key)
 target.mkdir(parents=True,exist_ok=True)
 with tarfile.open(fileobj=io.BytesIO(data)) as archive:
  for member in archive:
   relative=pathlib.PurePosixPath(member.name)
   if relative.parts[0]!='package' or '..' in relative.parts or member.issym() or member.islnk():raise RuntimeError('Unsafe archive entry: '+member.name)
   path=target.joinpath(*relative.parts[1:])
   if member.isdir():path.mkdir(parents=True,exist_ok=True)
   elif member.isfile():path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(archive.extractfile(member).read());path.chmod(member.mode&0o777)
 return key
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for key in pool.map(prepare,selected.items()):print(key,flush=True)
(BASE/'vendor/native-platforms.json').write_text(json.dumps({'platforms':['darwin-arm64','darwin-x64','linux-arm64','linux-x64'],'packages':selected},indent=2)+'\n')
