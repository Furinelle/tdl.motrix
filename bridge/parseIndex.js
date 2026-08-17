/**
 * Parse tdl serve index HTML. Links are "{peerId}/{messageId}".
 * @param {string} html
 * @param {number} port
 * @returns {{ path: string, url: string }[]}
 */
export function parseServeIndex(html, port) {
  if (typeof html !== 'string' || !Number.isInteger(port)) return []
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1])
  const files = []
  const seen = new Set()
  for (const href of hrefs) {
    const path = href.replace(/^\//, '')
    if (!/^-?\d+\/\d+$/.test(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    files.push({
      path,
      url: `http://127.0.0.1:${port}/${path}`,
    })
  }
  return files
}

/**
 * @param {string | null | undefined} header
 * @returns {string | null}
 */
export function filenameFromContentDisposition(header) {
  if (!header) return null
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf) {
    try {
      return decodeURIComponent(utf[1].trim())
    } catch {
      return utf[1].trim()
    }
  }
  const plain = header.match(/filename="([^"]+)"/i) || header.match(/filename=([^;]+)/i)
  if (!plain) return null
  return plain[1].trim()
}
