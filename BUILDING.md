# Building DSH ARC

Node.js 22.20+ (Node 26 is tested), npm 11, Python 3 and Git are needed. Runtime
dependencies are locked separately from the bundle metadata used for publication.

```sh
npm ci --prefix distribution/dsh-arc-cli --legacy-peer-deps --ignore-scripts
npm ci --prefix tui --ignore-scripts
npm ci --prefix plugins/dsh-arc --ignore-scripts
ln -s ../../distribution/dsh-arc-cli/node_modules plugins/dsh-arc-execution/node_modules
PATH="$PWD/tui/node_modules/.bin:$PATH" python3 tools/build-arc-distribution.py
```

`build-arc-distribution.py` rebuilds the ARC payload and repacks the identified TUI
candidate. After source changes, update the vendor tarball integrity in the runtime
lockfile and run a clean installation before packaging; never ship stale archives.

```sh
python3 tools/prepare-arc-native.py
mkdir -p artifacts
python3 tools/pack-arc-release.py artifacts
```

The published tarball contains the pinned JS runtime, its required peers, and native
optional binaries for macOS/Linux on arm64/x64. Each downloaded native archive is
verified against the lockfile integrity. Windows and musl/Alpine are outside v1 scope.
The packer uses an isolated staging tree, leaving the build manifest unchanged.

The TUI extension source patch and input tarball are in `distribution/upstream`.
The TUI remains a clearly identified ARC distribution, not an upstream release.

## Documentation and source exports

The consolidated [design note](docs/design.md) has an offline HTML reader and
editable SVG/Mermaid diagrams. Regeneration instructions are in
[docs/diagrams](docs/diagrams/README.md).

`python3 tools/export-arc-release.py --output /absolute/new-export` exports the
explicit source allowlist plus reviewed public documents. When exporting from a
private development checkout, pass `--docs-source /absolute/public-checkout/docs`;
the adjacent public README, BUILDING and VALIDATION files are included as well.
The exporter rejects a missing required public document and never copies an entire
private documentation tree. It produces a source snapshot, not a git clone or a
replacement for maintaining the existing public repository and release workflows.
