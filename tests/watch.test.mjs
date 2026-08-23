import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTelegramMessageUrl } from '../bridge/links.js'
import {
  extractTelegramJobs,
  isPathInside,
  startAria2Watch,
} from '../bridge/watch.js'

test('extractTelegramJobs picks t.me message uris and skips regular http', () => {
  const jobs = extractTelegramJobs(
    [
      {
        gid: 'aaa',
        dir: '/Users/furina/Downloads',
        files: [
          {
            path: '/Users/furina/Downloads/2094',
            uris: [{ uri: 'https://t.me/sjhxmfd_0/2094' }],
          },
        ],
      },
      {
        gid: 'bbb',
        dir: '/tmp',
        files: [{ uris: [{ uri: 'http://127.0.0.1:18898/3914669213/2094' }] }],
      },
    ],
    parseTelegramMessageUrl
  )
  assert.deepEqual(jobs, [
    {
      gid: 'aaa',
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

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('timed out waiting for watcher')
}

test('startAria2Watch intercepts a Telegram task that already moved to stopped', async () => {
  const calls = []
  let resolveCalls = 0
  const rpc = async (_conf, method, extra) => {
    calls.push({ method, extra })
    if (method === 'aria2.tellStopped') {
      return [telegramStatus('stopped-gid', 'error')]
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
    assert.equal(count(calls, 'aria2.forceRemove'), 1)
    assert.equal(count(calls, 'aria2.removeDownloadResult'), 1)
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
        telegramStatus('complete-gid', 'complete'),
        telegramStatus('removed-gid', 'removed'),
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
      ['complete-gid']
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
        for (const gid of ['instant-gid', 'complete-gid', 'removed-gid']) {
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
      const status = gid === 'instant-gid' ? 'error' : gid.replace('-gid', '')
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
        for (const gid of ['first-gid', 'first-gid', 'second-gid']) {
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
