import {
  Box,
  CliRenderEvents,
  RGBA,
  TabSelect,
  TabSelectRenderableEvents,
  Text,
  TextAttributes,
  createCliRenderer,
  instantiate,
  type BoxRenderable,
  type CliRenderer,
  type TabSelectOption,
  type TabSelectRenderable,
  type TextRenderable,
} from '@opentui/core'
import { createThemeManager, type Theme, type ThemePreference } from './theme/index.ts'

export interface RunTuiOptions {
  version?: string
  themePreference?: ThemePreference
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
  const themePreference = options.themePreference ?? 'system'
  let renderer: CliRenderer

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      clearOnShutdown: true,
      targetFps: 30,
      backgroundColor: RGBA.defaultBackground(),
    })
  } catch (error) {
    throw new Error(getRuntimeHint(error), { cause: error })
  }

  const themeManager = await createThemeManager(renderer, {
    preference: themePreference,
  })
  let theme = themeManager.theme

  const status = instantiate(
    renderer,
    Text({
      content: '> Selected: Button A',
      fg: theme.fg.muted,
      bg: theme.bg.surface,
      height: 1,
    }),
  ) as TextRenderable

  const title = instantiate(
    renderer,
    Text({
      content: `Ready: OpenTUI npmx-tui ${version}`,
      fg: theme.status.success,
      bg: theme.bg.surface,
      attributes: TextAttributes.BOLD,
      height: 1,
    }),
  ) as TextRenderable

  const hint = instantiate(
    renderer,
    Text({
      content: 'Use left/right arrows to switch, Enter to activate.',
      fg: theme.fg.secondary,
      bg: theme.bg.surface,
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
      backgroundColor: theme.bg.surface,
      textColor: theme.fg.secondary,
      selectedTextColor: theme.fg.primary,
      selectedBackgroundColor: theme.bg.selected,
      focusedTextColor: theme.fg.primary,
      focusedBackgroundColor: theme.bg.selected,
      selectedDescriptionColor: theme.fg.muted,
    }),
  ) as TabSelectRenderable

  tabSelect.on(TabSelectRenderableEvents.SELECTION_CHANGED, (_index, selected) => {
    status.content = `> Selected: ${selected?.name ?? 'none'}`
  })

  tabSelect.on(TabSelectRenderableEvents.ITEM_SELECTED, (_index, selected) => {
    status.content = `> Activated: ${selected?.name ?? 'none'}`
  })

  const panel = instantiate(
    renderer,
    Box(
      {
        borderStyle: 'rounded',
        borderColor: theme.border.normal,
        focusedBorderColor: theme.border.focused,
        backgroundColor: theme.bg.surface,
        title: 'npMx',
        titleColor: theme.fg.secondary,
        padding: 1,
        flexDirection: 'column',
        gap: 1,
        width: 44,
        height: 10,
      },
      title,
      hint,
      tabSelect,
      status,
    ),
  ) as BoxRenderable

  function applyTheme(nextTheme: Theme): void {
    theme = nextTheme
    renderer.setBackgroundColor(theme.bg.base)

    panel.backgroundColor = theme.bg.surface
    panel.borderColor = theme.border.normal
    panel.focusedBorderColor = theme.border.focused
    panel.titleColor = theme.fg.secondary

    title.fg = theme.status.success
    title.bg = theme.bg.surface
    hint.fg = theme.fg.secondary
    hint.bg = theme.bg.surface
    status.fg = theme.fg.muted
    status.bg = theme.bg.surface

    tabSelect.backgroundColor = theme.bg.surface
    tabSelect.textColor = theme.fg.secondary
    tabSelect.selectedTextColor = theme.fg.primary
    tabSelect.selectedBackgroundColor = theme.bg.selected
    tabSelect.focusedTextColor = theme.fg.primary
    tabSelect.focusedBackgroundColor = theme.bg.selected
    tabSelect.selectedDescriptionColor = theme.fg.muted
  }

  applyTheme(theme)
  themeManager.subscribe(applyTheme)
  renderer.on(CliRenderEvents.DESTROY, () => {
    themeManager.dispose()
  })

  renderer.root.add(panel)

  tabSelect.focus()
}

export { createThemeManager }
export type { Theme, ThemeManager, ThemeMode, ThemeName, ThemePreference } from './theme/index.ts'
