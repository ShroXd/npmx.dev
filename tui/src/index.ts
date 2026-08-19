export interface RunTuiOptions {
  version?: string
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const version = options.version ?? '0.0.1'

  // Placeholder until the interactive TUI dependencies and flows are chosen.
  console.log(`npmx-tui ${version}`)
}
