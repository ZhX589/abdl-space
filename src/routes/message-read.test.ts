import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveReadUpToId } from './message-read.ts'

test('uses the latest received message when a legacy read request has no body', () => {
  assert.equal(resolveReadUpToId(undefined, 42), 42)
})

test('preserves an explicit read watermark', () => {
  assert.equal(resolveReadUpToId(17, 42), 17)
})

test('does nothing when a legacy read request has no received messages', () => {
  assert.equal(resolveReadUpToId(undefined, null), null)
})
