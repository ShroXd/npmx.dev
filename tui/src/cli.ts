#!/usr/bin/env node
import process from 'node:process'
import { parseArgs } from 'node:util'
import { runTui } from './index.ts'
import { isThemePreference } from './theme/index.ts'

const VERSION = '0.0.1'

const { values } = parseArgs({
  options: {
    help: {
      type: 'boolean',
      short: 'h',
    },
    version: {
      type: 'boolean',
      short: 'v',
    },
    theme: {
      type: 'string',
      short: 't',
    },
  },
})

if (values.help) {
  console.log(`npmx-tui

Usage:
  npmx-tui [options]

Options:
  -h, --help     Show help
  -v, --version  Show version
  -t, --theme    Theme preference: system, dark, light`)
  process.exit(0)
}

if (values.version) {
  console.log(VERSION)
  process.exit(0)
}

const themePreference = values.theme ?? 'system'

if (!isThemePreference(themePreference)) {
  console.error(`Invalid theme preference: ${themePreference}

Expected one of: system, dark, light`)
  process.exit(1)
}

runTui({ version: VERSION, themePreference }).catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
