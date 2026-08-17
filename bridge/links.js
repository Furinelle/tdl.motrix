const MESSAGE_LINK =
  /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(.+)$/i

/**
 * @param {string} raw
 * @returns {string | null} canonical https URL or null
 */
export function parseTelegramMessageUrl(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const m = trimmed.match(MESSAGE_LINK)
  if (!m) return null

  let rest = m[1].replace(/\/+$/, '')
  if (!rest || rest.startsWith('share') || rest.startsWith('socks')) return null

  // Public: channel/123 or channel/123/456
  // Private: c/123456/789
  // Joinchat / addstickers / proxy are not message links
  const first = rest.split('/')[0].toLowerCase()
  if (
    first === 'joinchat' ||
    first === 'addstickers' ||
    first === 'proxy' ||
    first === 'socks' ||
    first === 'iv' ||
    first === 's'
  ) {
    return null
  }

  const parts = rest.split('/')
  if (parts[0] === 'c') {
    if (parts.length < 3) return null
    if (!/^\d+$/.test(parts[1])) return null
    if (!parts.slice(2).some((p) => /^\d+$/.test(p.split('?')[0]))) return null
  } else {
    // Need at least name + numeric message id somewhere after
    const hasMsgId = parts.slice(1).some((p) => /^\d+$/.test(p.split('?')[0]))
    if (!hasMsgId) return null
  }

  const host = trimmed.toLowerCase().includes('telegram.me')
    ? 'telegram.me'
    : trimmed.toLowerCase().includes('telegram.dog')
      ? 'telegram.dog'
      : 't.me'
  return `https://${host}/${rest}`
}

export function firstTelegramUrl(uris) {
  if (!Array.isArray(uris)) return null
  for (const u of uris) {
    const parsed = parseTelegramMessageUrl(u)
    if (parsed) return parsed
  }
  return null
}
