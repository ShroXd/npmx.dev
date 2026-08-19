# npmx-tui

Terminal UI for npmx.dev.

## Local development

The main npmx.dev repository currently targets Node.js 24. Keep using Node 24 for the root app, CI-equivalent checks, and existing workspace packages.

OpenTUI's native renderer requires Node.js 26.4.0+ with experimental FFI enabled. Use a Node 26.4+ runtime only when running this TUI locally.

From the repository root:

```bash
pnpm npmx-tui
```

Or from this package:

```bash
cd tui
pnpm dev
```

`pnpm dev` starts the TUI in watch mode. Use the left and right arrow keys to switch between the two demo buttons, press Enter to activate the current button, and press Ctrl+C to exit.

For a single run without watch:

```bash
pnpm --filter npmx-tui dev:ffi
```
