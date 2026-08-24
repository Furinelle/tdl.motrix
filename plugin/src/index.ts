import { hooks, http, log } from 'motrix:plugin-api'

const BRIDGE = 'http://127.0.0.1:16808'
const MESSAGE_LINK =
  /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([^?#]*)(?:[?#].*)?$/i

function isTelegramMessageUrl(raw: string): boolean {
  const match = MESSAGE_LINK.exec(raw.trim())
  if (!match) return false
  const parts = match[1].replace(/^\/+|\/+$/g, '').split('/')
  if (parts[0] === 'c') {
    return parts.length >= 3 && parts.slice(2).some((p) => /^\d+$/.test(p))
  }
  const blocked = new Set(['joinchat', 'addstickers', 'proxy', 'socks', 'iv', 's'])
  if (blocked.has(parts[0].toLowerCase())) return false
  return parts.slice(1).some((p) => /^\d+$/.test(p))
}

function firstTelegramUri(uris: readonly string[]): string | null {
  for (const uri of uris) {
    if (isTelegramMessageUrl(uri)) return uri.trim()
  }
  return null
}

hooks.beforeCreate(async (ctx) => {
  const telegramUrl = firstTelegramUri(ctx.uris)
  if (!telegramUrl) return ctx

  let saveDir = ctx.saveDir
  try {
    const status = await http.request({
      method: 'GET',
      url: `${BRIDGE}/status`,
      responseType: 'json',
      timeoutMs: 2000,
    })
    if (status.status >= 400) {
      throw new Error('tdl-bridge 未运行，请先启动本机服务')
    }
    const body = status.body as { tdl?: boolean; loggedIn?: boolean; saveDir?: string }
    if (body.tdl === false) {
      throw new Error('未找到 tdl，请先 brew install tdl')
    }
    if (body.loggedIn === false) {
      throw new Error('tdl 未登录，请在终端执行 tdl login 后重试')
    }
    if (body.saveDir) saveDir = body.saveDir
  } catch (e) {
    if (e instanceof Error && /tdl|bridge|未找到|未登录/.test(e.message)) throw e
    throw new Error('tdl-bridge 未运行，请先启动本机服务')
  }

  const resolved = await http.request({
    method: 'POST',
    url: `${BRIDGE}/resolve`,
    responseType: 'json',
    timeoutMs: 45_000,
    body: {
      type: 'json',
      data: {
        url: telegramUrl,
        saveDir,
        group: true,
      },
    },
  })

  const payload = resolved.body as {
    ok?: boolean
    message?: string
    files?: Array<{ url: string; filename: string }>
  }

  if (!payload?.ok || !payload.files?.length) {
    throw new Error(payload?.message || '这条 Telegram 消息没有可下载的文件')
  }

  const first = payload.files[0]
  log.info('tdl resolved', { files: payload.files.length, filename: first.filename })
  // Motrix beta25 ignores beforeCreate filename; the bridge watcher reapplies it via aria2.
  await ctx.update({
    uris: [first.url],
  })
  return ctx
})
