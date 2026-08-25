import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  findMotrixTaskId,
  findTerminalMotrixTask,
  removeMotrixTask,
} from '../bridge/motrix.js'

const gid = '0123456789abcdef'

async function withMotrixFiles(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tdl-motrix-test-'))
  const dbPath = join(dir, 'motrix.db')
  const endpointPath = join(dir, 'endpoint.json')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE tasks (
    motrix_id TEXT PRIMARY KEY,
    agg_status TEXT NOT NULL,
    task_type TEXT NOT NULL
  )`)
  db.exec('CREATE TABLE task_instances (motrix_id TEXT NOT NULL, gid TEXT UNIQUE)')
  db.prepare('INSERT INTO tasks (motrix_id, agg_status, task_type) VALUES (?, ?, ?)')
    .run('task-exact', 'completed', 'http')
  db.prepare('INSERT INTO tasks (motrix_id, agg_status, task_type) VALUES (?, ?, ?)')
    .run('task-neighbour', 'downloading', 'http')
  db.prepare('INSERT INTO task_instances (motrix_id, gid) VALUES (?, ?)')
    .run('task-exact', gid)
  db.prepare('INSERT INTO task_instances (motrix_id, gid) VALUES (?, ?)')
    .run('task-neighbour', '0123456789abcdee')
  db.close()
  try {
    return await run({ dbPath, endpointPath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('findMotrixTaskId requires an exact 16-digit aria2 gid', async () => {
  await withMotrixFiles(({ dbPath }) => {
    assert.equal(findMotrixTaskId(gid, { dbPath }), 'task-exact')
    assert.equal(findMotrixTaskId('0123456789abcdee', { dbPath }), 'task-neighbour')
    assert.equal(findMotrixTaskId(gid.toUpperCase(), { dbPath }), null)
    assert.equal(findMotrixTaskId('0123456789abcde', { dbPath }), null)
    assert.equal(findMotrixTaskId(`${gid}%`, { dbPath }), null)
  })
})

test('findTerminalMotrixTask returns only persisted terminal direct downloads', async () => {
  await withMotrixFiles(({ dbPath }) => {
    assert.deepEqual(findTerminalMotrixTask(gid, { dbPath }), {
      id: 'task-exact',
      status: 'completed',
      type: 'http',
    })
    assert.equal(findTerminalMotrixTask('0123456789abcdee', { dbPath }), null)
    assert.equal(findTerminalMotrixTask(gid.toUpperCase(), { dbPath }), null)

    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE tasks SET task_type = ? WHERE motrix_id = ?')
      .run('bt', 'task-exact')
    db.close()
    assert.equal(findTerminalMotrixTask(gid, { dbPath }), null)
  })
})

test('removeMotrixTask rejects incomplete 2xx JSON-RPC responses', async () => {
  await withMotrixFiles(async ({ dbPath, endpointPath }) => {
    writeFileSync(endpointPath, JSON.stringify({
      port: 60657,
      localToken: 'test-token-not-a-secret',
    }))
    for (const payload of [
      {},
      { jsonrpc: '2.0', id: 'tdl-motrix', result: { ok: false } },
    ]) {
      await assert.rejects(
        removeMotrixTask(gid, {
          dbPath,
          endpointPath,
          fetch: async () => ({
            ok: true,
            async json() {
              return payload
            },
          }),
        }),
        /Motrix task removal failed/
      )
    }
  })
})

test('removeMotrixTask sends one authenticated exact task/remove request', async () => {
  await withMotrixFiles(async ({ dbPath, endpointPath }) => {
    writeFileSync(endpointPath, JSON.stringify({
      port: 60657,
      localToken: 'test-token-not-a-secret',
    }))
    const requests = []
    const removed = await removeMotrixTask(gid, {
      dbPath,
      endpointPath,
      fetch: async (url, options) => {
        requests.push({ url, options })
        return {
          ok: true,
          async json() {
            return { jsonrpc: '2.0', id: 'tdl-motrix', result: { ok: true } }
          },
        }
      },
    })

    assert.equal(removed, true)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'http://127.0.0.1:60657/mdxp')
    assert.equal(requests[0].options.headers.authorization, 'Bearer test-token-not-a-secret')
    const body = JSON.parse(requests[0].options.body)
    assert.equal(body.method, 'task/remove')
    assert.deepEqual(body.params, { taskId: 'task-exact', deleteFiles: false })
  })
})
