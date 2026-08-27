import assert from 'node:assert/strict'
import test from 'node:test'

import { nbwThreadDateToISO, toStatusFromNBW } from './converter.ts'

test('converts an NBW thread into a Mastodon status', () => {
	const status = toStatusFromNBW({
		tid: 2469,
		fid: 27,
		forum_name: '分享区',
		subject: '测试标题',
		abstract: '测试摘要',
		author: '测试用户',
		authorid: 4349,
		avatar: 'https://example.com/avatar.jpg',
		dateline: 1_700_000_000,
		replies: 3,
		image_list: ['https://example.com/image.jpg'],
	})

	assert.equal(status.id, 'nbw_2469')
	assert.equal(status.account.id, 'nbw_4349')
	assert.equal(status.account.acct, '测试用户@newbabyworld.top')
	assert.equal(status.created_at, '2023-11-14T22:13:20.000Z')
	assert.equal(status.replies_count, 3)
	assert.match(status.content, /测试标题/)
	assert.equal(status.media_attachments[0].url, 'https://example.com/image.jpg')
	assert.equal(status.url, 'https://www.newbabyworld.top/forum.php?mod=viewthread&tid=2469')
})

test('converts NBW relative thread dates', () => {
	const now = Date.parse('2026-07-17T12:00:00.000Z')
	assert.equal(nbwThreadDateToISO('刚刚', now), '2026-07-17T12:00:00.000Z')
	assert.equal(nbwThreadDateToISO('3小时前', now), '2026-07-17T09:00:00.000Z')
	assert.equal(nbwThreadDateToISO('15分钟前', now), '2026-07-17T11:45:00.000Z')
	assert.equal(nbwThreadDateToISO('2026-07-17 20:00:00', now), '2026-07-17T12:00:00.000Z')
})

test('keeps a complete NBW HTTPS URL as one valid anchor', () => {
	const url = 'https://www.newbabyworld.top/forum/thread-123#latest'
	const status = toStatusFromNBW({
		tid: 123,
		subject: url,
		author: 'tester',
		authorid: 42,
		dateline: 1_700_000_000,
	})

	assert.equal(
		status.content,
		`<p><a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a></p>`,
	)
	assert.equal(status.content.match(/<a\b/g)?.length, 1)
	assert.equal(status.content.includes('<a href="https://www.<a'), false)
})
