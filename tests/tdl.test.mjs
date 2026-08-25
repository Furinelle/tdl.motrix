import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classifyTdlError, isolateBoltSession, TdlRunner } from '../bridge/tdl.js'

const firstUrl = 'http://127.0.0.1:18773/3730750297/1302'
const secondUrl = 'http://127.0.0.1:18773/3730750297/1303'

function makeSlot(urls) {
  const proc = new EventEmitter()
  proc.exitCode = null
  proc.signals = []
  proc.kill = (signal) => {
    proc.signals.push(signal)
    queueMicrotask(() => {
      proc.exitCode = 0
      proc.emit('exit', 0)
    })
    return true
  }
  return {
    proc,
    files: urls.map((url, index) => ({ url, filename: `${index}.mp4` })),
    completedUrls: new Set(),
    timer: setTimeout(() => {}, 60_000).unref(),
  }
}

test('classifyTdlError recognizes a Telegram database lock', () => {
  assert.deepEqual(
    classifyTdlError('Current database is used by another process, please terminate it first'),
    { code: 'busy', message: 'tdl 正在处理其他 Telegram 下载，请完成后重试' }
  )
})

test('TdlRunner stops a grouped serve only after every file completes', async () => {
  const runner = new TdlRunner({ tdlBin: 'tdl' })
  const slot = makeSlot([firstUrl, secondUrl])
  runner.serves.set('https://t.me/channel/1302', slot)

  await runner.markServedComplete(firstUrl)
  assert.deepEqual(slot.proc.signals, [])
  assert.equal(runner.serves.size, 1)

  await runner.markServedComplete(secondUrl)
  assert.deepEqual(slot.proc.signals, ['SIGTERM'])
  assert.equal(runner.serves.size, 0)
  assert.equal(runner.pendingStops.size, 0)
})

test('TdlRunner reaps completed serves while preserving active grouped downloads', async () => {
  const runner = new TdlRunner({
    tdlBin: 'tdl',
    findTerminalTaskByUri: (url) => url === firstUrl ? { status: 'completed' } : null,
  })
  const completed = makeSlot([firstUrl])
  const active = makeSlot([secondUrl])
  runner.serves.set('https://t.me/channel/1302', completed)
  runner.serves.set('https://t.me/channel/1303', active)

  await runner.reapCompletedServes()

  assert.deepEqual(completed.proc.signals, ['SIGTERM'])
  assert.deepEqual(active.proc.signals, [])
  assert.equal(runner.serves.size, 1)
  clearTimeout(active.timer)
})

function modeOf(path) {
  return statSync(path).mode & 0o777
}

function leftoverCopies(token) {
  const found = []
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('tdl-session-')) continue
    const file = join(tmpdir(), name, 'default')
    try {
      if (existsSync(file) && readFileSync(file, 'utf8') === token) found.push(file)
    } catch {
      /* directory may vanish during parallel cleanup */
    }
  }
  return found
}

function writeFakeTdl(dir, fail = false) {
  const bin = join(dir, fail ? 'fake-tdl-fail.cjs' : 'fake-tdl.cjs')
  const body = fail
    ? `#!/usr/bin/env node
process.stderr.write('serve failed\\n')
process.exit(1)
`
    : `#!/usr/bin/env node
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const flag = args.indexOf('--storage')
const storage = flag === -1 ? '' : String(args[flag + 1] || '')
const pathEq = storage.indexOf('path=')
const storageDir = pathEq === -1 ? '' : storage.slice(pathEq + 5).split(',')[0]
if (args.includes('export')) {
  if (storageDir) writeFileSync(join(storageDir, 'export-args.json'), JSON.stringify(args))
  const out = args[args.indexOf('-o') + 1]
  if (out) writeFileSync(out, JSON.stringify({ messages: [] }))
  process.exit(0)
}
if (storageDir) writeFileSync(join(storageDir, 'serve-args.json'), JSON.stringify(args))
const port = Number(args[args.indexOf('--port') + 1])
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html>tdl serve <a href="111/222">111/222</a></html>')
})
server.on('error', () => process.exit(1))
server.listen(port, '127.0.0.1')
`
  writeFileSync(bin, body, { mode: 0o755 })
  chmodSync(bin, 0o755)
  return bin
}

function sessionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tdl-src-'))
  const file = join(dir, 'default')
  const token = `bolt-fixture-${process.pid}-${Date.now()}-${Math.random()}`
  writeFileSync(file, token)
  chmodSync(file, 0o644)
  return { dir, file, token }
}

