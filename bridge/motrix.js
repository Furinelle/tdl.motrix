import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isAria2Gid } from './aria2.js'

const MOTRIX_DIR = join(homedir(), 'Library/Application Support/Motrix')
const MOTRIX_DB = join(MOTRIX_DIR, 'motrix.db')
const ENDPOINT = join(MOTRIX_DIR, 'bridge/endpoint.json')

/**
 * @param {string} gid
 * @param {{ dbPath?: string }} [opts]
 */
export function findMotrixTaskId(gid, opts = {}) {
  if (!isAria2Gid(gid)) return null
  const db = new DatabaseSync(opts.dbPath ?? MOTRIX_DB, { readOnly: true })
  try {
    const row = db.prepare(
      'SELECT motrix_id FROM task_instances WHERE gid = ? LIMIT 1'
    ).get(gid)
    return typeof row?.motrix_id === 'string' && row.motrix_id ? row.motrix_id : null
  } finally {
    db.close()
  }
}

/**
 * @param {string} gid
 * @param {{ dbPath?: string }} [opts]
 */
export function findTerminalMotrixTask(gid, opts = {}) {
  if (!isAria2Gid(gid)) return null
  const db = new DatabaseSync(opts.dbPath ?? MOTRIX_DB, { readOnly: true })
  try {
    const row = db.prepare(`
      SELECT tasks.motrix_id, tasks.agg_status, tasks.task_type
      FROM tasks
      JOIN task_instances ON task_instances.motrix_id = tasks.motrix_id
      WHERE task_instances.gid = ?
        AND tasks.agg_status IN ('completed', 'error')
        AND tasks.task_type IN ('http', 'ftp', 'metalink')
      LIMIT 1
    `).get(gid)
    if (!row) return null
    return { id: row.motrix_id, status: row.agg_status, type: row.task_type }
  } finally {
    db.close()
  }
}

/**
 * @param {string} gid
 * @param {{
 *   dbPath?: string,
 *   endpointPath?: string,
 *   fetch?: typeof globalThis.fetch,
 * }} [opts]
 */
export async function removeMotrixTask(gid, opts = {}) {
  const taskId = findMotrixTaskId(gid, { dbPath: opts.dbPath })
  if (!taskId) return false

  const endpoint = JSON.parse(
    readFileSync(opts.endpointPath ?? ENDPOINT, 'utf8')
  )
  const port = Number(endpoint?.port)
  const token = endpoint?.localToken
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token) {
    throw new Error('Motrix endpoint is unavailable')
  }

  const fetchImpl = opts.fetch ?? fetch
  const response = await fetchImpl(`http://127.0.0.1:${port}/mdxp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'tdl-motrix',
      method: 'task/remove',
      params: { taskId, deleteFiles: false },
    }),
    signal: AbortSignal.timeout(2000),
  })
  const result = await response.json()
  if (
    !response.ok ||
    result?.jsonrpc !== '2.0' ||
    result?.id !== 'tdl-motrix' ||
    result?.result?.ok !== true
  ) {
    throw new Error('Motrix task removal failed')
  }
  return true
}
