import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseServeIndex,
  filenameFromContentDisposition,
} from '../bridge/parseIndex.js'

const html = `<html><body><ul>
  <li><a href="123/45">123/45</a></li>
  <li><a href="/678/90">/678/90</a></li>
  <li><a href="not-a-file">x</a></li>
</ul></body></html>`

test('parseServeIndex extracts peer/message links', () => {
  const files = parseServeIndex(html, 18123)
  assert.deepEqual(files, [
    { path: '123/45', url: 'http://127.0.0.1:18123/123/45' },
    { path: '678/90', url: 'http://127.0.0.1:18123/678/90' },
  ])
})

test('filenameFromContentDisposition reads quoted and rfc5987 names', () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="vacation.mp4"'),
    'vacation.mp4'
  )
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''%E6%B5%8B.mp4"),
    '测.mp4'
  )
  assert.equal(filenameFromContentDisposition(null), null)
})
