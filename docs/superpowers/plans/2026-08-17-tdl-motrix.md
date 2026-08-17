# tdl × Motrix Implementation Plan

> **For agentic workers:** Execute inline in this repo. Spec: `docs/superpowers/specs/2026-08-17-tdl-motrix-design.md`.

**Goal:** Paste a Telegram message link in Motrix; tdl-bridge serves it over localhost HTTP; Motrix downloads it as a normal task.

**Architecture:** `tdl-bridge` is a loopback Node HTTP server that execs `tdl dl --serve`. The Motrix plugin `furina.tdl` rewrites matching `t.me` URLs to those HTTP files. Extra album files are added with `motrix add`.

**Tech Stack:** Node 22, no extra deps for the bridge. Plugin via official Motrix plugin scaffold (`motrix:plugin-api`, esbuild). launchd on macOS.

## Global Constraints

- Bridge binds `127.0.0.1:16808` only.
- Reuse `~/.tdl` namespace `default`. Never collect Telegram credentials.
- Plugin id `furina.tdl`. Category `site-resolver`. Hook role `resolve`.
- Plugin HTTP only to `http://127.0.0.1:16808/*`.
- On resolve failure the plugin must not `ctx.update` (do not leave a `t.me` download). Throw with the spec copy.
- tdl serve index links are `{peerId}/{messageId}`; real name comes from `Content-Disposition`.
- tdl serve itself listens on `0.0.0.0:<ephemeral>` (tdl limitation). Bridge still loopback-only.
- First version: message links only, `--group` on, saveDir from Motrix.

## Files

- `bridge/links.js` — detect Telegram message URLs; canonicalize
- `bridge/parseIndex.js` — parse tdl serve HTML into file paths
- `bridge/tdl.js` — spawn tdl, login probe, serve lifecycle
- `bridge/server.js` — `GET /status`, `POST /resolve`
- `bridge/launchd/app.furina.tdl-bridge.plist`
- `scripts/install-macos.sh`
- `plugin/motrix-plugin.json`, `plugin/src/index.ts`, locales, esbuild, package.json
- `tests/links.test.mjs`, `tests/parseIndex.test.mjs`
- `README.md`

### Task 1: URL + HTML helpers with tests

- [ ] `tests/links.test.mjs` and `tests/parseIndex.test.mjs`
- [ ] `bridge/links.js`, `bridge/parseIndex.js`
- [ ] `node --test tests/*.test.mjs` green
- [ ] Commit

### Task 2: tdl-bridge server

- [ ] `bridge/tdl.js` + `bridge/server.js`
- [ ] Status: tdl binary present; session dir `~/.tdl/data/default` or `~/.tdl/data.kv` as loggedIn hint; resolve maps tdl stderr to spec errors
- [ ] Resolve: allocate port 18000–18999, `tdl dl --serve --port N -u URL --group`, poll `http://127.0.0.1:N/` ≤ 45s, parse links, HEAD for filename
- [ ] Reuse in-flight serve by canonical URL; kill after 6h
- [ ] Extra files: `motrix add <url> --save-dir <saveDir>`
- [ ] Commit

### Task 3: launchd + README install

- [ ] plist + `scripts/install-macos.sh`
- [ ] `curl 127.0.0.1:16808/status` works
- [ ] Commit

### Task 4: Motrix plugin

- [ ] Scaffold `plugin/` as `furina.tdl`
- [ ] `beforeCreate`: skip non-telegram; GET status (2s); POST resolve (45s); `ctx.update` first file; throw spec messages otherwise
- [ ] `pnpm run pack` produces `.moext`
- [ ] Commit

### Task 5: Install plugin locally and smoke `/status`

- [ ] Load launchd, copy/install `.moext` instructions in README
- [ ] Do not run a live Telegram download in CI; leave manual checklist in README
