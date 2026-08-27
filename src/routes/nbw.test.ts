import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_NBW_FORUM_RECOMMENDATION,
  parseNBWForumRecommendation,
} from './nbw.ts'
import { buildNBWRegisterPrefill, signNBWBindToken, verifyNBWBindToken } from '../lib/nbw-bind-token.ts'

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

test('falls back when required AI response fields are missing or mistyped', () => {
  assert.deepEqual(
    parseNBWForumRecommendation('{"fid":27}'),
    DEFAULT_NBW_FORUM_RECOMMENDATION,
  )
  assert.deepEqual(
    parseNBWForumRecommendation('{"fid":3,"forum_name":"交友","confidence":"high"}'),
    DEFAULT_NBW_FORUM_RECOMMENDATION,
  )
})

test('signs and verifies NBW bind token', async () => {
  const token = await signNBWBindToken({ uid: '4349', username: '宝宝', avatar: 'https://example.com/a.png' }, 'secret')
  assert.deepEqual(await verifyNBWBindToken(token, 'secret'), {
    uid: '4349',
    username: '宝宝',
    avatar: 'https://example.com/a.png',
  })
  assert.equal(await verifyNBWBindToken(token, 'wrong-secret'), null)
})

test('builds safe registration prefill from NBW user info', () => {
  assert.deepEqual(buildNBWRegisterPrefill({
    uid: 4349,
    username: '宝宝',
    email: 'baby@example.com',
    avatar: 'https://example.com/a.png',
  }), {
    uid: '4349',
    username: '宝宝',
    email: 'baby@example.com',
    avatar: 'https://example.com/a.png',
  })
})
