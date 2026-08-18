import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTelegramMessageUrl } from '../bridge/links.js'
import { extractTelegramJobs } from '../bridge/watch.js'

test('extractTelegramJobs picks t.me message uris and skips regular http', () => {
  const jobs = extractTelegramJobs(
    [
      {
        gid: 'aaa',
        dir: '/Users/furina/Downloads',
        files: [
          {
            path: '/Users/furina/Downloads/2094',
            uris: [{ uri: 'https://t.me/sjhxmfd_0/2094' }],
          },
        ],
      },
      {
        gid: 'bbb',
        dir: '/tmp',
        files: [{ uris: [{ uri: 'http://127.0.0.1:18898/3914669213/2094' }] }],
      },
    ],
    parseTelegramMessageUrl
  )
  assert.deepEqual(jobs, [
    {
      gid: 'aaa',
      uri: 'https://t.me/sjhxmfd_0/2094',
      dir: '/Users/furina/Downloads',
      path: '/Users/furina/Downloads/2094',
    },
  ])
})
