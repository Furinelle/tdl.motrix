import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupedUrlsFromExport, parseMessageRef } from './group.js'
import { findTerminalMotrixTaskByUri } from './motrix.js'
import { filenameFromContentDisposition, parseServeIndex } from './parseIndex.js'
import { tdlSaveDir } from './paths.js'

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

export function defaultBoltSessionPath() {
  return join(homedir(), '.tdl', 'data', 'default')
}

export function sessionLooksPresent(sessionStorePath = defaultBoltSessionPath()) {
  const root = join(homedir(), '.tdl')
  return (
    existsSync(sessionStorePath) ||
    existsSync(join(root, 'data.kv')) ||
    existsSync(join(root, 'data'))
  )
}

export function isolateBoltSession(sourcePath) {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw Object.assign(new Error('tdl 未登录，请在终端执行 tdl login 后重试'), {
      code: 'not_logged_in',
    })
  }
  const dir = mkdtempSync(join(tmpdir(), 'tdl-session-'))
  try {
    chmodSync(dir, 0o700)
    const dest = join(dir, 'default')
    copyFileSync(sourcePath, dest)
    chmodSync(dest, 0o600)
    return dir
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

function boltStorageArgs(sessionDir) {
  return ['--storage', `type=bolt,path=${sessionDir}`]
}

function removeSessionDir(sessionDir) {
  if (!sessionDir) return
  try {
    rmSync(sessionDir, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
}

function procHasExited(proc) {
  if (!proc) return true
  return proc.exitCode !== null || proc.signalCode != null
}

function removeSessionDirWhenExited(proc, sessionDir) {
  if (!sessionDir) return
  if (procHasExited(proc)) {
    removeSessionDir(sessionDir)
    return
  }
  proc.once('exit', () => removeSessionDir(sessionDir))
}

function waitForProcExit(proc, ms = 2000) {
  if (procHasExited(proc)) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    timeout.unref?.()
    proc.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
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
  if (s.includes('database is used by another process')) {
    return { code: 'busy', message: 'tdl 正在处理其他 Telegram 下载，请完成后重试' }
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

/**
 * @typedef {{ url: string, filename: string }} ServedFile
 * @typedef {{ port: number, proc: import('node:child_process').ChildProcess, files: ServedFile[], startedAt: number, timer: NodeJS.Timeout, completedUrls?: Set<string>, sessionDir?: string }} ServeSlot
 */

export class TdlRunner {
  /** @param {{ tdlBin?: string, motrixBin?: string, sessionStorePath?: string, findTerminalTaskByUri?: (uri: string) => any }} [opts] */
  constructor(opts = {}) {
    this.tdlBin = opts.tdlBin || findTdl()
    this.motrixBin = opts.motrixBin || process.env.MOTRIX_BIN || 'motrix'
    this.sessionStorePath = opts.sessionStorePath || defaultBoltSessionPath()
    /** @type {Map<string, ServeSlot>} */
    this.serves = new Map()
    this.findTerminalTaskByUri = opts.findTerminalTaskByUri ?? findTerminalMotrixTaskByUri
    /** @type {Set<Promise<void>>} */
    this.pendingStops = new Set()
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
      saveDir: tdlSaveDir(),
    }
  }

  /** @param {string} url */
  lookupServedFilename(url) {
    if (typeof url !== 'string') return null
    for (const slot of this.serves.values()) {
      for (const file of slot.files || []) {
        if (file.url === url && isSafeFilename(file.filename)) return file.filename
      }
    }
    return null
  }

  /** @param {string} servedUrl */
  async markServedComplete(servedUrl) {
    for (const [sourceUrl, slot] of this.serves) {
      if (!slot.files.some((file) => file.url === servedUrl)) continue
      slot.completedUrls ??= new Set()
      slot.completedUrls.add(servedUrl)
      if (slot.files.every((file) => slot.completedUrls.has(file.url))) {
        await this.#stop(sourceUrl)
      }
    }
  }

  async reapCompletedServes() {
    for (const [sourceUrl, slot] of this.serves) {
      if (!slot.files.length) continue
      let completed = false
      try {
        completed = slot.files.every((file) =>
          slot.completedUrls?.has(file.url) || this.findTerminalTaskByUri(file.url)
        )
      } catch {
        continue
      }
      if (completed) await this.#stop(sourceUrl)
    }
    await Promise.all(this.pendingStops)
  }

  /**
   * @param {{ url: string, saveDir?: string, group?: boolean }} req
   */
  async resolve(req) {
    if (!this.tdlInstalled()) {
      return { ok: false, code: 'no_tdl', message: '未找到 tdl，请先 brew install tdl' }
    }
    if (!existsSync(this.sessionStorePath) && !sessionLooksPresent()) {
      return { ok: false, code: 'not_logged_in', message: 'tdl 未登录，请在终端执行 tdl login 后重试' }
    }

    await this.reapCompletedServes()
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
      if (e && typeof e === 'object' && 'code' in e && e.code === 'not_logged_in') {
        return { ok: false, code: 'not_logged_in', message: 'tdl 未登录，请在终端执行 tdl login 后重试' }
      }
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

  /** @param {string} url @param {string} sessionDir */
  #expandGroup(url, sessionDir) {
    const ref = parseMessageRef(url)
    if (!ref) return [url]
    const from = Math.max(1, ref.messageId - 10)
    const to = ref.messageId + 10
    const dir = mkdtempSync(join(tmpdir(), 'tdl-group-'))
    const out = join(dir, 'export.json')
    const result = spawnSync(
      this.tdlBin,
      [
        ...boltStorageArgs(sessionDir),
        'chat',
        'export',
        '-c',
        ref.chatFlag,
        '-T',
        'id',
        '-i',
        `${from},${to}`,
        '--raw',
        '-o',
        out,
      ],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env } }
    )
    try {
      if (result.status !== 0 || !existsSync(out)) {
        console.log(
          JSON.stringify({
            msg: 'group_export_skip',
            status: result.status,
            err: String(result.stderr || result.stdout || '').slice(0, 300),
          })
        )
        return [url]
      }
      const urls = groupedUrlsFromExport(readFileSync(out, 'utf8'), ref)
      if (!urls.length) return [url]
      console.log(JSON.stringify({ msg: 'group_expanded', count: urls.length }))
      return urls
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** @param {string} url @param {boolean} group */
  async #startServe(url, group) {
    const sessionDir = isolateBoltSession(this.sessionStorePath)
    let proc
    let detachStartup = () => {}
    try {
      const urls = group ? this.#expandGroup(url, sessionDir) : [url]
      const port = allocatePort()
      const args = [
        ...boltStorageArgs(sessionDir),
        'dl',
        '--serve',
        '--port',
        String(port),
        '--continue',
      ]
      for (const item of urls) args.push('-u', item)

      const stderrChunks = []
      proc = spawn(this.tdlBin, args, {
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
      timer.unref?.()

      const onProcError = (err) => {
        if (err && 'code' in err && err.code === 'ENOENT') {
          rejectStartup(Object.assign(new Error('未找到 tdl，请先 brew install tdl'), { code: 'no_tdl' }))
          return
        }
        rejectStartup(err)
      }
      const onProcExit = (code) => {
        const text = stderrChunks.join('')
        const mapped = classifyTdlError(text)
        if (mapped) {
          rejectStartup(Object.assign(new Error(mapped.message), { code: mapped.code }))
          return
        }
        rejectStartup(
          Object.assign(new Error(text.trim() || `tdl exited ${code}`), {
            code: 'error',
          })
        )
      }
      let rejectStartup = () => {}
      const exitError = new Promise((_, reject) => {
        rejectStartup = reject
        proc.once('error', onProcError)
        proc.once('exit', onProcExit)
      })
      detachStartup = () => {
        proc.removeListener('error', onProcError)
        proc.removeListener('exit', onProcExit)
      }

      const indexReady = waitForIndex(port, RESOLVE_TIMEOUT_MS, abort.signal)
      indexReady.catch(() => {})
      try {
        const html = await Promise.race([indexReady, exitError])
        detachStartup()
        const listed = parseServeIndex(html, port)
        if (listed.length === 0) {
          throw Object.assign(new Error('这条 Telegram 消息没有可下载的文件'), {
            code: 'no_media',
          })
        }
        const files = []
        for (const item of listed) {
          files.push({ url: item.url, filename: await filenameFor(item.url) })
        }
        const ttl = setTimeout(() => {
          this.#stop(url).catch(() => {})
        }, SERVE_TTL_MS)
        const slot = {
          port,
          proc,
          files,
          startedAt: Date.now(),
          timer: ttl,
          completedUrls: new Set(),
          sessionDir,
        }
        this.serves.set(url, slot)
        proc.once('exit', () => {
          const cur = this.serves.get(url)
          if (cur?.proc !== proc) return
          clearTimeout(cur.timer)
          this.serves.delete(url)
          removeSessionDir(cur.sessionDir)
        })
        return slot
      } finally {
        abort.abort()
        clearTimeout(timer)
      }
    } catch (e) {
      detachStartup()
      if (proc) {
        try {
          proc.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        await waitForProcExit(proc)
      }
      removeSessionDirWhenExited(proc, sessionDir)
      throw e
    }
  }

  /** @param {ServedFile[]} files @param {string | undefined} saveDir */
  #addExtras(files, saveDir) {
    if (!saveDir || files.length < 2) return
    for (const file of files.slice(1)) {
      try {
        const args = ['add', file.url, '--save-dir', saveDir]
        if (file.filename) args.push('--filename', file.filename)
        spawn(this.motrixBin, args, {
          stdio: 'ignore',
          detached: true,
        }).unref()
      } catch {
        /* motrix CLI optional */
      }
    }
  }

  /** @param {string} url */
  #stop(url) {
    const slot = this.serves.get(url)
    if (!slot) return Promise.resolve()
    clearTimeout(slot.timer)
    this.serves.delete(url)

    const exited = new Promise((resolve) => {
      if (procHasExited(slot.proc)) {
        resolve()
        return
      }
      const timeout = setTimeout(resolve, 2000)
      timeout.unref?.()
      slot.proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    const stopped = exited.then(() => {
      removeSessionDirWhenExited(slot.proc, slot.sessionDir)
    })
    this.pendingStops.add(stopped)
    stopped.finally(() => this.pendingStops.delete(stopped))
    try {
      slot.proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    console.log(JSON.stringify({ msg: 'serve_stopped', url, files: slot.files.length }))
    return stopped
  }
}
