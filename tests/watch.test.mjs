import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseTelegramMessageUrl } from '../bridge/links.js'
import { TdlRunner } from '../bridge/tdl.js'
import {
  extractTelegramJobs,
  isPathInside,
  startAria2Watch,
} from '../bridge/watch.js'

const gids = {
  extracted: 'aaaaaaaaaaaaaaaa',
  other: 'bbbbbbbbbbbbbbbb',
  original: '1111111111111111',
  rebuilt: '2222222222222222',
  unknown: '3333333333333333',
  stopped: '4444444444444444',
  complete: '5555555555555555',
  removed: '6666666666666666',
  instant: '7777777777777777',
  first: '8888888888888888',
  second: '9999999999999999',
}
const noMotrixTask = async () => false

test('extractTelegramJobs picks t.me message uris and skips regular http', () => {
  const jobs = extractTelegramJobs(
    [
      {
        gid: gids.extracted,
        dir: '/Users/furina/Downloads',
        files: [
          {
            path: '/Users/furina/Downloads/2094',
            uris: [{ uri: 'https://t.me/sjhxmfd_0/2094' }],
          },
        ],
      },
      {
        gid: gids.other,
        dir: '/tmp',
        files: [{ uris: [{ uri: 'http://127.0.0.1:18898/3914669213/2094' }] }],
      },
    ],
    parseTelegramMessageUrl
  )
  assert.deepEqual(jobs, [
    {
      gid: gids.extracted,
      uri: 'https://t.me/sjhxmfd_0/2094',
      dir: '/Users/furina/Downloads',
      path: '/Users/furina/Downloads/2094',
    },
  ])
})

test('isPathInside rejects paths outside the download directory', () => {
  assert.equal(isPathInside('/downloads/job', '/downloads/job/file'), true)
  assert.equal(isPathInside('/downloads/job', '/downloads/job'), false)
  assert.equal(isPathInside('/downloads/job', '/downloads/job/../outside'), false)
  assert.equal(isPathInside('/downloads/job', '/downloads/job-other/file'), false)
})

const rpcConf = { port: 16800, secret: 'test-secret' }

const telegramStatus = (gid, status) => ({
  gid,
  dir: '/tmp',
  status,
  files: [{
    path: `/tmp/${gid}`,
    uris: [{ uri: 'https://t.me/Pureanimation/3932' }],
  }],
})

const count = (calls, method) => calls.filter((call) => call.method === method).length

const servedUrl = 'http://127.0.0.1:18042/3914669213/1301'
const servedFilename = '217.19MB_cfcb6623_382.MP4'

const servedStatus = (gid, dir, path, uri = servedUrl) => ({
  gid,
  dir,
  status: 'active',
  files: [{ path, uris: [{ uri }] }],
})

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('timed out waiting for watcher')
}

test('TdlRunner looks up safe filenames only for exact served URLs', () => {
  const runner = new TdlRunner({ tdlBin: 'tdl' })
  runner.serves.set('https://t.me/igzztxixoyvx/1301', {
    files: [
      { url: servedUrl, filename: servedFilename },
      { url: `${servedUrl}/unsafe`, filename: '../escape.mp4' },
    ],
  })

  assert.equal(runner.lookupServedFilename(servedUrl), servedFilename)
  assert.equal(runner.lookupServedFilename(`${servedUrl}?download=1`), null)
  assert.equal(runner.lookupServedFilename(`${servedUrl}/unsafe`), null)
})

