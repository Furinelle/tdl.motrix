import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTelegramMessageUrl, firstTelegramUrl } from '../bridge/links.js'

test('accepts public and private message links', () => {
  assert.equal(
    parseTelegramMessageUrl('https://t.me/telegram/193'),
    'https://t.me/telegram/193'
  )
  assert.equal(
    parseTelegramMessageUrl('https://t.me/c/1697797156/151'),
    'https://t.me/c/1697797156/151'
  )
  assert.equal(
    parseTelegramMessageUrl('https://t.me/iFreeKnow/45662/55005'),
    'https://t.me/iFreeKnow/45662/55005'
  )
  assert.equal(
    parseTelegramMessageUrl('https://telegram.me/tdl/1'),
    'https://telegram.me/tdl/1'
  )
})

test('rejects non-message telegram urls and other hosts', () => {
  assert.equal(parseTelegramMessageUrl('https://t.me/telegram'), null)
  assert.equal(parseTelegramMessageUrl('https://t.me/c/1697797156'), null)
  assert.equal(parseTelegramMessageUrl('https://t.me/joinchat/AAAA'), null)
  assert.equal(parseTelegramMessageUrl('https://example.com/file.zip'), null)
  assert.equal(parseTelegramMessageUrl(''), null)
})

test('firstTelegramUrl picks the first message link', () => {
  assert.equal(
    firstTelegramUrl(['https://example.com/a.zip', 'https://t.me/tdl/2']),
    'https://t.me/tdl/2'
  )
  assert.equal(firstTelegramUrl(['https://example.com/a.zip']), null)
})
