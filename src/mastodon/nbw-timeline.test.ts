import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNBWTimelineParams, buildNBWTimelineNextLink, hasNextAllTimelinePage } from './nbw-timeline.ts'

test('maps Mastodon timeline query parameters to get_sync_threads parameters', () => {
  assert.deepEqual(buildNBWTimelineParams({
    limit: '80',
    max_id: '1700000000_42',
    fid: '27',
    orderby: 'lastpost',
  }), {
    limit: 40,
    fid: '27',
    orderby: 'lastpost',
    cursor: '1700000000_42',
    params: {
      perpage: '40',
      orderby: 'lastpost',
      fid: '27',
      cursor: '1700000000_42',
    },
  })
})

test('uses safe defaults and ignores fid zero', () => {
  assert.deepEqual(buildNBWTimelineParams({ cursor: 'next' }), {
    limit: 20,
    fid: '',
    orderby: 'dateline',
    cursor: 'next',
    params: { perpage: '20', orderby: 'dateline', cursor: 'next' },
  })
})

test('keeps the legacy perpage parameter compatible', () => {
  assert.equal(buildNBWTimelineParams({ perpage: '30' }).limit, 30)
  assert.equal(buildNBWTimelineParams({ limit: '10', perpage: '30' }).limit, 10)
})

test('builds a Mastodon next link from the NBW cursor', () => {
  assert.equal(
    buildNBWTimelineNextLink('/api/v1/timelines/nbw', 'next_cursor', 20, '27', 'lastpost'),
    '</api/v1/timelines/nbw?limit=20&max_id=next_cursor&fid=27&orderby=lastpost>; rel="next"',
  )
  assert.equal(buildNBWTimelineNextLink('/api/v1/timelines/nbw', '', 20, '', 'dateline'), null)
})

test('stops merged timeline pagination when NBW cursor cannot advance', () => {
  assert.equal(hasNextAllTimelinePage(0, 20, '', true, ''), false)
  assert.equal(hasNextAllTimelinePage(0, 20, 'cursor_1', true, 'cursor_1'), false)
  assert.equal(hasNextAllTimelinePage(0, 20, 'cursor_1', true, 'cursor_2'), true)
  assert.equal(hasNextAllTimelinePage(20, 20, 'cursor_1', false, ''), true)
})
