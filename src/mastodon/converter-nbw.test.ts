import assert from 'node:assert/strict'
import test from 'node:test'

import { nbwThreadDateToISO, toStatusFromNBW, toStatusFromNBWReply } from './converter.ts'

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

test('converts an NBW reply into a Mastodon status without quote', () => {
	const status = toStatusFromNBWReply(2469, {
		pid: 204858,
		author: '日九baby',
		authorid: 4,
		avatar: 'https://example.com/avatar.jpg',
		dateline: '刚刚',
		position: 2,
		support: 0,
		content: '说得很有道理，赞同楼主的观点！',
		attachment_list: [],
	})

	assert.equal(status.id, 'nbw_2469_204858')
	assert.equal(status.in_reply_to_id, 'nbw_2469')
	assert.equal(status.account.id, 'nbw_4')
	assert.equal(status.account.acct, '日九baby@newbabyworld.top')
	assert.match(status.content, /赞同楼主/)
	assert.equal(status.quote, null)
})

test('converts an NBW reply with quote_info and attachments', () => {
	const status = toStatusFromNBWReply(2469, {
		pid: 204859,
		author: '测试用户',
		authorid: 8,
		dateline: '1分钟前',
		position: 3,
		support: 5,
		content: '补充一点细节，如图所示：\n[attach]1026[/attach]',
		quote_info: {
			pid: 204858,
			author: '日九baby',
			dateline: '刚刚',
			message: '说得很有道理，赞同楼主的观点！',
		},
		attachment_list: [
			{
				aid: 1026,
				is_image: 1,
				filename: 'detail.png',
				width: 800,
				extension: 'png',
				url: 'https://www.newbabyworld.top/data/attachment/forum/202309/20/detail.png',
			},
			{
				aid: 1027,
				is_image: 0,
				filename: 'notes.txt',
				extension: 'txt',
				url: 'https://www.newbabyworld.top/data/attachment/forum/202309/20/notes.txt',
			},
		],
	})

	assert.equal(status.id, 'nbw_2469_204859')
	assert.equal(status.in_reply_to_id, 'nbw_2469_204858')
	assert.equal(status.favourites_count, 5)
	assert.equal(status.media_attachments.length, 1)
	assert.equal(status.media_attachments[0].url, 'https://www.newbabyworld.top/data/attachment/forum/202309/20/detail.png')
	// [attach] 标签已从正文剥离
	assert.equal(status.content.includes('[attach'), false)
	assert.match(status.content, /补充一点细节/)
	// quote 卡片映射
	assert.equal(status.quote?.state, 'accepted')
	assert.equal(status.quote?.quoted_status_id, 'nbw_2469_204858')
	assert.equal(status.quote?.quoted_status?.content.includes('赞同楼主'), true)
	assert.equal(status.quote?.quoted_status?.account.display_name, '日九baby')
})

test('strips remaining bbcode tags from NBW reply content', () => {
	const status = toStatusFromNBWReply(100, {
		pid: 7,
		author: 'tester',
		authorid: 1,
		dateline: '2026-07-17 20:00',
		content: '[b]加粗[/b] 与 [color=#ff0000]红字[/color]',
	})
	assert.equal(status.content.includes('[b]'), false)
	assert.equal(status.content.includes('[/b]'), false)
	assert.equal(status.content.includes('[color='), false)
	assert.match(status.content, /加粗/)
	assert.match(status.content, /红字/)
})
