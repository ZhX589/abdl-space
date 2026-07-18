import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_NBW_FORUM_RECOMMENDATION,
  parseNBWForumRecommendation,
} from './nbw.ts'

test('marks a valid AI forum recommendation as successful', () => {
  assert.deepEqual(
    parseNBWForumRecommendation('```json\n{"fid":3,"forum_name":"交友","confidence":0.91}\n```'),
    { fid: 3, forum_name: '交友', confidence: 0.91, fallback: false },
  )
})

test('falls back to sharing for unsupported forum IDs', () => {
  assert.deepEqual(
    parseNBWForumRecommendation('{"fid":99,"forum_name":"其他","confidence":0.8}'),
    DEFAULT_NBW_FORUM_RECOMMENDATION,
  )
})

test('falls back to sharing for invalid AI output', () => {
  assert.deepEqual(
    parseNBWForumRecommendation('无法判断'),
    DEFAULT_NBW_FORUM_RECOMMENDATION,
  )
})