test('startAria2Watch evicts only persisted terminal direct-download engine results', async () => {
  const calls = []
  const terminal = {
    gid: gids.complete,
    dir: '/downloads',
    status: 'complete',
    files: [{ path: '/downloads/video.mp4', uris: [{ uri: 'https://example.com/video.mp4' }] }],
  }
  const active = { ...terminal, gid: gids.other, status: 'active' }
  class MockWebSocket {
    close() {}
  }
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellActive') return [active]
    if (method === 'aria2.tellStopped') return [terminal, terminal, { ...terminal, gid: gids.other }]
    return []
  }
  const stop = startAria2Watch({
    async resolve() {
      assert.fail('ordinary downloads must not be resolved as Telegram links')
    },
  }, {
    intervalMs: 1000,
    loadRpc: () => rpcConf,
    rpc,
    findTerminalMotrixTask: (gid) => gid === gids.complete
      ? { id: 'finished-task', status: 'completed', type: 'http' }
      : null,
    saveDir: () => '/downloads',
    WebSocket: MockWebSocket,
  })

  try {
    await waitFor(() => count(calls, 'aria2.saveSession') === 1)
    assert.deepEqual(
      calls.filter((call) => call.method === 'aria2.removeDownloadResult'),
      [{ method: 'aria2.removeDownloadResult', extra: [gids.complete] }]
    )
    assert.equal(count(calls, 'aria2.forceRemove'), 0)
  } finally {
    stop()
  }
})

test('startAria2Watch rebuilds known served URLs with the tdl filename once', async () => {
  const calls = []
  const motrixRemovals = []
  let socket
  class MockWebSocket {
    constructor() {
      socket = this
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          jsonrpc: '2.0',
          method: 'aria2.onDownloadStart',
          params: [{ gid: gids.original }],
        }),
      }))
    }

    close() {}
  }
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellStatus') {
      if (extra[0] === gids.original) {
        return servedStatus(
          gids.original,
          '/Users/furina/Downloads/Motrix',
          '/Users/furina/Downloads/Motrix/1301'
        )
      }
      return servedStatus(
        gids.rebuilt,
        '/Users/furina/Downloads/Motrix/tg',
        `/Users/furina/Downloads/Motrix/tg/${servedFilename}`
      )
    }
    if (method === 'aria2.addUri') {
      queueMicrotask(() => socket.onmessage?.({
        data: JSON.stringify({
          jsonrpc: '2.0',
          method: 'aria2.onDownloadStart',
          params: [{ gid: gids.rebuilt }],
        }),
      }))
      return gids.rebuilt
    }
    return []
  }
  const runner = {
    lookupServedFilename(url) {
      return url === servedUrl ? servedFilename : null
    },
    async resolve() {
      assert.fail('served URLs must not be resolved as Telegram links')
    },
  }
  const stop = startAria2Watch(runner, {
    intervalMs: 1000,
    loadRpc: () => rpcConf,
    rpc,
    removeMotrixTask: async (gid) => {
      motrixRemovals.push(gid)
      return true
    },
    saveDir: () => '/Users/furina/Downloads/Motrix/tg',
    WebSocket: MockWebSocket,
  })

  try {
    await waitFor(() => count(calls, 'aria2.addUri') === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(
      calls.find((call) => call.method === 'aria2.addUri').extra,
      [[servedUrl], {
        dir: '/Users/furina/Downloads/Motrix/tg',
        out: servedFilename,
      }]
    )
    assert.deepEqual(motrixRemovals, [gids.original])
    assert.equal(count(calls, 'aria2.forceRemove'), 0)
    assert.equal(count(calls, 'aria2.removeDownloadResult'), 0)
    assert.equal(count(calls, 'aria2.addUri'), 1)
  } finally {
    stop()
  }
})

test('startAria2Watch leaves unknown served URLs untouched', async () => {
  const calls = []
  class MockWebSocket {
    constructor() {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          jsonrpc: '2.0',
          method: 'aria2.onDownloadStart',
          params: [{ gid: gids.unknown }],
        }),
      }))
    }

    close() {}
  }
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellStatus') {
      return servedStatus(
        gids.unknown,
        '/Users/furina/Downloads/Motrix',
        '/Users/furina/Downloads/Motrix/1301',
        `${servedUrl}?lookalike=1`
      )
    }
    return []
  }
  const stop = startAria2Watch({
    lookupServedFilename: () => null,
    async resolve() {
      assert.fail('unknown served URLs must not be resolved')
    },
  }, {
    intervalMs: 1000,
    loadRpc: () => rpcConf,
    rpc,
    saveDir: () => '/Users/furina/Downloads/Motrix/tg',
    WebSocket: MockWebSocket,
  })

  try {
    await waitFor(() => count(calls, 'aria2.tellStatus') === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(count(calls, 'aria2.forceRemove'), 0)
    assert.equal(count(calls, 'aria2.removeDownloadResult'), 0)
    assert.equal(count(calls, 'aria2.addUri'), 0)
  } finally {
    stop()
  }
})

