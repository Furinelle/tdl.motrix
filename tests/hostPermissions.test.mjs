import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'motrix-plugin.json'),
    'utf8'
  )
)

const MATCH_PATTERN_RE = /^(\*|https?):\/\/(\*|(\*\.)?[A-Za-z0-9.-]+)(\/[^\s]*)?$/

/** Motrix ActivationDispatcher matcher (path `*` = one segment). */
function pl(patterns, url) {
  if (patterns.length === 0) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const scheme = parsed.protocol.replace(':', '')
  for (const pattern of patterns) {
    if (pattern === '<all_urls>') return true
    const m = /^(\*|https?):\/\/(\*|(?:\*\.)?[A-Za-z0-9.-]+)(\/.*)?$/.exec(pattern)
    if (!m) continue
    const [, pScheme, pHost, pPath] = m
    if (
      (pScheme === '*' || pScheme === scheme) &&
      !(pHost !== '*' && !matchHost(pHost, parsed.hostname)) &&
      !(pPath && !matchPathSegmentStar(pPath, parsed.pathname))
    ) {
      return true
    }
  }
  return false
}

function matchHost(pattern, hostname) {
  if (pattern.startsWith('*.')) {
    const root = pattern.slice(2)
    return hostname === root || hostname.endsWith(`.${root}`)
  }
  return hostname === pattern
}

function matchPathSegmentStar(pattern, pathname) {
  return RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`
  ).test(pathname)
}

/** Motrix orchestrator matcher (path `*` = `.*`, including slashes). */
function jb(pattern, url) {
  if (pattern === '<all_urls>') return /^https?:\/\//.test(url)
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/^\.\*:\/\//, '(http|https)://')
  return RegExp(`^${re}$`).test(url)
}

function eligible(patterns, url) {
  return patterns.length !== 0 && patterns.some((p) => jb(p, url))
}

const TASK_URLS = [
  'https://t.me/sjhxmfd_0/2094',
  'https://t.me/telegram/193',
  'https://t.me/c/1697797156/151',
  'https://t.me/iFreeKnow/45662/55005',
  'https://telegram.me/tdl/1',
  'https://telegram.dog/tdl/1',
]

test('single-segment /* does not activate multi-segment t.me urls', () => {
  const old = ['https://t.me/*', 'https://telegram.me/*', 'https://telegram.dog/*']
  assert.equal(pl(old, 'https://t.me/sjhxmfd_0/2094'), false)
  assert.equal(pl(old, 'https://t.me/c/1697797156/151'), false)
  assert.equal(eligible(old, 'https://t.me/sjhxmfd_0/2094'), true)
})

test('manifest hostPermissions pass both Motrix matchers for telegram message urls', () => {
  const patterns = manifest.hostPermissions
  assert.ok(Array.isArray(patterns) && patterns.length > 0)
  for (const url of TASK_URLS) {
    assert.equal(pl(patterns, url), true, `pl() must admit ${url}`)
    assert.equal(eligible(patterns, url), true, `Jb() must admit ${url}`)
  }
})

test('manifest hostPermissions admit the local bridge port', () => {
  const patterns = manifest.hostPermissions
  for (const url of [
    'http://127.0.0.1:16808/status',
    'http://127.0.0.1:16808/resolve',
  ]) {
    assert.equal(eligible(patterns, url), true, `Jb() must admit ${url}`)
  }
})

test('manifest hostPermissions satisfy the official match-pattern schema', () => {
  for (const pattern of manifest.hostPermissions) {
    assert.match(pattern, MATCH_PATTERN_RE)
  }
})

test('bridge permission does not admit non-Telegram HTTPS urls', () => {
  assert.equal(eligible(manifest.hostPermissions, 'https://example.com/file.zip'), false)
})

test('bridge permission does not admit unrelated HTTP paths', () => {
  for (const url of [
    'http://evil.example/file.zip',
    'http://127.0.0.1:16808/file.mp4',
    'http://localhost:16808/other',
  ]) {
    assert.equal(eligible(manifest.hostPermissions, url), false)
  }
})
