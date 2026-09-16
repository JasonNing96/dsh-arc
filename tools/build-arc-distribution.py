#!/usr/bin/env python3
"""Build release payloads from the single ARC source and an identified TUI candidate."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'distribution/dsh-arc-cli'
VENDOR = PACKAGE / 'vendor'
SOURCE = ROOT / 'distribution/upstream/dsh-tui-candidate-0.10.1.tgz'
SOURCE_SHA = '7f06ce84e816b9f2a226c8ff5ae73a6739b79c92f95d55bd4e2b2b6b26b0bee0'


def main():
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA:
        raise RuntimeError('TUI candidate hash mismatch')
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name in ['dsh-arc', 'dsh-arc-acp', 'dsh-arc-execution']:
        package = ROOT / 'plugins' / name
        shutil.copyfile(PACKAGE / 'LICENSE', package / 'LICENSE')
        if name != 'dsh-arc-acp':
            subprocess.run(['npm', '--prefix', str(package), 'run', 'build'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'pack', '--ignore-scripts', '--pack-destination', str(VENDOR)], cwd=package, check=True)
    target = VENDOR / 'dsh-tui-0.10.1-arc.1.0.0.tgz'
    bundled_versions = {}
    with tarfile.open(SOURCE) as source:
        for item in source:
            if item.isfile() and item.name.endswith('/package.json'):
                metadata = json.load(source.extractfile(item))
                if metadata.get('name') and metadata.get('version'):
                    bundled_versions[metadata['name']] = metadata['version']
    with tarfile.open(SOURCE) as original, tarfile.open(target, 'w:gz') as output:
        for item in original:
            if not item.isfile():
                output.addfile(item)
                continue
            content = original.extractfile(item).read()
            if item.name.endswith('/package.json'):
                manifest = json.loads(content)
                if item.name == 'package/package.json':
                    manifest['version'] = '0.10.1-arc.1.0.0'
                    manifest['description'] = 'DSH ARC distribution of dsh-TUI with the public session-execution extension; not an upstream release'
                    for name in manifest.get('peerDependencies', {}):
                        if name.startswith('@deepseek-ai/dsh-'):
                            manifest['peerDependencies'][name] = '0.1.5-rc.2'
                        elif name == '@deepseek-ai/cordis':
                            manifest['peerDependencies'][name] = '4.0.2'
                # The whole bundled TUI graph uses the same tested runtime generation.
                for name in manifest.get('peerDependencies', {}):
                    if name.startswith('@deepseek-ai/dsh-'):
                        manifest['peerDependencies'][name] = '0.1.5-rc.2'
                    elif name == '@deepseek-ai/cordis':
                        manifest['peerDependencies'][name] = '4.0.2'
                manifest.pop('devDependencies', None)
                for section in ['dependencies', 'optionalDependencies', 'peerDependencies']:
                    for name, spec in manifest.get(section, {}).items():
                        if spec.startswith(('workspace:', 'link:')):
                            if name not in bundled_versions:
                                raise RuntimeError('Unbundled workspace dependency: ' + name)
                            manifest[section][name] = bundled_versions[name]
                content = (json.dumps(manifest, indent=2) + '\n').encode()
                item.size = len(content)
            output.addfile(item, io.BytesIO(content))
        notice = ('DSH ARC distribution: version metadata and peer compatibility reflect the ARC-tested runtime.\n'
                  'Upstream base: b246411b07892fbdc2abf73de7da03c55a195ecd\n'
                  'Public session-execution extension patch SHA-256: 258f53280f20f812ab027c5ffcfeb0e9b9136f62e78952b8a3234c9d41d716a9\n').encode()
        item = tarfile.TarInfo('package/ARC-DISTRIBUTION.txt'); item.size = len(notice); item.mode = 0o644
        output.addfile(item, io.BytesIO(notice))
    manifest = {'version': '1.0.0', 'upstreamTuiSourceSha256': SOURCE_SHA, 'packages': []}
    for path in sorted(VENDOR.glob('*.tgz')):
        manifest['packages'].append({'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (VENDOR / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
