import {
  Box,
  CliRenderEvents,
  Input,
  InputRenderableEvents,
  RGBA,
  StyledText,
  Text,
  bg,
  bold,
  createCliRenderer,
  fg,
  instantiate,
  type BoxRenderable,
  type CliRenderer,
  type InputRenderable,
  type KeyEvent,
  type TextChunk,
  type TextRenderable,
} from '@opentui/core'
import {
  getDefaultApiBaseUrl,
  getPackageDetails,
  searchPackages,
  type PackageDetails,
  type PackageSearchResult,
} from './search.ts'
import { createThemeManager, type Theme, type ThemePreference } from './theme/index.ts'

export interface RunTuiOptions {
  version?: string
  themePreference?: ThemePreference
  apiBaseUrl?: string
}

const SEARCH_DEBOUNCE_MS = 500
const SEARCH_RESULT_LIMIT = 25
const LIST_SCROLLBAR_WIDTH = 2
const SPLIT_LAYOUT_MIN_WIDTH = 100
const SPINNER_FRAME_MS = 90
const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

type AppMode = 'normal' | 'insert'
type LayoutMode = 'single' | 'split'
type WorkspaceView = 'collection' | 'inspector'
type FocusTarget = 'search' | 'collection' | 'inspector'
type SearchStatus = 'idle' | 'debouncing' | 'searching' | 'success' | 'empty' | 'error'
type DetailStatus = 'idle' | 'loading' | 'success' | 'error'
type StatusKind = 'info' | 'success' | 'warning' | 'danger'

interface AppState {
  mode: AppMode
  focus: FocusTarget
  layout: LayoutMode
  view: WorkspaceView
  query: string
  searchStatus: SearchStatus
  results: PackageSearchResult[]
  total: number
  pageOffset: number
  selectedIndex: number
  inspectorScrollOffset: number
  statusKind: StatusKind
  statusMessage: string
  errorMessage?: string
}

interface InspectorLine {
  text: string
  tone?: 'title' | 'section' | 'muted' | 'command' | 'warning' | 'danger'
}

function getRuntimeHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return `${message}

OpenTUI's native renderer requires Node.js 26.4.0+ with experimental FFI enabled.
Run this TUI with a compatible runtime, for example:

  node --experimental-ffi tui/src/cli.ts

Current Node.js: ${process.version}`
}

function isPlainKey(key: KeyEvent, name: string): boolean {
  return (
    key.eventType === 'press' &&
    key.name.toLowerCase() === name &&
    !key.ctrl &&
    !key.meta &&
    !key.option
  )
}

function isCtrlKey(key: KeyEvent, name: string): boolean {
  return (
    key.eventType === 'press' &&
    key.name.toLowerCase() === name &&
    key.ctrl &&
    !key.meta &&
    !key.option
  )
}

