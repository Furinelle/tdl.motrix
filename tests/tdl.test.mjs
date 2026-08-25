import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { classifyTdlError, TdlRunner } from '../bridge/tdl.js'

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