test('startAria2Watch rejects invalid status and WebSocket gids before cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdl-watch-invalid-gid-'))
  const invalidStatusGid = 'invalid-status'
  const invalidSocketGid = 'invalid-socket'
  const paths = [
    join(dir, 'download.tmp'),
    join(dir, `${invalidStatusGid}.motrix`),
    join(dir, `${invalidStatusGid}.aria2`),
  ]
  for (const path of paths) writeFileSync(path, 'keep')
  const calls = []
  const motrixRemovals = []
  class MockWebSocket {
    constructor() {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          jsonrpc: '2.0',
          method: 'aria2.onDownloadStart',
          params: [{ gid: invalidSocketGid }],
        }),
      }))
    }

    close() {}
  }
  const invalidStatus = {
    gid: invalidStatusGid,
    dir,
    status: 'active',
    files: [{
      path: paths[0],
      uris: [{ uri: 'https://t.me/Pureanimation/3932' }],
    }],
  }
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellActive') return [invalidStatus]
    if (method === 'aria2.tellStatus') {
      return { ...invalidStatus, gid: invalidSocketGid }
    }
    return []
  }
  const stop = startAria2Watch({
    async resolve() {
      assert.fail('invalid gids must not resolve')
    },
  }, {
    intervalMs: 1000,
    loadRpc: () => rpcConf,
    rpc,
    removeMotrixTask: async (gid) => {
      motrixRemovals.push(gid)
      return false
    },
    saveDir: () => dir,
    WebSocket: MockWebSocket,
  })

  try {
    await waitFor(() => count(calls, 'aria2.tellActive') === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(count(calls, 'aria2.tellStatus'), 0)
    assert.deepEqual(motrixRemovals, [])
    assert.equal(count(calls, 'aria2.forceRemove'), 0)
    assert.equal(count(calls, 'aria2.removeDownloadResult'), 0)
    assert.equal(count(calls, 'aria2.addUri'), 0)
    assert.ok(paths.every((path) => existsSync(path)))
  } finally {
    stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startAria2Watch retries a transient Motrix removal before rebuilding', async () => {
  const calls = []
  let resolveCalls = 0
  let removalAttempts = 0
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellStopped') {
      return [telegramStatus(gids.stopped, 'error')]
    }
    if (method === 'aria2.forceRemove') throw new Error('not active')
    return []
  }
  const stop = startAria2Watch({
    resolve: async () => {
      resolveCalls += 1
      return {
        ok: true,
        files: [{ url: 'http://127.0.0.1:16808/file', filename: '3932.mp4' }],
      }
    },
  }, {
    intervalMs: 5,
    loadRpc: () => rpcConf,
    rpc,
    removeMotrixTask: async () => {
      removalAttempts += 1
      if (removalAttempts === 1) throw new Error('Motrix unavailable')
      return true
    },
    saveDir: () => '/tmp',
    WebSocket: class { close() {} },
  })

  try {
    await waitFor(() => resolveCalls === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(count(calls, 'aria2.tellStopped') >= 2)
    assert.deepEqual(
      calls.find((call) => call.method === 'aria2.tellStopped').extra,
      [-1, 50, ['gid', 'dir', 'files', 'status']]
    )
    assert.equal(removalAttempts, 2)
    assert.equal(count(calls, 'aria2.forceRemove'), 0)
    assert.equal(count(calls, 'aria2.removeDownloadResult'), 0)
    assert.equal(count(calls, 'aria2.addUri'), 1)
    assert.equal(resolveCalls, 1)
  } finally {
    stop()
  }
})

