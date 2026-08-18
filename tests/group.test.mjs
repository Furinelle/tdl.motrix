import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupedUrlsFromExport } from '../bridge/group.js'

const exportJson = JSON.stringify({
  id: -1003914669213,
  messages: [
    { id: 2093, type: 'message', file: 'prev.jpg', raw: { id: 2093 } },
    {
      id: 2094,
      type: 'message',
      file: 'a.jpg',
      raw: { id: 2094, grouped_id: 99 },
    },
    {
      id: 2095,
      type: 'message',
      file: 'b.jpg',
      raw: { id: 2095, groupedID: 99 },
    },
    {
      id: 2103,
      type: 'message',
      file: 'clip.mp4',
      raw: { id: 2103, GroupedID: 99 },
    },
    { id: 2104, type: 'message', file: 'other.jpg', raw: { id: 2104, grouped_id: 7 } },
  ],
})

test('groupedUrlsFromExport collects same-album ids around the requested message', () => {
  assert.deepEqual(
    groupedUrlsFromExport(exportJson, {
      origin: 'https://t.me',
      chatPath: 'sjhxmfd_0',
      messageId: 2094,
    }),
    [
      'https://t.me/sjhxmfd_0/2094',
      'https://t.me/sjhxmfd_0/2095',
      'https://t.me/sjhxmfd_0/2103',
    ]
  )
})

test('groupedUrlsFromExport returns empty when message is not grouped', () => {
  assert.deepEqual(
    groupedUrlsFromExport(exportJson, {
      origin: 'https://t.me',
      chatPath: 'sjhxmfd_0',
      messageId: 2093,
    }),
    []
  )
})
