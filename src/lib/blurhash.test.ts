import assert from 'node:assert/strict'
import test from 'node:test'

import { isBlurhashValid } from 'blurhash'
import { generateBlurhash } from './blurhash.ts'

const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

test('generates a valid blurhash for a static image', async()=>{
	const result=await generateBlurhash(new Blob([png], {type: 'image/png'}))
	assert.equal(typeof result, 'string')
	assert.equal(isBlurhashValid(result!).result, true)
})

test('returns null for non-image input', async()=>{
	assert.equal(await generateBlurhash(new Blob(['video'], {type: 'video/mp4'})), null)
})

test('returns null when image decoding fails', async()=>{
	assert.equal(await generateBlurhash(new Blob(['invalid'], {type: 'image/jpeg'})), null)
})