test('startAria2Watch intercepts completed Telegram results but ignores removed', async () => {
  const calls = []
  let resolveCalls = 0
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellStopped') {
      return [
        telegramStatus(gids.complete, 'complete'),
        telegramStatus(gids.removed, 'removed'),
      ]
    }
    return []
  }
  const stop = startAria2Watch({
    resolve: async () => {
      resolveCalls += 1
      return { ok: false }
    },
  }, {
    intervalMs: 5,
    loadRpc: () => rpcConf,
    rpc,
    removeMotrixTask: noMotrixTask,
    saveDir: () => '/tmp',
    WebSocket: class { close() {} },
  })

  try {
    await waitFor(() => resolveCalls === 1)
    assert.equal(count(calls, 'aria2.forceRemove'), 1)
    assert.deepEqual(
      calls
        .filter((call) => call.method === 'aria2.removeDownloadResult')
        .map((call) => call.extra[0]),
      [gids.complete]
    )
  } finally {
    stop()
  }
})

test('startAria2Watch intercepts from onDownloadStart before terminal eviction', async () => {
  const calls = []
  let resolveCalls = 0
  let socketUrl
  class MockWebSocket {
    constructor(url) {
      socketUrl = url
      queueMicrotask(() => {
        for (const gid of [gids.instant, gids.complete, gids.removed]) {
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              method: 'aria2.onDownloadStart',
              params: [{ gid }],
            }),
          })
        }
      })
    }

    close() {}
  }
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellStatus') {
      const gid = extra[0]
      const status = new Map([
        [gids.instant, 'error'],
        [gids.complete, 'complete'],
        [gids.removed, 'removed'],
      ]).get(gid)
      return telegramStatus(gid, status)
    }
    if (method === 'aria2.forceRemove') throw new Error('already stopped')
    return []
  }
  const stop = startAria2Watch({
    resolve: async () => {
      resolveCalls += 1
      return {
        ok: true,
        files: [{ url: 'http://127.0.0.1:16808/file', filename: '3932.mp4' }],
      }
    },
  }, {
    intervalMs: 5,
    loadRpc: () => rpcConf,
    rpc,
    removeMotrixTask: noMotrixTask,
    saveDir: () => '/tmp',
    WebSocket: MockWebSocket,
  })

  try {
    await waitFor(() => resolveCalls >= 1)
    await waitFor(() => count(calls, 'aria2.tellStatus') === 3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(socketUrl, 'ws://127.0.0.1:16800/jsonrpc')
    assert.equal(count(calls, 'aria2.tellStatus'), 3)
    assert.equal(count(calls, 'aria2.removeDownloadResult'), 2)
    assert.equal(resolveCalls, 2)
  } finally {
    stop()
  }
})

test('startAria2Watch serializes simultaneous WebSocket interceptions', async () => {
  let activeResolves = 0
  let activeTellStatus = 0
  let maxActiveResolves = 0
  let maxActiveTellStatus = 0
  let resolveCalls = 0
  let tellStatusCalls = 0
  class MockWebSocket {
    constructor() {
      queueMicrotask(() => {
        for (const gid of [gids.first, gids.first, gids.second]) {
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              method: 'aria2.onDownloadStart',
              params: [{ gid }],
            }),
          })
        }
      })
    }

    close() {}
  }
  const rpc = async (_conf, method, extra) => {
    if (method === 'aria2.tellStatus') {
      tellStatusCalls += 1
      activeTellStatus += 1
      maxActiveTellStatus = Math.max(maxActiveTellStatus, activeTellStatus)
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeTellStatus -= 1
      return telegramStatus(extra[0], 'active')
    }
    return []
  }
  const stop = startAria2Watch({
    resolve: async () => {
      resolveCalls += 1
      activeResolves += 1
      maxActiveResolves = Math.max(maxActiveResolves, activeResolves)
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeResolves -= 1
      return { ok: false }
    },
  }, {
    intervalMs: 1000,
    loadRpc: () => rpcConf,
    rpc,
    removeMotrixTask: noMotrixTask,
    saveDir: () => '/tmp',
    WebSocket: MockWebSocket,
  })

  try {
    await waitFor(() => resolveCalls === 2 && activeResolves === 0)
    assert.equal(tellStatusCalls, 2)
    assert.equal(maxActiveTellStatus, 1)
    assert.equal(maxActiveResolves, 1)
  } finally {
    stop()
  }
})
