import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isAria2Gid } from './aria2.js'
import { parseTelegramMessageUrl } from './links.js'
import { findTerminalMotrixTask, removeMotrixTask } from './motrix.js'
import { tdlSaveDir } from './paths.js'

const SETTINGS = join(homedir(), 'Library/Application Support/Motrix/settings.json')
const SEEN_LIMIT = 1000

/**
 * @param {any[]} statuses
 * @param {(raw: string) => string | null} parseUrl
 */
export function extractTelegramJobs(statuses, parseUrl) {
  const jobs = []
  for (const status of statuses || []) {
    const gid = status?.gid
    const dir = status?.dir
    if (!isAria2Gid(gid) || typeof dir !== 'string') continue
    for (const file of status.files || []) {
      for (const entry of file.uris || []) {
        const parsed = parseUrl(String(entry?.uri || ''))
        if (parsed) {
          jobs.push({
            gid,
            uri: parsed,
            dir,
            path: typeof file.path === 'string' ? file.path : undefined,
          })
        }
      }
    }
  }
  return jobs
}

function loadRpc() {
  const raw = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  const port = Number(raw?.engine?.rpcPort) || 16800
  const secret = String(raw?.engine?.rpcSecret || '')
  if (!secret) return null
  return { port, secret }
}

async function rpc(rpcConf, method, extra = []) {
  const body = {
    jsonrpc: '2.0',
    id: String(Date.now()),
    method,
    params: [`token:${rpcConf.secret}`, ...extra],
  }
  const res = await fetch(`http://127.0.0.1:${rpcConf.port}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || method)
  return json.result
}

function controlFiles(dir, gid) {
  return [
    join(dir, `${gid}.motrix`),
    join(dir, `${gid}.aria2`),
  ]
}

export function isPathInside(dir, path) {
  if (typeof dir !== 'string' || typeof path !== 'string') return false
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function isSafeFilename(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '..' &&
    !value.startsWith('.')
  )
}

function extractServedJobs(statuses, lookupFilename, targetDir) {
  const jobs = []
  for (const status of statuses || []) {
    const gid = status?.gid
    const dir = status?.dir
    if (!isAria2Gid(gid) || typeof dir !== 'string' || status?.status === 'removed') continue
    for (const file of status.files || []) {
      let matched = false
      for (const entry of file.uris || []) {
        const uri = String(entry?.uri || '')
        const filename = lookupFilename(uri)
        if (!isSafeFilename(filename)) continue
        const currentOut = typeof file.path === 'string' ? basename(file.path) : ''
        if (resolve(dir) === resolve(targetDir) && currentOut === filename) {
          matched = true
          break
        }
        jobs.push({
          gid,
          uri,
          dir,
          path: typeof file.path === 'string' ? file.path : undefined,
          filename,
        })
        matched = true
        break
      }
      if (matched) break
    }
  }
  return jobs
}

/**
 * @param {{
 *   resolve: (req: { url: string, group?: boolean }) => Promise<any>,
 *   lookupServedFilename?: (url: string) => string | null,
 * }} runner
 * @param {{
 *   intervalMs?: number,
 *   reconnectMs?: number,
 *   loadRpc?: () => { port: number, secret: string } | null,
 *   rpc?: (rpcConf: any, method: string, extra?: any[]) => Promise<any>,
 *   removeMotrixTask?: (gid: string) => Promise<boolean>,
 *   findTerminalMotrixTask?: (gid: string) => { id: string, status: string, type: string } | null,
 *   saveDir?: () => string,
 *   WebSocket?: typeof globalThis.WebSocket,
 * }} [opts]
 */
export function startAria2Watch(runner, opts = {}) {
  const intervalMs = opts.intervalMs ?? 250
  const reconnectMs = opts.reconnectMs ?? 1000
  const loadRpcConf = opts.loadRpc ?? loadRpc
  const rpcCall = opts.rpc ?? rpc
  const removeTask = opts.removeMotrixTask ?? removeMotrixTask
  const findTerminalTask = opts.findTerminalMotrixTask ?? findTerminalMotrixTask
  const saveDir = opts.saveDir ?? tdlSaveDir
  const WebSocketImpl = opts.WebSocket ?? globalThis.WebSocket
  const keys = ['gid', 'dir', 'files', 'status']
  const seen = new Set()
  const pendingGids = new Set()
  let workQueue = Promise.resolve()
  let busy = false
  let socket
  let reconnectTimer
  let stopped = false

  function remember(gid) {
    if (!isAria2Gid(gid)) return false
    if (seen.has(gid)) return false
    seen.add(gid)
    if (seen.size > SEEN_LIMIT) {
      seen.delete(seen.values().next().value)
    }
    return true
  }

  async function intercept(statuses, rpcConf) {
    const targetDir = saveDir()
    const telegramJobs = extractTelegramJobs(
      statuses.filter((status) => status?.status !== 'removed'),
      parseTelegramMessageUrl
    )
    const servedJobs = typeof runner.lookupServedFilename === 'function'
      ? extractServedJobs(
          statuses,
          (url) => runner.lookupServedFilename(url),
          targetDir
        )
      : []
    const jobs = [...telegramJobs, ...servedJobs]
    const retryLater = new Set()
    for (const job of jobs) {
      if (retryLater.has(job.gid)) continue
      if (!remember(job.gid)) continue
      console.log(JSON.stringify({ msg: 'intercept', gid: job.gid, url: job.uri }))
      let motrixRemoval
      try {
        motrixRemoval = await removeTask(job.gid)
      } catch {
        retryLater.add(job.gid)
        seen.delete(job.gid)
        continue
      }
      if (motrixRemoval !== true && motrixRemoval !== false) {
        retryLater.add(job.gid)
        seen.delete(job.gid)
        continue
      }
      if (motrixRemoval === false) {
        try {
          await rpcCall(rpcConf, 'aria2.forceRemove', [job.gid])
        } catch {
          /* already gone */
        }
        try {
          await rpcCall(rpcConf, 'aria2.removeDownloadResult', [job.gid])
        } catch {
          /* not in result list */
        }
      }
      for (const leftover of [
        job.path,
        ...controlFiles(job.dir, job.gid),
      ].filter((path) => isPathInside(job.dir, path))) {
        try {
          unlinkSync(leftover)
        } catch {
          /* optional */
        }
      }
      let files
      if (job.filename) {
        files = [{ url: job.uri, filename: job.filename }]
      } else {
        const resolved = await runner.resolve({ url: job.uri, group: true })
        if (!resolved?.ok || !resolved.files?.length) {
          console.log(
            JSON.stringify({
              msg: 'intercept_fail',
              gid: job.gid,
              message: resolved?.message,
            })
          )
          continue
        }
        files = resolved.files
      }
      for (const file of files) {
        const options = { dir: targetDir }
        if (file.filename && !file.filename.includes('/') && !file.filename.startsWith('.')) {
          options.out = file.filename
        }
        const newGid = await rpcCall(rpcConf, 'aria2.addUri', [[file.url], options])
        if (isAria2Gid(newGid)) remember(newGid)
      }
      console.log(
        JSON.stringify({
          msg: 'intercept_done',
          gid: job.gid,
          files: files.length,
        })
      )
    }
  }

  function enqueueWork(work) {
    const pending = workQueue.then(work)
    workQueue = pending.catch(() => {})
    return pending
  }

  async function evictTerminalResults(stoppedJobs, liveJobs, rpcConf) {
    const liveGids = new Set(liveJobs.map((job) => job?.gid))
    const removedGids = new Set()
    for (const job of stoppedJobs) {
      const gid = job?.gid
      if (
        !isAria2Gid(gid) ||
        !['error', 'complete'].includes(job?.status) ||
        liveGids.has(gid) ||
        removedGids.has(gid)
      ) continue

      let task
      try {
        task = findTerminalTask(gid)
      } catch {
        continue
      }
      if (!task) continue

      try {
        await rpcCall(rpcConf, 'aria2.removeDownloadResult', [gid])
        removedGids.add(gid)
        console.log(JSON.stringify({
          msg: 'terminal_engine_evicted',
          gid,
          taskId: task.id,
          status: task.status,
        }))
      } catch {
        /* Motrix may still be finalizing; retry on the next tick. */
      }
    }

    if (removedGids.size > 0) {
      try {
        await rpcCall(rpcConf, 'aria2.saveSession')
      } catch {
        /* aria2 will retry its regular session save. */
      }
    }
  }

  async function tick() {
    if (busy) return
    let rpcConf
    try {
      rpcConf = loadRpcConf()
    } catch {
      return
    }
    if (!rpcConf) return
    busy = true
    try {
      const [active, waiting, stoppedJobs] = await Promise.all([
        rpcCall(rpcConf, 'aria2.tellActive', [keys]),
        rpcCall(rpcConf, 'aria2.tellWaiting', [0, 50, keys]),
        rpcCall(rpcConf, 'aria2.tellStopped', [-1, 50, keys]),
      ])
      const liveJobs = [...(active || []), ...(waiting || [])]
      const terminalJobs = (stoppedJobs || []).filter((status) =>
        ['error', 'complete'].includes(status?.status)
      )
      await enqueueWork(async () => {
        await intercept([...liveJobs, ...terminalJobs], rpcConf)
        await evictTerminalResults(terminalJobs, liveJobs, rpcConf)
      })
    } catch {
      /* aria2 not up yet */
    } finally {
      busy = false
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connectSocket()
    }, reconnectMs)
    reconnectTimer.unref?.()
  }

  function connectSocket() {
    if (stopped) return
    let rpcConf
    try {
      rpcConf = loadRpcConf()
    } catch {
      scheduleReconnect()
      return
    }
    if (!rpcConf) {
      scheduleReconnect()
      return
    }
    try {
      socket = new WebSocketImpl(`ws://127.0.0.1:${rpcConf.port}/jsonrpc`)
    } catch {
      scheduleReconnect()
      return
    }
    socket.onmessage = (event) => {
      let notification
      try {
        notification = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (notification?.method !== 'aria2.onDownloadStart') return
      const gid = notification?.params?.[0]?.gid
      if (
        !isAria2Gid(gid) ||
        seen.has(gid) ||
        pendingGids.has(gid) ||
        pendingGids.size >= SEEN_LIMIT
      ) return
      pendingGids.add(gid)
      enqueueWork(async () => {
        try {
          if (seen.has(gid)) return
          const status = await rpcCall(rpcConf, 'aria2.tellStatus', [gid, keys])
          await intercept([status], rpcConf)
        } finally {
          pendingGids.delete(gid)
        }
      }).catch(() => {})
    }
    socket.onclose = () => {
      socket = undefined
      scheduleReconnect()
    }
    socket.onerror = () => {}
  }

  const timer = setInterval(() => {
    tick().catch(() => {})
  }, intervalMs)
  timer.unref?.()
  connectSocket()
  tick().catch(() => {})
  return () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(reconnectTimer)
    try {
      socket?.close()
    } catch {
      /* already closed */
    }
  }
}
