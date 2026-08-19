#!/usr/bin/env node
import process from 'node:process'
import { parseArgs } from 'node:util'
import { runTui } from './index.ts'

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
  },
})

if (values.help) {
  console.log(`npmx-tui

Usage:
  npmx-tui [options]

Options:
  -h, --help     Show help
  -v, --version  Show version`)
  process.exit(0)
}

if (values.version) {
  console.log(VERSION)
  process.exit(0)
}

runTui({ version: VERSION }).catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
