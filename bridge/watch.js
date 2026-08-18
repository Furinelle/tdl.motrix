import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseTelegramMessageUrl } from './links.js'
import { tdlSaveDir } from './paths.js'

const SETTINGS = join(homedir(), 'Library/Application Support/Motrix/settings.json')

/**
 * @param {any[]} statuses
 * @param {(raw: string) => string | null} parseUrl
 */
export function extractTelegramJobs(statuses, parseUrl) {
  const jobs = []
  for (const status of statuses || []) {
    const gid = status?.gid
    const dir = status?.dir
    if (!gid || typeof dir !== 'string') continue
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

/**
 * @param {{ resolve: (req: { url: string, group?: boolean }) => Promise<any> }} runner
 */
export function startAria2Watch(runner, opts = {}) {
  const intervalMs = opts.intervalMs ?? 250
  const seen = new Set()
  let busy = false

  async function tick() {
    if (busy) return
    let rpcConf
    try {
      rpcConf = loadRpc()
    } catch {
      return
    }
    if (!rpcConf) return
    busy = true
    try {
      const keys = ['gid', 'dir', 'files', 'status']
      const [active, waiting] = await Promise.all([
        rpc(rpcConf, 'aria2.tellActive', [keys]),
        rpc(rpcConf, 'aria2.tellWaiting', [0, 50, keys]),
      ])
      const jobs = extractTelegramJobs(
        [...(active || []), ...(waiting || [])],
        parseTelegramMessageUrl
      )
      for (const job of jobs) {
        if (seen.has(job.gid)) continue
        seen.add(job.gid)
        console.log(JSON.stringify({ msg: 'intercept', gid: job.gid, url: job.uri }))
        try {
          await rpc(rpcConf, 'aria2.forceRemove', [job.gid])
        } catch {
          /* already gone */
        }
        try {
          await rpc(rpcConf, 'aria2.removeDownloadResult', [job.gid])
        } catch {
          /* not in result list */
        }
        for (const leftover of [
          job.path,
          ...controlFiles(job.dir, job.gid),
        ].filter(Boolean)) {
          try {
            unlinkSync(leftover)
          } catch {
            /* optional */
          }
        }
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
        const saveDir = tdlSaveDir()
        for (const file of resolved.files) {
          const options = { dir: saveDir }
          if (file.filename && !file.filename.includes('/') && !file.filename.startsWith('.')) {
            options.out = file.filename
          }
          await rpc(rpcConf, 'aria2.addUri', [[file.url], options])
        }
        console.log(
          JSON.stringify({
            msg: 'intercept_done',
            gid: job.gid,
            files: resolved.files.length,
          })
        )
      }
    } catch {
      /* aria2 not up yet */
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => {})
  }, intervalMs)
  timer.unref?.()
  tick().catch(() => {})
  return () => clearInterval(timer)
}
