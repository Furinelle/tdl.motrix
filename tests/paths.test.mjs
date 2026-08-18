import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tdlSaveDirFromDefault } from '../bridge/paths.js'

test('tdlSaveDirFromDefault puts files under Motrix/tg', () => {
  assert.equal(tdlSaveDirFromDefault('/Users/furina/Downloads/Motrix'), '/Users/furina/Downloads/Motrix/tg')
  assert.equal(tdlSaveDirFromDefault('/Users/furina/Downloads/Motrix/'), '/Users/furina/Downloads/Motrix/tg')
})