test('isolateBoltSession makes distinct user-only copies and leaves the source untouched', () => {
  const { dir, file, token } = sessionFixture()
  const sourceMode = statSync(file).mode
  try {
    const first = isolateBoltSession(file)
    const second = isolateBoltSession(file)
    try {
      assert.notEqual(first, second)
      assert.equal(modeOf(first), 0o700)
      assert.equal(modeOf(second), 0o700)
      assert.equal(modeOf(join(first, 'default')), 0o600)
      assert.equal(modeOf(join(second, 'default')), 0o600)
      assert.equal(readFileSync(join(first, 'default'), 'utf8'), token)
      assert.equal(readFileSync(join(second, 'default'), 'utf8'), token)
      assert.equal(readFileSync(file, 'utf8'), token)
      assert.equal(statSync(file).mode, sourceMode)
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TdlRunner serves distinct Telegram URLs from isolated session stores', async (t) => {
  const { dir, file, token } = sessionFixture()
  const tdlBin = writeFakeTdl(dir)
  const runner = new TdlRunner({ tdlBin, sessionStorePath: file })
  const urlA = 'https://t.me/channel/1302'
  const urlB = 'https://t.me/channel/1303'
  t.after(async () => {
    for (const slot of [...runner.serves.values()]) {
      for (const served of slot.files) await runner.markServedComplete(served.url)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const [first, second] = await Promise.all([
    runner.resolve({ url: urlA }),
    runner.resolve({ url: urlB }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)

  const slotA = runner.serves.get(urlA)
  const slotB = runner.serves.get(urlB)
  assert.ok(slotA?.sessionDir)
  assert.ok(slotB?.sessionDir)
  assert.notEqual(slotA.sessionDir, slotB.sessionDir)
  assert.equal(modeOf(slotA.sessionDir), 0o700)
  assert.equal(modeOf(slotB.sessionDir), 0o700)
  assert.equal(modeOf(join(slotA.sessionDir, 'default')), 0o600)
  assert.equal(modeOf(join(slotB.sessionDir, 'default')), 0o600)
  assert.equal(readFileSync(join(slotA.sessionDir, 'default'), 'utf8'), token)
  assert.equal(readFileSync(join(slotB.sessionDir, 'default'), 'utf8'), token)
  assert.equal(readFileSync(file, 'utf8'), token)
  assert.equal(modeOf(file), 0o644)

  const exportArgs = JSON.parse(readFileSync(join(slotA.sessionDir, 'export-args.json'), 'utf8'))
  const serveArgs = JSON.parse(readFileSync(join(slotA.sessionDir, 'serve-args.json'), 'utf8'))
  assert.deepEqual(exportArgs.slice(0, 3), ['--storage', `type=bolt,path=${slotA.sessionDir}`, 'chat'])
  assert.deepEqual(serveArgs.slice(0, 3), ['--storage', `type=bolt,path=${slotA.sessionDir}`, 'dl'])
  assert.ok(serveArgs.includes('--serve'))
  const otherServe = JSON.parse(readFileSync(join(slotB.sessionDir, 'serve-args.json'), 'utf8'))
  assert.equal(otherServe[1], `type=bolt,path=${slotB.sessionDir}`)
  assert.notEqual(serveArgs[1], otherServe[1])

  await runner.markServedComplete(first.files[0].url)
  assert.equal(existsSync(slotA.sessionDir), false)
  assert.equal(existsSync(join(slotB.sessionDir, 'default')), true)
  assert.equal(runner.serves.size, 1)
  assert.equal(readFileSync(file, 'utf8'), token)

  await runner.markServedComplete(second.files[0].url)
  assert.equal(existsSync(slotB.sessionDir), false)
  assert.equal(runner.serves.size, 0)
  assert.equal(readFileSync(file, 'utf8'), token)
  assert.equal(modeOf(file), 0o644)
  assert.deepEqual(leftoverCopies(token), [])
})

test('TdlRunner cleans isolated session copies after a failed serve startup', async (t) => {
  const { dir, file, token } = sessionFixture()
  const tdlBin = writeFakeTdl(dir, true)
  const runner = new TdlRunner({ tdlBin, sessionStorePath: file })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const result = await runner.resolve({ url: 'https://t.me/channel/1304' })
  assert.equal(result.ok, false)
  assert.equal(runner.serves.size, 0)
  assert.equal(readFileSync(file, 'utf8'), token)
  assert.equal(modeOf(file), 0o644)
  assert.deepEqual(leftoverCopies(token), [])
})
