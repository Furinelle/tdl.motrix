// src/index.ts
import { hooks, http, log } from "motrix:plugin-api";
var BRIDGE = "http://127.0.0.1:16808";
var MESSAGE_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([^?#]*)(?:[?#].*)?$/i;
function isTelegramMessageUrl(raw) {
  const match = MESSAGE_LINK.exec(raw.trim());
  if (!match) return false;
  const parts = match[1].replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] === "c") {
    return parts.length >= 3 && parts.slice(2).some((p) => /^\d+$/.test(p));
  }
  const blocked = /* @__PURE__ */ new Set(["joinchat", "addstickers", "proxy", "socks", "iv", "s"]);
  if (blocked.has(parts[0].toLowerCase())) return false;
  return parts.slice(1).some((p) => /^\d+$/.test(p));
}
function firstTelegramUri(uris) {
  for (const uri of uris) {
    if (isTelegramMessageUrl(uri)) return uri.trim();
  }
  return null;
}
hooks.beforeCreate(async (ctx) => {
  const telegramUrl = firstTelegramUri(ctx.uris);
  if (!telegramUrl) return ctx;
  let saveDir = ctx.saveDir;
  try {
    const status = await http.request({
      method: "GET",
      url: `${BRIDGE}/status`,
      responseType: "json",
      timeoutMs: 2e3
    });
    if (status.status >= 400) {
      throw new Error("tdl-bridge \u672A\u8FD0\u884C\uFF0C\u8BF7\u5148\u542F\u52A8\u672C\u673A\u670D\u52A1");
    }
    const body = status.body;
    if (body.tdl === false) {
      throw new Error("\u672A\u627E\u5230 tdl\uFF0C\u8BF7\u5148 brew install tdl");
    }
    if (body.loggedIn === false) {
      throw new Error("tdl \u672A\u767B\u5F55\uFF0C\u8BF7\u5728\u7EC8\u7AEF\u6267\u884C tdl login \u540E\u91CD\u8BD5");
    }
    if (body.saveDir) saveDir = body.saveDir;
  } catch (e) {
    if (e instanceof Error && /tdl|bridge|未找到|未登录/.test(e.message)) throw e;
    throw new Error("tdl-bridge \u672A\u8FD0\u884C\uFF0C\u8BF7\u5148\u542F\u52A8\u672C\u673A\u670D\u52A1");
  }
  const resolved = await http.request({
    method: "POST",
    url: `${BRIDGE}/resolve`,
    responseType: "json",
    timeoutMs: 45e3,
    body: {
      type: "json",
      data: {
        url: telegramUrl,
        saveDir,
        group: true
      }
    }
  });
  const payload = resolved.body;
  if (!payload?.ok || !payload.files?.length) {
    throw new Error(payload?.message || "\u8FD9\u6761 Telegram \u6D88\u606F\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u6587\u4EF6");
  }
  const first = payload.files[0];
  log.info("tdl resolved", { files: payload.files.length, filename: first.filename });
  await ctx.update({
    uris: [first.url]
  });
  return ctx;
});
