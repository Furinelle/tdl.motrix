/**
 * @param {string} url
 * @returns {{ origin: string, chatPath: string, chatFlag: string, messageId: number } | null}
 */
export function parseMessageRef(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts[0] === 'c') {
    if (parts.length < 3) return null
    const messageId = Number(parts[parts.length - 1].split('?')[0])
    if (!Number.isInteger(messageId)) return null
    return {
      origin: `${parsed.protocol}//${parsed.host}`,
      chatPath: `c/${parts[1]}`,
      chatFlag: parts[1],
      messageId,
    }
  }
  const messageId = Number(parts[parts.length - 1].split('?')[0])
  if (!parts[0] || !Number.isInteger(messageId)) return null
  return {
    origin: `${parsed.protocol}//${parsed.host}`,
    chatPath: parts[0],
    chatFlag: parts[0],
    messageId,
  }
}

function groupedIdOf(msg) {
  const raw = msg?.raw && typeof msg.raw === 'object' ? msg.raw : msg
  const id = raw?.grouped_id ?? raw?.groupedID ?? raw?.GroupedID
  if (id === undefined || id === null || id === 0 || id === '0') return null
  return String(id)
}

/**
 * @param {string} json
 * @param {{ origin: string, chatPath: string, messageId: number }} ref
 * @returns {string[]}
 */
export function groupedUrlsFromExport(json, ref) {
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const messages = Array.isArray(data?.messages) ? data.messages : []
  const target = messages.find((m) => Number(m?.id) === ref.messageId)
  const group = groupedIdOf(target)
  if (!group) return []
  const ids = []
  const seen = new Set()
  for (const msg of messages) {
    if (groupedIdOf(msg) !== group) continue
    const id = Number(msg.id)
    if (!Number.isInteger(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  ids.sort((a, b) => a - b)
  return ids.map((id) => `${ref.origin}/${ref.chatPath}/${id}`)
}
