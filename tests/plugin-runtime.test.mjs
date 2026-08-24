import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const pluginPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'dist',
  'plugin.js'
)

function loadPlugin() {
  let handler
  const requests = []
  const pluginApi = {
    hooks: {
      beforeCreate(value) {
        handler = value
      },
    },
    http: {
      async request(request) {
        requests.push(request)
        if (request.url.endsWith('/status')) {
          return {
            status: 200,
            body: { tdl: true, loggedIn: true, saveDir: '/downloads/tg' },
          }
        }
        return {
          status: 200,
          body: {
            ok: true,
            files: [{
              url: 'http://127.0.0.1:16808/file.mp4',
              filename: 'file.mp4',
            }],
          },
        }
      },
    },
    log: { info() {} },
  }
  const source = readFileSync(pluginPath, 'utf8')
  const executable = source.replace(
    /^import\s+\{[^}]+\}\s+from\s+["']motrix:plugin-api["'];?$/m,
    'const { hooks, http, log } = pluginApi;'
  )
  assert.notEqual(executable, source, 'plugin API import was not replaced')
  const context = vm.createContext({ pluginApi })
  assert.equal(vm.runInContext('typeof URL', context), 'undefined')
  new vm.Script(executable, { filename: pluginPath }).runInContext(context)
  assert.equal(typeof handler, 'function')
  return { handler, requests }
}

async function runBeforeCreate(handler, uri) {
  const updates = []
  const ctx = {
    uris: [uri],
    saveDir: '/downloads/original',
    async update(patch) {
      updates.push(patch)
    },
  }
  await handler(ctx)
  return updates
}

for (const [kind, uri] of [
  ['public', 'https://t.me/Pureanimation/3932'],
  ['private', 'https://t.me/c/1697797156/151'],
]) {
  test(`plugin resolves ${kind} Telegram links without WHATWG URL`, async () => {
    const { handler, requests } = loadPlugin()
    const updates = await runBeforeCreate(handler, uri)

    assert.equal(updates.length, 1)
    assert.deepEqual([...updates[0].uris], ['http://127.0.0.1:16808/file.mp4'])
    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, 'http://127.0.0.1:16808/status')
    assert.equal(requests[1].url, 'http://127.0.0.1:16808/resolve')
    assert.equal(requests[1].body.data.url, uri)
    assert.equal(requests[1].body.data.saveDir, '/downloads/tg')
  })
}

test('plugin does not call the bridge for blocked or lookalike hosts', async () => {
  for (const uri of [
    'https://t.me/joinchat/3932',
    'https://t.me.evil.example/Pureanimation/3932',
  ]) {
    const { handler, requests } = loadPlugin()
    const updates = await runBeforeCreate(handler, uri)
    assert.equal(requests.length, 0)
    assert.equal(updates.length, 0)
  }
})
