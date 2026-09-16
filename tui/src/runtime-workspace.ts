/** Classic terminal adapter for the renderer-independent ARC controller. */
import { ArcController, type Connector } from './arc-controller.js'
import type { RuntimeConfig } from './runtime-config.js'
import type { RemoteConfig } from './remote-config.js'
import { TerminalUi } from './terminal-ui.js'
export type { Location, Connector } from './arc-controller.js'
export class RuntimeWorkspace extends ArcController<TerminalUi> {
  private readonly dimensions: { rows: number; cols: number }
  private readonly quitHooks: Set<() => void>
  constructor(config: RuntimeConfig, remote: RemoteConfig | undefined, write: (text: string) => void, connector?: Connector) {
    const dimensions = { rows: 24, cols: 80 }
    const quitHooks = new Set<() => void>()
    super(config, remote, (client, store, options) => {
      const ui = new TerminalUi(client, store, options, write)
      ui.setActive(false)
      ui.setSize(dimensions.rows, dimensions.cols)
      ui.onChange(() => {
        if (this.activeSession === ui && ui.shouldQuit) {
          this.cancelTransition()
          for (const hook of quitHooks) hook()
        }
      })
      return ui
    }, connector)
    this.dimensions = dimensions
    this.quitHooks = quitHooks
    this.onChange(() => this.activeSession?.render())
  }
  feed(chunk: Buffer): void { void this.activeSession?.feed(chunk) }
  onQuit(hook: () => void): void { this.quitHooks.add(hook) }
  setSize(rows: number, cols: number): void {
    this.dimensions.rows = rows; this.dimensions.cols = cols
    this.activeSession?.setSize(rows, cols)
  }
}
