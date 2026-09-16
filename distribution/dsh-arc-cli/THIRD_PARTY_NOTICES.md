# Third-party software

DSH ARC is an independent project. It is not an official DeepSeek or dsh-TUI release.

The npm distribution contains ARC bundles and a versioned build of
[@deepseek-harness-tui/dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI), under the MIT license.
The included TUI retains its original license and third-party notices.

- Upstream base commit: `b246411b07892fbdc2abf73de7da03c55a195ecd`.
- Added public session-execution interface: patch SHA-256
  `258f53280f20f812ab027c5ffcfeb0e9b9136f62e78952b8a3234c9d41d716a9`.
- Distribution version: `0.10.1-arc.1.0.0`; runtime peer ranges are fixed to the
  tested DSH modules. This is not the registry's original `0.10.1` package.
- Each shipped archive is identified in `vendor/manifest.json`.

DeepSeek Harness, Cordis, the Agent Client Protocol SDK, and other npm dependencies
retain their respective licenses in their installed packages. Source attribution
and bundled upstream licenses must be preserved when redistributing this package
or the Docker image.
