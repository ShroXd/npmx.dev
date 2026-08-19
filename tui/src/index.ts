import {
  Box,
  TabSelect,
  TabSelectRenderableEvents,
  Text,
  createCliRenderer,
  instantiate,
  type TabSelectOption,
  type TabSelectRenderable,
  type TextRenderable,
} from '@opentui/core'

export interface RunTuiOptions {
  version?: string
}

const buttons: TabSelectOption[] = [
  {
    name: 'Button A',
    description: 'Switch to the first action',
    value: 'Button A',
  },
  {
    name: 'Button B',
    description: 'Switch to the second action',
    value: 'Button B',
  },
]

function getRuntimeHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return `${message}

OpenTUI's native renderer requires Node.js 26.4.0+ with experimental FFI enabled.
Run this TUI with a compatible runtime, for example:

  node --experimental-ffi tui/src/cli.ts

Current Node.js: ${process.version}`
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const version = options.version ?? '0.0.1'
  let renderer

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      clearOnShutdown: true,
      targetFps: 30,
    })
  } catch (error) {
    throw new Error(getRuntimeHint(error), { cause: error })
  }

  const status = instantiate(
    renderer,
    Text({
      content: 'Selected: Button A',
      fg: '#94A3B8',
      height: 1,
    }),
  ) as TextRenderable

  const tabSelect = instantiate(
    renderer,
    TabSelect({
      options: buttons,
      tabWidth: 16,
      width: 36,
      height: 3,
      wrapSelection: true,
      showDescription: false,
      showUnderline: true,
      textColor: '#CBD5E1',
      selectedTextColor: '#0F172A',
      selectedBackgroundColor: '#38BDF8',
      focusedTextColor: '#FFFFFF',
      focusedBackgroundColor: '#334155',
    }),
  ) as TabSelectRenderable

  tabSelect.on(TabSelectRenderableEvents.SELECTION_CHANGED, (_index, selected) => {
    status.content = `Selected: ${selected?.name ?? 'none'}`
  })

  tabSelect.on(TabSelectRenderableEvents.ITEM_SELECTED, (_index, selected) => {
    status.content = `Activated: ${selected?.name ?? 'none'}`
  })

  renderer.root.add(
    Box(
      {
        borderStyle: 'rounded',
        padding: 1,
        flexDirection: 'column',
        gap: 1,
        width: 44,
        height: 10,
      },
      Text({
        content: `Hello, OpenTUI! npmx-tui ${version}`,
        fg: '#22C55E',
        height: 1,
      }),
      Text({
        content: 'Use left/right arrows to switch, Enter to activate.',
        fg: '#E2E8F0',
        height: 1,
      }),
      tabSelect,
      status,
    ),
  )

  tabSelect.focus()
}