function shouldQuit(key: KeyEvent, state: AppState): boolean {
  return state.focus !== 'search' && isPlainKey(key, 'q')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function formatDownloads(downloads: number | undefined): string {
  if (downloads === undefined) {
    return 'downloads n/a'
  }

  if (downloads >= 1_000_000) {
    return `${(downloads / 1_000_000).toFixed(1)}m/w`
  }

  if (downloads >= 1_000) {
    return `${Math.round(downloads / 1_000)}k/w`
  }

  return `${downloads}/w`
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) {
    return undefined
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KiB`
  }

  return `${bytes} B`
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  return date.toISOString().slice(0, 10)
}

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return ''
  }

  if (text.length <= maxLength) {
    return text
  }

  if (maxLength <= 3) {
    return '.'.repeat(maxLength)
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function selectedPackage(state: AppState): PackageSearchResult | undefined {
  return state.results[state.selectedIndex]
}

function compactList(items: string[] | undefined, limit: number): string {
  if (!items) {
    return ''
  }

  const visible = items.slice(0, limit)
  const remaining = items.length - visible.length

  if (remaining <= 0) {
    return visible.join(', ')
  }

  return `${visible.join(', ')} +${remaining} more`
}

function isDefinedString(value: string | undefined): value is string {
  return value !== undefined
}

function createInlineMeta(items: Array<string | undefined>): string {
  return items.filter(isDefinedString).join('   ')
}

function formatRecord(
  record: Record<string, string> | undefined,
  limit: number,
): string | undefined {
  if (!record) {
    return undefined
  }

  const entries = Object.entries(record).map(([key, value]) => `${key}:${value}`)
  return entries.length > 0 ? compactList(entries, limit) : undefined
}

function createBracketSection(title: string, lines: string[]): InspectorLine[] {
  const body = lines.filter(Boolean)

  if (body.length === 0) {
    return []
  }

  return [{ text: `[${title}]`, tone: 'section' }, ...body.map(line => ({ text: `  ${line}` }))]
}

function getCollectionEmptyLines(state: AppState): Array<{ title: string; detail: string }> {
  if (!state.query.trim()) {
    return [
      {
        title: 'Search npm packages',
        detail: 'Type a package name to begin.',
      },
    ]
  }

  if (state.searchStatus === 'searching' && state.results.length === 0) {
    return [
      {
        title: 'Searching packages...',
        detail: `Waiting for "${truncateText(state.query, 48)}"`,
      },
    ]
  }

  if (state.searchStatus === 'error' && state.results.length === 0) {
    return [
      {
        title: 'Failed to search packages',
        detail: state.errorMessage ?? 'Network request failed.',
      },
    ]
  }

  if (state.searchStatus === 'empty') {
    return [
      {
        title: `No packages found for "${truncateText(state.query, 42)}"`,
        detail: 'Try a different package name.',
      },
    ]
  }

  return []
}

function getCollectionWindow(state: AppState, height: number): { start: number; end: number } {
  const visibleRows = Math.max(1, height)

  if (state.results.length <= visibleRows) {
    return { start: 0, end: state.results.length }
  }

  const half = Math.floor(visibleRows / 2)
  const start = Math.max(
    0,
    Math.min(state.selectedIndex - half, state.results.length - visibleRows),
  )
  return {
    start,
    end: Math.min(state.results.length, start + visibleRows),
  }
}

function padCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const truncated = truncateText(value, width)
  return align === 'right' ? truncated.padStart(width, ' ') : truncated.padEnd(width, ' ')
}

function createSelectedChunk(text: string, theme: Theme): TextChunk {
  return bg(theme.accent)(fg(theme.bg.base)(text))
}

function createCollectionListText(
  state: AppState,
  theme: Theme,
  width = 80,
  height = 12,
): StyledText {
  const chunks: TextChunk[] = []
  const rowWidth = Math.max(24, width)
  const emptyLines = getCollectionEmptyLines(state)

  if (emptyLines.length > 0) {
    emptyLines.forEach((line, index) => {
      chunks.push(fg(theme.fg.primary)(bold(truncateText(line.title, rowWidth))))
      chunks.push(fg(theme.fg.muted)(`\n${truncateText(line.detail, rowWidth)}`))
      if (index < emptyLines.length - 1) {
        chunks.push(fg(theme.fg.muted)('\n'))
      }
    })

    return new StyledText(chunks)
  }

  const showScroll = state.results.length > height
  const contentWidth = Math.max(22, rowWidth - (showScroll ? LIST_SCROLLBAR_WIDTH : 0))
  const compact = contentWidth < 56
  const versionWidth = compact ? 0 : 11
  const downloadsWidth = compact ? 8 : 9
  const nameWidth = compact
    ? Math.max(8, contentWidth - 2 - downloadsWidth - 1 - 2)
    : Math.max(16, Math.min(34, Math.floor(contentWidth * 0.34)))
  const fixedWidth =
    2 + nameWidth + 1 + (versionWidth > 0 ? versionWidth + 1 : 0) + downloadsWidth + 2
  const descriptionWidth = Math.max(0, contentWidth - fixedWidth)
  const window = getCollectionWindow(state, height)
  const visibleCount = Math.max(1, window.end - window.start)
  const maxIndicatorY = Math.max(0, visibleCount - 1)
  const indicatorY = showScroll
    ? Math.round((state.selectedIndex / Math.max(1, state.results.length - 1)) * maxIndicatorY)
    : -1

  state.results.slice(window.start, window.end).forEach((result, visibleIndex) => {
    const actualIndex = window.start + visibleIndex
    const selected = actualIndex === state.selectedIndex
    const prefix = selected ? '> ' : '  '
    const version = versionWidth > 0 ? `${padCell(`v${result.version}`, versionWidth)} ` : ''
    const line =
      `${prefix}${padCell(result.name, nameWidth)} ` +
      version +
      `${padCell(formatDownloads(result.weeklyDownloads), downloadsWidth, 'right')}  ` +
      `${truncateText(result.description, descriptionWidth)}`
    const paddedLine = line.padEnd(contentWidth, ' ')
    const scrollbar = showScroll ? (visibleIndex === indicatorY ? '█' : '│') : ''
    const isLast = visibleIndex === visibleCount - 1

    if (selected) {
      chunks.push(createSelectedChunk(paddedLine, theme))
    } else {
      chunks.push(fg(theme.fg.secondary)(prefix))
      chunks.push(fg(theme.fg.primary)(bold(padCell(result.name, nameWidth))))
      chunks.push(fg(theme.fg.muted)(' '))
      if (versionWidth > 0) {
        chunks.push(fg(theme.fg.secondary)(padCell(`v${result.version}`, versionWidth)))
        chunks.push(fg(theme.fg.muted)(' '))
      }
      chunks.push(
        fg(theme.fg.secondary)(
          padCell(formatDownloads(result.weeklyDownloads), downloadsWidth, 'right'),
        ),
      )
      chunks.push(
        fg(theme.fg.muted)(
          `  ${truncateText(result.description, descriptionWidth)}`.padEnd(
            Math.max(0, contentWidth - fixedWidth + 2),
            ' ',
          ),
        ),
      )
    }

    if (showScroll) {
      chunks.push(
        fg(visibleIndex === indicatorY ? theme.accent : theme.border.subtle)(` ${scrollbar}`),
      )
    }

    if (!isLast) {
      chunks.push(fg(theme.fg.muted)('\n'))
    }
  })

  return new StyledText(chunks)
}

function createInstallBlock(packageName: string): InspectorLine[] {
  return createBracketSection('install', [
    `npm install ${packageName}`,
    `pnpm add ${packageName}`,
    `yarn add ${packageName}`,
    `bun add ${packageName}`,
  ]).map(line =>
    line.tone === 'section' ? line : ({ ...line, tone: 'command' } satisfies InspectorLine),
  )
}

function createInspectorLines(
  pkg: PackageSearchResult | undefined,
  state: AppState,
  detail?: PackageDetails,
  detailStatus: DetailStatus = 'idle',
  detailError?: string,
): InspectorLine[] {
  if (!pkg) {
    return [
      { text: 'Package preview', tone: 'title' },
      { text: '' },
      {
        text: 'Select a package from the collection to inspect the details available from search.',
        tone: 'muted',
      },
    ]
  }

  const data = detail ?? pkg
  const linkRows: Array<[string, string]> = []
  if (data.links?.npm) {
    linkRows.push(['npm', data.links.npm])
  }
  if (data.links?.repository) {
    linkRows.push(['repo', data.links.repository])
  }
  if (data.links?.homepage) {
    linkRows.push(['home', data.links.homepage])
  }
  if (data.links?.bugs) {
    linkRows.push(['bugs', data.links.bugs])
  }

  const primaryMeta = createInlineMeta([
    `latest ${data.version}`,
    formatDownloads(data.weeklyDownloads),
    data.license ? `license ${data.license}` : undefined,
    detail?.unpackedSize ? `size ${formatBytes(detail.unpackedSize)}` : undefined,
  ])
  const secondaryMeta = createInlineMeta([
    detail?.date ? `published ${formatDate(detail.date)}` : undefined,
    detail?.created ? `created ${formatDate(detail.created)}` : undefined,
    detail?.modified ? `modified ${formatDate(detail.modified)}` : undefined,
  ])
  const resultMeta = createInlineMeta([
    `result ${state.selectedIndex + 1}/${Math.max(state.results.length, 1)}`,
    state.total > 0 ? `${state.total} total matches` : undefined,
  ])
  const links = linkRows.map(
    ([label, value]) => `${label.padEnd(4, ' ')} ${truncateText(value, 72)}`,
  )
  const keywords = compactList(data.keywords, 10)
  const maintainers = data.maintainers
    .map(maintainer => maintainer.username ?? maintainer.name)
    .filter(isDefinedString)
  const author = detail?.author?.name ?? detail?.author?.username
  const distTags = formatRecord(detail?.distTags, 5)
  const engineInfo = formatRecord(detail?.entryPoints?.engines, 3)
  const binNames = detail?.entryPoints?.binNames ?? []
  const detailStatusLine =
    detailStatus === 'loading'
      ? ({ text: '  Loading registry metadata...', tone: 'muted' } satisfies InspectorLine)
      : detailStatus === 'error'
        ? ({
            text: `  Detail metadata unavailable: ${truncateText(detailError ?? 'request failed', 72)}`,
            tone: 'warning',
          } satisfies InspectorLine)
        : undefined
  const headerBlock: InspectorLine[] = [
    { text: `${data.name}@${data.version}`, tone: 'title' },
    { text: data.description },
  ]
  if (detail?.deprecated) {
    headerBlock.push({ text: `deprecated: ${detail.deprecated}`, tone: 'warning' })
  }
  if (detailStatusLine) {
    headerBlock.push(detailStatusLine)
  }

  const qualityRows = [
    `weekly downloads ${formatDownloads(data.weeklyDownloads)}`,
    detail?.versionCount ? `versions ${detail.versionCount}` : undefined,
    `maintainers ${maintainers.length}`,
    detail?.entryPoints?.dependenciesCount !== undefined
      ? `dependencies ${detail.entryPoints.dependenciesCount}`
      : undefined,
    detail?.entryPoints?.peerDependenciesCount !== undefined
      ? `peer dependencies ${detail.entryPoints.peerDependenciesCount}`
      : undefined,
    distTags ? `dist-tags ${distTags}` : undefined,
  ].filter(isDefinedString)

  const runtimeRows = [
    detail?.entryPoints?.type ? `type ${detail.entryPoints.type}` : undefined,
    detail?.entryPoints?.main ? `main ${detail.entryPoints.main}` : undefined,
    detail?.entryPoints?.module ? `module ${detail.entryPoints.module}` : undefined,
    detail?.entryPoints?.types ? `types ${detail.entryPoints.types}` : undefined,
    detail?.entryPoints?.hasExports !== undefined
      ? `exports ${detail.entryPoints.hasExports ? 'yes' : 'no'}`
      : undefined,
    binNames.length > 0 ? `bin ${compactList(binNames, 5)}` : undefined,
    engineInfo ? `engines ${engineInfo}` : undefined,
  ].filter(isDefinedString)

  const blocks: InspectorLine[][] = [
    headerBlock,
    createBracketSection('metadata', [primaryMeta, secondaryMeta, resultMeta]),
    createInstallBlock(data.name),
    createBracketSection('quality', qualityRows),
    createBracketSection('runtime', runtimeRows),
    createBracketSection('keywords', keywords ? [keywords] : []),
    createBracketSection('links', links),
    createBracketSection(
      'maintainers',
      [
        author ? `author ${author}` : undefined,
        maintainers.length > 0 ? `team ${compactList(maintainers, 8)}` : undefined,
      ].filter(isDefinedString),
    ),
  ].filter(block => block.length > 0)

  return blocks.flatMap((block, index) => (index === 0 ? block : [{ text: '' }, ...block]))
}

function createScrollableLines(
  lines: InspectorLine[],
  offset: number,
  viewportHeight: number,
): InspectorLine[] {
  const visibleHeight = Math.max(1, viewportHeight)

  if (lines.length <= visibleHeight) {
    return lines
  }

  const bodyHeight = Math.max(1, visibleHeight - 1)
  const start = Math.min(offset, Math.max(0, lines.length - bodyHeight))
  const end = Math.min(lines.length, start + bodyHeight)
  const indicator = `-- ${start + 1}-${end}/${lines.length} --`

  return [...lines.slice(start, end), { text: indicator, tone: 'muted' }]
}

function getMaxInspectorScrollOffset(lines: InspectorLine[], viewportHeight: number): number {
  const bodyHeight =
    lines.length > viewportHeight ? Math.max(1, viewportHeight - 1) : viewportHeight

  return Math.max(0, lines.length - bodyHeight)
}

function createStyledInspectorText(lines: InspectorLine[], theme: Theme): StyledText {
  const chunks: TextChunk[] = []

  lines.forEach((line, index) => {
    const text = index === lines.length - 1 ? line.text : `${line.text}\n`

    if (line.tone === 'title') {
      chunks.push(fg(theme.fg.primary)(bold(text)))
      return
    }

    if (line.tone === 'section') {
      chunks.push(fg(theme.accent)(bold(text)))
      return
    }

    if (line.tone === 'muted') {
      chunks.push(fg(theme.fg.muted)(text))
      return
    }

    if (line.tone === 'command') {
      chunks.push(fg(theme.status.success)(text))
      return
    }

    if (line.tone === 'warning') {
      chunks.push(fg(theme.status.warning)(text))
      return
    }

    if (line.tone === 'danger') {
      chunks.push(fg(theme.status.danger)(text))
      return
    }

    chunks.push({
      __isChunk: true,
      text,
    })
  })

  return new StyledText(chunks)
}

interface ShortcutAction {
  key: string
  label: string
}

function contextActions(state: AppState): ShortcutAction[] {
  if (state.focus === 'search') {
    return [
      { key: 'type', label: 'Search' },
      { key: 'enter', label: 'Results' },
      { key: '↑/↓', label: 'Results' },
      { key: 'esc', label: 'Cancel' },
    ]
  }

  if (state.layout === 'single' && state.view === 'inspector') {
    return [
      { key: 'h/esc', label: 'Results' },
      { key: 'j/k', label: 'Scroll' },
      { key: '/', label: 'Search' },
      { key: 'q', label: 'Quit' },
    ]
  }

  if (state.focus === 'inspector') {
    return [
      { key: 'h', label: 'Results' },
      { key: 'j/k', label: 'Scroll' },
      { key: '/', label: 'Search' },
      { key: 'q', label: 'Quit' },
    ]
  }

  return [
    { key: 'j/k', label: 'Navigate' },
    { key: '[/]', label: 'Page' },
    { key: 'l', label: 'Details' },
    { key: 'enter', label: 'Preview' },
    { key: '/', label: 'Search' },
    { key: 'q', label: 'Quit' },
  ]
}

function createShortcutBarText(state: AppState, theme: Theme, width = 0): StyledText {
  const chunks: TextChunk[] = []
  const actions = contextActions(state)
  const brand = './npmx'
  const shortcutsLength = actions.reduce(
    (length, action, index) =>
      length + (index > 0 ? 3 : 0) + action.key.length + 1 + action.label.length,
    0,
  )

  actions.forEach((action, index) => {
    if (index > 0) {
      chunks.push(fg(theme.fg.muted)('   '))
    }

    chunks.push(fg(theme.accent)(bold(action.key)))
    chunks.push(fg(theme.fg.secondary)(` ${action.label}`))
  })

  const spacerWidth = width - shortcutsLength - brand.length
  chunks.push(fg(theme.fg.muted)(spacerWidth > 0 ? ' '.repeat(spacerWidth) : '   '))
  chunks.push(fg(theme.fg.primary)(bold(brand)))

  return new StyledText(chunks)
}

function hasNextResultsPage(state: AppState): boolean {
  return state.query.trim().length > 0 && state.pageOffset + state.results.length < state.total
}

function hasPreviousResultsPage(state: AppState): boolean {
  return state.query.trim().length > 0 && state.pageOffset > 0
}

function formatResultsRange(state: AppState): string {
  if (!state.query.trim() || state.total === 0 || state.results.length === 0) {
    return '0 / 0'
  }

  const start = state.pageOffset + 1
  const end = state.pageOffset + state.results.length
  return `${start}-${end} / ${state.total}`
}

function createResultsFooterText(state: AppState, theme: Theme): StyledText {
  const complete = state.query.trim().length > 0 && state.total > 0 && !hasNextResultsPage(state)
  const rangeColor = complete ? theme.fg.primary : theme.fg.muted

  return new StyledText([fg(theme.fg.muted)('\n'), fg(rangeColor)(formatResultsRange(state))])
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const themePreference = options.themePreference ?? 'system'
  const apiBaseUrl = options.apiBaseUrl ?? getDefaultApiBaseUrl()
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

  const state: AppState = {
    mode: 'insert',
    focus: 'search',
    layout: renderer.terminalWidth >= SPLIT_LAYOUT_MIN_WIDTH ? 'split' : 'single',
    view: 'collection',
    query: '',
    searchStatus: 'idle',
    results: [],
    total: 0,
    pageOffset: 0,
    selectedIndex: 0,
    inspectorScrollOffset: 0,
    statusKind: 'info',
    statusMessage: 'Search focused',
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let activeRequest: AbortController | undefined
  let activeDetailRequest: AbortController | undefined
  let spinnerTimer: ReturnType<typeof setInterval> | undefined
  let spinnerFrame = 0
  let requestId = 0
  let detailRequestId = 0
  let detailStatus: DetailStatus = 'idle'
  let detailError: string | undefined
  const detailCache = new Map<string, PackageDetails>()

  const prompt = instantiate(
    renderer,
    Text({
      content: '>',
      fg: theme.accent,
      bg: theme.bg.base,
      width: 2,
      height: 1,
    }),
  ) as TextRenderable

  const input = instantiate(
    renderer,
    Input({
      placeholder: 'Search npm packages',
      width: 'auto',
      flexGrow: 1,
      flexShrink: 1,
      maxLength: 100,
      backgroundColor: theme.bg.base,
      textColor: theme.fg.primary,
      placeholderColor: theme.fg.muted,
      focusedTextColor: theme.fg.primary,
      focusedBackgroundColor: theme.bg.base,
      cursorColor: theme.accent,
      showCursor: true,
    }),
  ) as InputRenderable

  const spinner = instantiate(
    renderer,
    Text({
      content: '',
      fg: theme.accent,
      bg: theme.bg.base,
      width: 1,
      height: 1,
    }),
  ) as TextRenderable

  const inputRow = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        flexDirection: 'row',
        gap: 1,
        width: '100%',
        height: 1,
      },
      prompt,
      input,
      spinner,
    ),
  ) as BoxRenderable

  const searchPanel = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        border: true,
        borderStyle: 'single',
        borderColor: theme.border.normal,
        focusedBorderColor: theme.border.focused,
        title: ' packages ',
        titleColor: theme.fg.secondary,
        bottomTitle: 'npm registry',
        bottomTitleAlignment: 'right',
        flexDirection: 'column',
        paddingX: 1,
        width: '100%',
        height: 3,
      },
      inputRow,
    ),
  ) as BoxRenderable

  const collectionList = instantiate(
    renderer,
    Text({
      content: createCollectionListText(state, theme),
      fg: theme.fg.secondary,
      bg: theme.bg.base,
      width: '100%',
      height: 'auto',
      flexGrow: 1,
      wrapMode: 'none',
      truncate: true,
    }),
  ) as TextRenderable

  const resultsFooter = instantiate(
    renderer,
    Text({
      content: createResultsFooterText(state, theme),
      fg: theme.fg.muted,
      bg: theme.bg.base,
      height: 2,
      truncate: true,
    }),
  ) as TextRenderable

  const collectionPane = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        border: true,
        borderStyle: 'single',
        borderColor: theme.border.normal,
        focusedBorderColor: theme.border.focused,
        title: ' Results ',
        titleColor: theme.fg.secondary,
        flexDirection: 'column',
        paddingX: 1,
        paddingY: 0,
        width: '100%',
        height: 'auto',
        flexGrow: 1,
      },
      collectionList,
      resultsFooter,
    ),
  ) as BoxRenderable

  const inspector = instantiate(
    renderer,
    Text({
      content: createStyledInspectorText(createInspectorLines(undefined, state), theme),
      fg: theme.fg.secondary,
      bg: theme.bg.base,
      height: 'auto',
      flexGrow: 1,
      wrapMode: 'word',
      truncate: false,
    }),
  ) as TextRenderable

  const inspectorPane = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        border: true,
        borderStyle: 'single',
        borderColor: theme.border.normal,
        focusedBorderColor: theme.border.focused,
        title: ' Preview ',
        titleColor: theme.fg.secondary,
        flexDirection: 'column',
        paddingX: 1,
        paddingY: 1,
        width: '57%',
        height: '100%',
      },
      inspector,
    ),
  ) as BoxRenderable

  const leftPane = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        flexDirection: 'column',
        gap: 1,
        width: '43%',
        height: '100%',
      },
      searchPanel,
      collectionPane,
    ),
  ) as BoxRenderable

  const workspace = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        flexDirection: 'row',
        gap: 1,
        width: '100%',
        height: 'auto',
        flexGrow: 1,
      },
      leftPane,
      inspectorPane,
    ),
  ) as BoxRenderable

  const statusBar = instantiate(
    renderer,
    Text({
      content: createShortcutBarText(state, theme, renderer.terminalWidth),
      fg: theme.fg.muted,
      bg: theme.bg.base,
      height: 1,
      truncate: true,
    }),
  ) as TextRenderable

  const shell = instantiate(
    renderer,
    Box(
      {
        backgroundColor: theme.bg.base,
        flexDirection: 'column',
        width: '100%',
        height: '100%',
      },
      workspace,
      statusBar,
    ),
  ) as BoxRenderable

  function getStatusBarWidth(): number {
    return Math.max(1, Number(statusBar.width) || renderer.terminalWidth)
  }

  function setStatus(message: string, kind: StatusKind = 'info'): void {
    state.statusMessage = message
    state.statusKind = kind
    statusBar.content = createShortcutBarText(state, theme, getStatusBarWidth())
    statusBar.fg = theme.status[kind]
  }

  function updateStatusBar(): void {
    statusBar.content = createShortcutBarText(state, theme, getStatusBarWidth())
    statusBar.fg = theme.status[state.statusKind]
  }

  function updateCollectionTitle(): void {
    collectionPane.title = ' Results '
    searchPanel.bottomTitle = state.query.trim()
      ? `${state.results.length}/${state.total}`
      : 'npm registry'
    resultsFooter.content = createResultsFooterText(state, theme)
  }

  function updateFocusStyles(): void {
    searchPanel.titleColor = state.focus === 'search' ? theme.accent : theme.fg.secondary
    searchPanel.borderColor = state.focus === 'search' ? theme.accent : theme.border.normal
    collectionPane.titleColor = state.focus === 'collection' ? theme.accent : theme.fg.secondary
    collectionPane.borderColor = state.focus === 'collection' ? theme.accent : theme.border.normal
    inspectorPane.titleColor = state.focus === 'inspector' ? theme.accent : theme.fg.secondary
    inspectorPane.borderColor = state.focus === 'inspector' ? theme.accent : theme.border.normal

    updateStatusBar()
  }

  function updateInspector(): void {
    const pkg = selectedPackage(state)
    const detail = pkg ? detailCache.get(pkg.name) : undefined
    const content = createInspectorLines(pkg, state, detail, detailStatus, detailError)
    const viewportHeight = Math.max(1, inspector.height || 1)

    state.inspectorScrollOffset = Math.min(
      state.inspectorScrollOffset,
      getMaxInspectorScrollOffset(content, viewportHeight),
    )

    inspectorPane.title = pkg ? ` ${truncateText(pkg.name, 64)} ` : ' Preview '
    inspector.content = createStyledInspectorText(
      createScrollableLines(content, state.inspectorScrollOffset, viewportHeight),
      theme,
    )
    updateFocusStyles()
  }

  function updateCollection(): void {
    const collectionWidth = Math.max(1, Number(collectionList.width) || 80)
    const collectionHeight = Math.max(1, Number(collectionList.height) || 12)
    state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.results.length - 1))
    collectionList.content = createCollectionListText(
      state,
      theme,
      collectionWidth,
      collectionHeight,
    )
    updateCollectionTitle()
    updateInspector()
  }

  async function loadSelectedPackageDetails(): Promise<void> {
    const pkg = selectedPackage(state)
    activeDetailRequest?.abort()
    detailRequestId += 1

    if (!pkg) {
      detailStatus = 'idle'
      detailError = undefined
      updateInspector()
      return
    }

    if (detailCache.has(pkg.name)) {
      detailStatus = 'success'
      detailError = undefined
      updateInspector()
      return
    }

    const currentDetailRequestId = detailRequestId
    const controller = new AbortController()
    activeDetailRequest = controller
    detailStatus = 'loading'
    detailError = undefined
    updateInspector()

    try {
      const detail = await getPackageDetails({
        baseUrl: apiBaseUrl,
        name: pkg.name,
        signal: controller.signal,
      })

      if (currentDetailRequestId !== detailRequestId) {
        return
      }

      detailCache.set(pkg.name, detail)
      detailStatus = 'success'
      detailError = undefined
      updateInspector()
    } catch (error) {
      if (
        controller.signal.aborted ||
        isAbortError(error) ||
        currentDetailRequestId !== detailRequestId
      ) {
        return
      }

      detailStatus = 'error'
      detailError = error instanceof Error ? error.message : String(error)
      updateInspector()
    }
  }

  function applyLayout(): void {
    state.layout = renderer.terminalWidth >= SPLIT_LAYOUT_MIN_WIDTH ? 'split' : 'single'

    if (state.layout === 'split') {
      state.view = 'collection'
      workspace.flexDirection = 'row'
      leftPane.visible = true
      inspectorPane.visible = true
      leftPane.width = '43%'
      inspectorPane.width = '57%'
      leftPane.flexGrow = 0
      inspectorPane.flexGrow = 0
    } else {
      workspace.flexDirection = 'column'
      const showingInspector = state.view === 'inspector'
      leftPane.visible = !showingInspector
      inspectorPane.visible = showingInspector
      leftPane.width = '100%'
      inspectorPane.width = '100%'
      leftPane.flexGrow = showingInspector ? 0 : 1
      inspectorPane.flexGrow = showingInspector ? 1 : 0
    }

    updateCollection()
    updateStatusBar()
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer)
      spinnerTimer = undefined
    }

    spinner.content = ''
  }

  function startSpinner(): void {
    stopSpinner()
    spinnerFrame = 0
    spinner.content = BRAILLE_SPINNER_FRAMES[spinnerFrame] ?? ''

    spinnerTimer = setInterval(() => {
      spinnerFrame += 1
      spinner.content = BRAILLE_SPINNER_FRAMES[spinnerFrame % BRAILLE_SPINNER_FRAMES.length] ?? ''
    }, SPINNER_FRAME_MS)
  }

  function focusSearch(): void {
    state.mode = 'insert'
    state.focus = 'search'
    if (state.layout === 'single') {
      state.view = 'collection'
    }
    input.showCursor = true
    input.focus()
    setStatus('Search focused')
    applyLayout()
  }

  function focusCollection(): void {
    state.mode = 'normal'
    state.focus = 'collection'
    input.showCursor = false
    input.blur()

    if (state.layout === 'single') {
      state.view = 'collection'
      applyLayout()
    } else {
      updateFocusStyles()
    }

    setStatus('Results focused')
  }

  function focusInspector(): boolean {
    const pkg = selectedPackage(state)
    if (!pkg) {
      return false
    }

    state.mode = 'normal'
    state.focus = 'inspector'
    input.showCursor = false
    input.blur()

    if (state.layout === 'single') {
      state.view = 'inspector'
      applyLayout()
    } else {
      updateFocusStyles()
    }

    setStatus(`Details focused: ${pkg.name}@${pkg.version}`)
    return true
  }

  function moveSelection(direction: 'up' | 'down'): void {
    if (state.results.length === 0) {
      return
    }

    if (direction === 'up') {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1)
    } else {
      state.selectedIndex = Math.min(state.results.length - 1, state.selectedIndex + 1)
    }

    state.inspectorScrollOffset = 0
    updateCollection()
    void loadSelectedPackageDetails()
    const pkg = selectedPackage(state)
    if (pkg) {
      setStatus(`${pkg.name}@${pkg.version}`)
    }
  }

  function scrollInspector(direction: 'up' | 'down', amount = 1): void {
    const pkg = selectedPackage(state)
    if (!pkg) {
      return
    }

    const detail = detailCache.get(pkg.name)
    const content = createInspectorLines(pkg, state, detail, detailStatus, detailError)
    const viewportHeight = Math.max(1, inspector.height || 1)
    const maxOffset = getMaxInspectorScrollOffset(content, viewportHeight)
    const nextOffset =
      direction === 'up'
        ? Math.max(0, state.inspectorScrollOffset - amount)
        : Math.min(maxOffset, state.inspectorScrollOffset + amount)

    if (nextOffset === state.inspectorScrollOffset) {
      setStatus(direction === 'up' ? 'Top of details' : 'End of details')
      return
    }

    state.inspectorScrollOffset = nextOffset
    updateInspector()
    setStatus(`Details ${state.inspectorScrollOffset + 1}/${maxOffset + 1}`)
  }

  function openSelection(): void {
    const pkg = selectedPackage(state)
    if (!pkg) {
      return
    }

    state.inspectorScrollOffset = 0
    focusInspector()
    setStatus(`Previewing ${pkg.name}@${pkg.version}`)
  }

  function showCollection(): boolean {
    if (state.focus === 'inspector' || (state.layout === 'single' && state.view === 'inspector')) {
      focusCollection()
      return true
    }

    return false
  }

  function focusResultsFromSearch(position: 'current' | 'first' | 'last' = 'current'): boolean {
    if (state.results.length === 0) {
      setStatus('No results to focus')
      return true
    }

    if (position === 'first') {
      state.selectedIndex = 0
    } else if (position === 'last') {
      state.selectedIndex = state.results.length - 1
    }

    state.inspectorScrollOffset = 0
    focusCollection()
    updateCollection()
    void loadSelectedPackageDetails()
    return true
  }

  function pageResults(direction: 'previous' | 'next'): boolean {
    if (
      !state.query.trim() ||
      state.searchStatus === 'searching' ||
      state.searchStatus === 'debouncing'
    ) {
      return false
    }

    const nextOffset =
      direction === 'previous'
        ? Math.max(0, state.pageOffset - SEARCH_RESULT_LIMIT)
        : state.pageOffset + SEARCH_RESULT_LIMIT

    if (direction === 'previous' && !hasPreviousResultsPage(state)) {
      setStatus('First results page')
      return true
    }

    if (direction === 'next' && !hasNextResultsPage(state)) {
      setStatus('Last results page')
      return true
    }

    state.inspectorScrollOffset = 0
    void runSearch(state.query, nextOffset)
    return true
  }

  async function runSearch(query: string, pageOffset = state.pageOffset): Promise<void> {
    const trimmed = query.trim()
    const currentRequestId = ++requestId
    const nextPageOffset = Math.max(0, pageOffset)
    activeRequest?.abort()
    activeDetailRequest?.abort()
    detailRequestId += 1
    detailStatus = 'idle'
    detailError = undefined

    if (!trimmed) {
      stopSpinner()
      state.query = ''
      state.searchStatus = 'idle'
      state.results = []
      state.total = 0
      state.pageOffset = 0
      state.selectedIndex = 0
      state.inspectorScrollOffset = 0
      state.errorMessage = undefined
      updateCollection()
      setStatus(state.focus === 'search' ? 'Search focused' : 'Results focused')
      return
    }

    const controller = new AbortController()
    activeRequest = controller
    state.searchStatus = 'searching'
    state.errorMessage = undefined
    startSpinner()
    updateCollection()
    setStatus(`Searching "${truncateText(trimmed, 48)}"`)

    try {
      const response = await searchPackages({
        baseUrl: apiBaseUrl,
        query: trimmed,
        size: SEARCH_RESULT_LIMIT,
        from: nextPageOffset,
        signal: controller.signal,
      })

      if (currentRequestId !== requestId) {
        return
      }

      stopSpinner()
      state.results = response.results
      state.total = response.total
      state.pageOffset = nextPageOffset
      state.selectedIndex = 0
      state.inspectorScrollOffset = 0
      state.searchStatus = response.results.length > 0 ? 'success' : 'empty'
      state.errorMessage = undefined
      updateCollection()
      void loadSelectedPackageDetails()
      setStatus(
        response.results.length > 0
          ? `${response.results.length} packages found`
          : `No packages found for "${truncateText(trimmed, 48)}"`,
        response.results.length > 0 ? 'success' : 'warning',
      )
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error) || currentRequestId !== requestId) {
        return
      }

      stopSpinner()
      state.searchStatus = 'error'
      state.errorMessage = error instanceof Error ? error.message : String(error)
      updateCollection()
      setStatus('Package search failed', 'danger')
    }
  }

  function scheduleSearch(): void {
    state.query = input.value
    state.pageOffset = 0

    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    const trimmed = state.query.trim()
    if (!trimmed) {
      void runSearch(state.query, 0)
      return
    }

    stopSpinner()
    state.searchStatus = 'debouncing'
    updateCollectionTitle()
    updateStatusBar()

    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void runSearch(state.query, 0)
    }, SEARCH_DEBOUNCE_MS)
  }

  input.on(InputRenderableEvents.INPUT, scheduleSearch)

  function handleAppKey(key: KeyEvent): boolean {
    if (state.focus !== 'search' && isPlainKey(key, '/')) {
      focusSearch()
      return true
    }

    if (isPlainKey(key, 'escape')) {
      if (state.focus === 'search') {
        return focusResultsFromSearch()
      }

      if (state.focus === 'collection') {
        focusSearch()
        return true
      }

      return showCollection()
    }

    if (state.focus === 'search') {
      if (isPlainKey(key, 'return')) {
        return focusResultsFromSearch('first')
      }

      if (isPlainKey(key, 'down')) {
        return focusResultsFromSearch('first')
      }

      if (isPlainKey(key, 'up')) {
        return focusResultsFromSearch('last')
      }

      if (isPlainKey(key, '[') || isCtrlKey(key, 'u')) {
        return pageResults('previous')
      }

      if (isPlainKey(key, ']') || isCtrlKey(key, 'd')) {
        return pageResults('next')
      }

      return false
    }

    if (isPlainKey(key, 'h') || isPlainKey(key, 'left')) {
      if (state.focus === 'inspector') {
        focusCollection()
      } else {
        focusSearch()
      }
      return true
    }

    if (isPlainKey(key, 'return')) {
      openSelection()
      return true
    }

    if (isPlainKey(key, 'l') || isPlainKey(key, 'right')) {
      return focusInspector()
    }

    if (isPlainKey(key, '[') || isCtrlKey(key, 'u')) {
      return pageResults('previous')
    }

    if (isPlainKey(key, ']') || isCtrlKey(key, 'd')) {
      return pageResults('next')
    }

    if (isPlainKey(key, 'j') || isPlainKey(key, 'down')) {
      if (state.focus === 'inspector') {
        scrollInspector('down')
      } else {
        moveSelection('down')
      }
      return true
    }

    if (isPlainKey(key, 'k') || isPlainKey(key, 'up')) {
      if (state.focus === 'inspector') {
        scrollInspector('up')
      } else {
        moveSelection('up')
      }
      return true
    }

    return false
  }

  const modeHandler = (key: KeyEvent): void => {
    if (!handleAppKey(key)) {
      return
    }

    key.preventDefault()
    key.stopPropagation()
  }

  const quitHandler = (key: KeyEvent): void => {
    if (!shouldQuit(key, state)) {
      return
    }

    key.preventDefault()
    key.stopPropagation()
    renderer.destroy()
  }

  renderer.keyInput.on('keypress', quitHandler)
  renderer.keyInput.on('keypress', modeHandler)
  renderer.on(CliRenderEvents.RESIZE, applyLayout)

  function applyTheme(nextTheme: Theme): void {
    theme = nextTheme
    renderer.setBackgroundColor(theme.bg.base)

    shell.backgroundColor = theme.bg.base
    searchPanel.backgroundColor = theme.bg.base
    searchPanel.focusedBorderColor = theme.border.focused
    inputRow.backgroundColor = theme.bg.base
    workspace.backgroundColor = theme.bg.base
    leftPane.backgroundColor = theme.bg.base
    collectionPane.backgroundColor = theme.bg.base
    collectionPane.focusedBorderColor = theme.border.focused
    inspectorPane.backgroundColor = theme.bg.base
    inspectorPane.focusedBorderColor = theme.border.focused

    prompt.fg = theme.accent
    prompt.bg = theme.bg.base
    input.backgroundColor = theme.bg.base
    input.textColor = theme.fg.primary
    input.placeholderColor = theme.fg.muted
    input.focusedTextColor = theme.fg.primary
    input.focusedBackgroundColor = theme.bg.base
    input.cursorColor = theme.accent
    spinner.fg = theme.accent
    spinner.bg = theme.bg.base

    collectionList.fg = theme.fg.secondary
    collectionList.bg = theme.bg.base
    collectionList.content = createCollectionListText(
      state,
      theme,
      Math.max(1, Number(collectionList.width) || 80),
      Math.max(1, Number(collectionList.height) || 12),
    )

    inspector.fg = theme.fg.secondary
    inspector.bg = theme.bg.base
    resultsFooter.bg = theme.bg.base
    resultsFooter.content = createResultsFooterText(state, theme)
    statusBar.bg = theme.bg.base
    statusBar.fg = theme.status[state.statusKind]
    updateInspector()
  }

  applyTheme(theme)
  themeManager.subscribe(applyTheme)
  renderer.on(CliRenderEvents.DESTROY, () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    stopSpinner()
    activeRequest?.abort()
    input.off(InputRenderableEvents.INPUT, scheduleSearch)
    renderer.keyInput.off('keypress', modeHandler)
    renderer.keyInput.off('keypress', quitHandler)
    renderer.off(CliRenderEvents.RESIZE, applyLayout)
    themeManager.dispose()
  })

  renderer.root.add(shell)
  applyLayout()
  updateCollection()
  focusSearch()
}

export { createThemeManager }
export type { Theme, ThemeManager, ThemeMode, ThemeName, ThemePreference } from './theme/index.ts'
