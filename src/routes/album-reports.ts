import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AlbumAppType } from '../lib/albums.ts'
import { AlbumError, albumErrorResponse, albumPagination, readAlbumJson } from '../lib/albums.ts'
import { blockAlbumPhotos, getAlbumReportDetail, listAlbumReports, resolveAlbumReport } from '../lib/album-reports.ts'
import { adminMiddleware } from '../middleware/auth.ts'

const albumReports = new Hono<AlbumAppType>({ strict: false })
albumReports.use('*', bodyLimit({ maxSize: 65536, onError: c => c.json({ error: '请求内容过大', code: 'request_too_large' }, 413) }))
albumReports.onError((error, c) => albumErrorResponse(error, c))
albumReports.use('*', adminMiddleware)

albumReports.get('/', async c => {
  const status = c.req.query('status') ?? 'open'
  if (status !== 'open' && status !== 'resolved' && status !== 'all') throw new AlbumError('invalid_request', '状态筛选不正确', 400)
  return c.json(await listAlbumReports(c.env, { status, ...albumPagination(c.req.query('limit'), c.req.query('offset'), 20, 100) }))
})
albumReports.get('/:id', async c => c.json(await getAlbumReportDetail(c.env, c.req.param('id'))))
albumReports.post('/:id/block', async c => c.json(await blockAlbumPhotos(c.env, c.get('user').sub, c.req.param('id'), await readAlbumJson(c.req.raw))))
albumReports.post('/:id/resolve', async c => {
  const body = await readAlbumJson(c.req.raw)
  if (Object.keys(body).length) throw new AlbumError('invalid_request', '此请求不接受额外字段')
  return c.json(await resolveAlbumReport(c.env, c.get('user').sub, c.req.param('id')))
})

export default albumReports
