import assert from 'node:assert/strict'
import test from 'node:test'

import { toStatusFromNBW } from './converter.ts'

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
