import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import type { AlbumAppType } from '../lib/albums.ts'
import { AlbumError, albumAuthMiddleware, albumDto, albumErrorResponse, albumPagination, authorizeAlbumBatch, authorizeAlbumPhoto, cancelAlbumBatch, completeAlbumUpload, createAlbum, createAlbumComment, createAlbumInvite, deleteAlbum, deleteAlbumComment, deleteAlbumPhoto, expireAlbumBatches, getAccessibleAlbum, getAlbumBatch, getAlbumPhoto, getAlbumStorageQuota, invalidateAlbumFeed, joinAlbum, likeAlbumPhoto, listAlbumComments, listAlbumMembers, listAlbumPhotos, listAlbums, patchAlbum, publishAlbumBatch, readAlbumJson, removeAlbumMember } from '../lib/albums.ts'
import { createAlbumReport } from '../lib/album-reports.ts'
import { bestEffortImportAlbumHistory, importAlbumHistoryHandler } from '../lib/album-history.ts'

const albums = new Hono<AlbumAppType>({ strict: false })
albums.use('*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer'); await next() })
albums.use('*', cors({ origin: origin => ['https://abdl-space.top', 'https://www.abdl-space.top', 'https://m.abdl-space.top', 'https://abdl-space-mobile.pages.dev', 'http://localhost:5173', 'http://localhost:5174'].includes(origin) ? origin : '', credentials: true, allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }))
albums.use('*', bodyLimit({ maxSize: 65536, onError: c => c.json({ error: '请求内容过大', code: 'request_too_large' }, 413) }))
albums.onError((error, c) => albumErrorResponse(error, c))
albums.use('*', albumAuthMiddleware)

function numericId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AlbumError('invalid_request', '用户编号不正确')
  return Number(value)
}
async function emptyBody(c: Parameters<typeof readAlbumJson>[0]): Promise<void> {
  if (Object.keys(await readAlbumJson(c)).length) throw new AlbumError('invalid_request', '此请求不接受额外字段')
}
function importDefault(c: import('hono').Context<AlbumAppType>): void {
  // Construct the task only when waitUntil exists (unit-test app.request has no Worker ctx).
  try { c.executionCtx.waitUntil(bestEffortImportAlbumHistory(c.env, c.get('user').sub, { limit: 3 })) }
  catch { /* Explicit import remains available outside Workers runtime. */ }
}

