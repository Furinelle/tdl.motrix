#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { tdlSaveDir } from '../bridge/paths.js'

const telegramUrl = process.argv[2]
const saveDir = process.argv[3] || tdlSaveDir()
if (!telegramUrl) {
  console.error('usage: node scripts/tdl-add.mjs <telegram-url> [save-dir]')
  process.exit(2)
}

const resolved = await fetch('http://127.0.0.1:16808/resolve', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: telegramUrl, group: true }),
  signal: AbortSignal.timeout(50_000),
}).then((r) => r.json())

if (!resolved?.ok || !resolved.files?.length) {
  console.error(resolved?.message || 'resolve failed')
  process.exit(1)
}

for (const file of resolved.files) {
  const args = ['add', file.url, '--save-dir', saveDir]
  if (file.filename) args.push('--filename', file.filename)
  const run = spawnSync('motrix', args, { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
