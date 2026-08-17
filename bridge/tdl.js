import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { filenameFromContentDisposition, parseServeIndex } from './parseIndex.js'

export const BRIDGE_PORT = 16808
export const SERVE_TTL_MS = 6 * 60 * 60 * 1000
export const RESOLVE_TIMEOUT_MS = 45_000

const TDL_CANDIDATES = [
  process.env.TDL_BIN,
  '/opt/homebrew/bin/tdl',
  '/usr/local/bin/tdl',
  'tdl',
].filter(Boolean)

export function findTdl() {
  for (const bin of TDL_CANDIDATES) {
    if (bin.includes('/') && existsSync(bin)) return bin
  }
  return 'tdl'
}

export function sessionLooksPresent() {
  const root = join(homedir(), '.tdl')
  return (
    existsSync(join(root, 'data', 'default')) ||
    existsSync(join(root, 'data.kv')) ||
    existsSync(join(root, 'data'))
  )
}

export function classifyTdlError(text) {
  const s = String(text || '').toLowerCase()
  if (
    s.includes('not logged') ||
    s.includes('unauthorized') ||
    s.includes('auth key') ||
    s.includes('please login') ||
    s.includes('session') && s.includes('expired')
  ) {
    return { code: 'not_logged_in', message: 'tdl 未登录，请在终端执行 tdl login 后重试' }
  }
  if (s.includes('flood') || s.includes('wait of')) {
    return { code: 'flood', message: 'Telegram 限流，请稍后重试' }
  }
  if (s.includes('not a media') || s.includes('no media') || s.includes('message is not a media')) {
    return { code: 'no_media', message: '这条 Telegram 消息没有可下载的文件' }
  }
  return null
}

function allocatePort() {
  const base = 18000 + Math.floor(Math.random() * 900)
  return base
}

async function waitForIndex(port, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'timeout'
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'timeout' })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal })
      if (res.ok) {
        const html = await res.text()
        if (html.includes('tdl serve') || html.includes('href=')) return html
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw Object.assign(new Error(lastErr), { code: 'timeout' })
}

async function filenameFor(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    const name = filenameFromContentDisposition(res.headers.get('content-disposition'))
    if (name) return name
  } catch {
    /* HEAD may fail; GET range is heavier, skip */
  }
  const tail = url.split('/').filter(Boolean).pop()
  return tail ? `${tail}.bin` : 'telegram.bin'
}

/**
 * @typedef {{ url: string, filename: string }} ServedFile
 * @typedef {{ port: number, proc: import('node:child_process').ChildProcess, files: ServedFile[], startedAt: number, timer: NodeJS.Timeout }} ServeSlot
 */

export class TdlRunner {
  /** @param {{ tdlBin?: string, motrixBin?: string }} [opts] */
  constructor(opts = {}) {
    this.tdlBin = opts.tdlBin || findTdl()
    this.motrixBin = opts.motrixBin || process.env.MOTRIX_BIN || 'motrix'
    /** @type {Map<string, ServeSlot>} */
    this.serves = new Map()
  }

  tdlInstalled() {
    if (this.tdlBin.includes('/')) return existsSync(this.tdlBin)
    return true
  }

  status() {
    const installed = this.tdlInstalled()
    return {
      ok: true,
      tdl: installed,
      loggedIn: installed && sessionLooksPresent(),
      port: BRIDGE_PORT,
    }
  }

  /**
   * @param {{ url: string, saveDir?: string, group?: boolean }} req
   */
  async resolve(req) {
    if (!this.tdlInstalled()) {
      return { ok: false, code: 'no_tdl', message: '未找到 tdl，请先 brew install tdl' }
    }
    if (!sessionLooksPresent()) {
      return { ok: false, code: 'not_logged_in', message: 'tdl 未登录，请在终端执行 tdl login 后重试' }
    }

    const existing = this.serves.get(req.url)
    if (existing?.files?.length) {
      this.#addExtras(existing.files, req.saveDir)
      return { ok: true, files: existing.files }
    }

    try {
      const slot = await this.#startServe(req.url, req.group !== false)
      this.#addExtras(slot.files, req.saveDir)
      return { ok: true, files: slot.files }
    } catch (e) {
      const mapped = classifyTdlError(e instanceof Error ? e.message : e)
      if (mapped) return { ok: false, ...mapped }
      if (e && typeof e === 'object' && 'code' in e && e.code === 'timeout') {
        return { ok: false, code: 'timeout', message: 'tdl 解析超时' }
      }
      if (e && typeof e === 'object' && 'code' in e && e.code === 'no_media') {
        return { ok: false, code: 'no_media', message: '这条 Telegram 消息没有可下载的文件' }
      }
      return {
        ok: false,
        code: 'error',
        message: e instanceof Error ? e.message : 'tdl 解析失败',
      }
    }
  }

  /** @param {string} url @param {boolean} group */
  async #startServe(url, group) {
    const port = allocatePort()
    const args = ['dl', '--serve', '--port', String(port), '-u', url, '--continue']
    if (group) args.push('--group')

    const stderrChunks = []
    const proc = spawn(this.tdlBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    proc.stderr?.on('data', (d) => {
      const s = String(d)
      stderrChunks.push(s)
      if (stderrChunks.join('').length > 8000) stderrChunks.splice(0, 1)
    })
    proc.stdout?.on('data', (d) => {
      stderrChunks.push(String(d))
    })

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), RESOLVE_TIMEOUT_MS)

    const exitError = new Promise((_, reject) => {
      proc.once('error', (err) => {
        if (err && 'code' in err && err.code === 'ENOENT') {
          reject(Object.assign(new Error('未找到 tdl，请先 brew install tdl'), { code: 'no_tdl' }))
          return
        }
        reject(err)
      })
      proc.once('exit', (code) => {
        const text = stderrChunks.join('')
        const mapped = classifyTdlError(text)
        if (mapped) {
          reject(Object.assign(new Error(mapped.message), { code: mapped.code }))
          return
        }
        reject(
          Object.assign(new Error(text.trim() || `tdl exited ${code}`), {
            code: 'error',
          })
        )
      })
    })

    try {
      const html = await Promise.race([
        waitForIndex(port, RESOLVE_TIMEOUT_MS, abort.signal),
        exitError,
      ])
      const listed = parseServeIndex(html, port)
      if (listed.length === 0) {
        proc.kill('SIGTERM')
        throw Object.assign(new Error('这条 Telegram 消息没有可下载的文件'), {
          code: 'no_media',
        })
      }
      const files = []
      for (const item of listed) {
        files.push({ url: item.url, filename: await filenameFor(item.url) })
      }
      const ttl = setTimeout(() => this.#stop(url), SERVE_TTL_MS)
      const slot = { port, proc, files, startedAt: Date.now(), timer: ttl }
      this.serves.set(url, slot)
      proc.once('exit', () => {
        const cur = this.serves.get(url)
        if (cur?.proc === proc) this.serves.delete(url)
      })
      return slot
    } catch (e) {
      proc.kill('SIGTERM')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /** @param {ServedFile[]} files @param {string | undefined} saveDir */
  #addExtras(files, saveDir) {
    if (!saveDir || files.length < 2) return
    for (const file of files.slice(1)) {
      try {
        spawn(
          this.motrixBin,
          ['add', file.url, '--save-dir', saveDir],
          { stdio: 'ignore', detached: true }
        ).unref()
      } catch {
        /* motrix CLI optional */
      }
    }
  }

  /** @param {string} url */
  #stop(url) {
    const slot = this.serves.get(url)
    if (!slot) return
    clearTimeout(slot.timer)
    try {
      slot.proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.serves.delete(url)
  }
}