async function listRoot(c: import('hono').Context<AlbumAppType>): Promise<Response> {
  const userId = c.get('user').sub
  const ownerId = c.req.query('owner_id') === undefined ? userId : numericId(c.req.query('owner_id')!)
  if (ownerId === userId) await expireAlbumBatches(c.env, userId)
  const result = await listAlbums(c.env, userId, ownerId, albumPagination(c.req.query('limit'), c.req.query('offset'), 30, 100))
  if (ownerId === userId) importDefault(c)
  return c.json(result)
}
// The parent Hono router is strict and collapses a mounted '/' route to no slash.
// Accept the literal contract '/api/v1/albums/' without redirecting/consuming a POST body.
albums.use('*', async (c, next) => {
  if (c.req.path === '/api/v1/albums/' && c.req.method === 'GET') return listRoot(c)
  if (c.req.path === '/api/v1/albums/' && c.req.method === 'POST') return c.json({ album: await createAlbum(c.env, c.get('user').sub, await readAlbumJson(c.req.raw)) }, 201)
  await next()
})
albums.get('/', listRoot)
albums.get('/quota', async c => { await expireAlbumBatches(c.env, c.get('user').sub); return c.json(await getAlbumStorageQuota(c.env, c.get('user').sub)) })
albums.post('/', async c => c.json({ album: await createAlbum(c.env, c.get('user').sub, await readAlbumJson(c.req.raw)) }, 201))
albums.post('/import-history', importAlbumHistoryHandler)
albums.post('/join', async c => c.json({ album: await joinAlbum(c.env, c.get('user').sub, await readAlbumJson(c.req.raw)) }))
albums.post('/uploads/:uploadId/complete', async c => { await emptyBody(c.req.raw); return c.json(await completeAlbumUpload(c.env, c.get('user').sub, c.req.param('uploadId'))) })
albums.get('/batches/:batchId', async c => c.json(await getAlbumBatch(c.env, c.get('user').sub, c.req.param('batchId'))))
albums.post('/batches/:batchId/cancel', async c => { await emptyBody(c.req.raw); return c.json(await cancelAlbumBatch(c.env, c.get('user').sub, c.req.param('batchId'))) })
albums.post('/batches/:batchId/publish', async c => {
  await emptyBody(c.req.raw)
  const result = await publishAlbumBatch(c.env, c.get('user').sub, c.req.param('batchId'))
  await invalidateAlbumFeed(c.env, result.post_id)
  return c.json(result)
})
albums.get('/photos/:photoId', async c => c.json({ photo: await getAlbumPhoto(c.env, c.get('user').sub, c.req.param('photoId')) }))
albums.post('/photos/:photoId/authorize', async c => c.json(await authorizeAlbumPhoto(c.env, c.get('user').sub, c.req.param('photoId'), await readAlbumJson(c.req.raw))))
albums.post('/photos/:photoId/like', async c => c.json(await likeAlbumPhoto(c.env, c.get('user').sub, c.req.param('photoId'), await readAlbumJson(c.req.raw))))
albums.get('/photos/:photoId/comments', async c => c.json(await listAlbumComments(c.env, c.get('user').sub, c.req.param('photoId'), albumPagination(c.req.query('limit'), c.req.query('offset'), 30, 100))))
albums.post('/photos/:photoId/comments', async c => c.json({ comment: await createAlbumComment(c.env, c.get('user').sub, c.req.param('photoId'), await readAlbumJson(c.req.raw)) }, 201))
albums.delete('/photos/:photoId', async c => { await emptyBody(c.req.raw); return c.json(await deleteAlbumPhoto(c.env, c.get('user').sub, c.req.param('photoId'))) })
albums.delete('/comments/:commentId', async c => { await emptyBody(c.req.raw); return c.json(await deleteAlbumComment(c.env, c.get('user').sub, c.req.param('commentId'))) })
albums.get('/:id/photos', async c => {
  const album = await getAccessibleAlbum(c.env, c.get('user').sub, c.req.param('id'))
  const result = await listAlbumPhotos(c.env, c.get('user').sub, album.id, albumPagination(c.req.query('limit'), c.req.query('offset'), 60, 100))
  if (album.is_default && album.owner_id === c.get('user').sub) importDefault(c)
  return c.json(result)
})
albums.post('/:id/batches/authorize', async c => c.json(await authorizeAlbumBatch(c.env, c.get('user').sub, c.req.param('id'), await readAlbumJson(c.req.raw))))
albums.post('/:id/invites', async c => { await emptyBody(c.req.raw); return c.json(await createAlbumInvite(c.env, c.get('user').sub, c.req.param('id'))) })
albums.post('/:id/report', async c => c.json({ report: await createAlbumReport(c.env, c.get('user').sub, c.req.param('id'), await readAlbumJson(c.req.raw)) }, 201))
albums.get('/:id/members', async c => c.json(await listAlbumMembers(c.env, c.get('user').sub, c.req.param('id'))))
albums.delete('/:id/members/:userId', async c => { await emptyBody(c.req.raw); return c.json(await removeAlbumMember(c.env, c.get('user').sub, c.req.param('id'), numericId(c.req.param('userId')))) })
albums.patch('/:id', async c => c.json({ album: await patchAlbum(c.env, c.get('user').sub, c.req.param('id'), await readAlbumJson(c.req.raw)) }))
albums.delete('/:id', async c => { await emptyBody(c.req.raw); return c.json(await deleteAlbum(c.env, c.get('user').sub, c.req.param('id'))) })
albums.get('/:id', async c => {
  const album = await getAccessibleAlbum(c.env, c.get('user').sub, c.req.param('id'))
  const result = await albumDto(c.env, c.get('user').sub, album)
  if (album.is_default && album.owner_id === c.get('user').sub) importDefault(c)
  return c.json({ album: result })
})

export default albums
