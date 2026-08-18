import http from 'node:http'
import { BRIDGE_PORT, TdlRunner } from './tdl.js'
import { parseTelegramMessageUrl } from './links.js'
import { startAria2Watch } from './watch.js'

const runner = new TdlRunner()

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/status') {
    send(res, 200, runner.status())
    return
  }
  if (req.method === 'POST' && url.pathname === '/resolve') {
    let body
    try {
      body = await readJson(req)
    } catch {
      send(res, 400, { ok: false, code: 'bad_json', message: '无效请求' })
      return
    }
    const telegramUrl = parseTelegramMessageUrl(String(body.url || ''))
    if (!telegramUrl) {
      send(res, 400, {
        ok: false,
        code: 'bad_url',
        message: '不是 Telegram 消息链接',
      })
      return
    }
    console.log(
      JSON.stringify({
        msg: 'resolve',
        url: telegramUrl,
        saveDir: typeof body.saveDir === 'string' ? body.saveDir : undefined,
      })
    )
    const result = await runner.resolve({
      url: telegramUrl,
      saveDir: typeof body.saveDir === 'string' ? body.saveDir : undefined,
      group: body.group !== false,
    })
    console.log(
      JSON.stringify({
        msg: 'resolve_done',
        ok: result.ok,
        code: result.code,
        files: result.files?.length ?? 0,
      })
    )
    send(res, result.ok ? 200 : 422, result)
    return
  }
  send(res, 404, { ok: false, code: 'not_found', message: 'not found' })
})

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(
    JSON.stringify({ msg: 'listen', host: '127.0.0.1', port: BRIDGE_PORT })
  )
  startAria2Watch(runner)
})
