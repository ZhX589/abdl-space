import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeAllTimelinePage } from './all-timeline.ts'

test('advances only sources actually returned by the merged timeline page', () => {
  const result = mergeAllTimelinePage(
    [
      { id: 'p_10', created_at: '2026-01-04T00:00:00.000Z' },
      { id: 'p_9', created_at: '2026-01-03T00:00:00.000Z' },
    ],
    [
      { id: 'nbw_8', created_at: '2026-01-02T00:00:00.000Z' },
      { id: 'nbw_7', created_at: '2026-01-01T00:00:00.000Z' },
    ],
    2,
    undefined,
    '',
    false,
    '',
  )

  assert.deepEqual(result.statuses.map((status) => status.id), ['p_10', 'p_9'])
  assert.equal(result.nextAbdlMaxId, 9)
  assert.equal(result.nextNBWCursor, '')
  assert.equal(result.hasMore, true)
})

test('marks NBW exhausted when ABDL still has another page', () => {
  const result = mergeAllTimelinePage(
    [{ id: 'p_6', created_at: '2026-01-01T00:00:00.000Z' }],
    [{ id: 'nbw_8', created_at: '2026-01-02T00:00:00.000Z' }],
    1,
    7,
    'cursor_1',
    true,
    'cursor_1',
  )

  assert.deepEqual(result.statuses.map((status) => status.id), ['nbw_8'])
  assert.equal(result.nextNBWCursor, '!')
  assert.equal(result.hasMore, true)
})
