import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import type { BabyVerificationAppType } from '../lib/baby-verification.ts'
import { acknowledgeBabyRejection, authorizeBabyEvidence, babyAuthMiddleware, babyVerificationErrorResponse, cancelBabyApplication, completeBabyEvidence, createBabyApplication, createBabyCaptureSession, getBabyApplication, getBabyCertificateMe, getBabyVerificationConfig, getBabyVerificationMe, readBabyJson, submitBabyApplication, transitionBabyCaptureSession, verifyBabyCredential } from '../lib/baby-verification.ts'

const babyVerification = new Hono<BabyVerificationAppType>()
babyVerification.use('*', cors({ origin: origin => ['https://abdl-space.top','https://www.abdl-space.top','https://m.abdl-space.top','https://abdl-space-mobile.pages.dev','http://localhost:5173','http://localhost:5174'].includes(origin) ? origin : '', credentials:true, allowHeaders:['Content-Type','Authorization'], allowMethods:['GET','POST','OPTIONS'] }))
babyVerification.use('*', bodyLimit({maxSize:65536,onError:c=>c.json({error:'请求内容过大',code:'request_too_large'},413)}))
babyVerification.onError((error,c)=>babyVerificationErrorResponse(error,c))

babyVerification.get('/settings',async c=>{c.header('Cache-Control','no-store');return c.json(await getBabyVerificationConfig(c.env))})
babyVerification.get('/verify/:token',async c=>{
	c.header('Cache-Control','no-store, max-age=0')
	c.header('Pragma','no-cache')
	c.header('Referrer-Policy','no-referrer')
	c.header('X-Robots-Tag','noindex, nofollow, noarchive')
	const ip=c.req.header('cf-connecting-ip')??'unknown'
	const {babyHash}=await import('../lib/baby-verification.ts')
	const bucket=await babyHash('verify-rate-limit',ip)
	const limited=await c.env.abdl_space_db.prepare(`INSERT INTO baby_verification_rate_limits(bucket,window_start,count) VALUES(?,unixepoch(),1) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window_start<=unixepoch()-60 THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=unixepoch()-60 THEN unixepoch() ELSE window_start END RETURNING count`).bind(`verify:${bucket}`).first<{count:number}>()
	if(!limited||limited.count>60)return c.json({error:'请求过于频繁',code:'rate_limited'},429)
	return c.json(await verifyBabyCredential(c.env,c.req.param('token')))
})

babyVerification.use('*',babyAuthMiddleware)
babyVerification.get('/me',async c=>c.json(await getBabyVerificationMe(c.env,c.get('user').sub)))
babyVerification.post('/capture-sessions',async c=>c.json(await createBabyCaptureSession(c.env,c.get('user').sub),201))
babyVerification.get('/capture-sessions/:id',async c=>{
	await c.env.abdl_space_db.prepare(`UPDATE baby_verification_capture_sessions SET status='expired',cancelled_at=unixepoch() WHERE id=? AND user_id=? AND status='active' AND expires_at<=unixepoch()`).bind(c.req.param('id'),c.get('user').sub).run()
	const row=await c.env.abdl_space_db.prepare('SELECT id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at,cancelled_at,created_at FROM baby_verification_capture_sessions WHERE id=? AND user_id=?').bind(c.req.param('id'),c.get('user').sub).first()
	return row?c.json(row):c.json({error:'认证拍摄会话不存在',code:'capture_session_not_found'},404)
})
babyVerification.post('/capture-sessions/:id/complete',async c=>c.json(await transitionBabyCaptureSession(c.env,c.get('user').sub,c.req.param('id'),'complete')))
babyVerification.post('/capture-sessions/:id/cancel',async c=>c.json(await transitionBabyCaptureSession(c.env,c.get('user').sub,c.req.param('id'),'cancel')))
babyVerification.post('/applications',async c=>c.json(await createBabyApplication(c.env,c.get('user').sub,await readBabyJson(c.req.raw)),201))
babyVerification.get('/applications/:id',async c=>{
	const row=await getBabyApplication(c.env,c.req.param('id'),c.get('user').sub)
	if(!row)return c.json({error:'申请不存在',code:'application_not_found'},404)
	const {decryptBabyQq}=await import('../lib/baby-verification.ts')
	const evidence=await c.env.abdl_space_db.prepare('SELECT id,kind,mime_type,declared_size,verified_size,status,completed_at FROM baby_verification_evidence WHERE application_id=? AND user_id=? ORDER BY kind').bind(row.id,c.get('user').sub).all()
	return c.json({...row,qq:await decryptBabyQq(c.env,row.qq,row.id),adult_declaration:!!row.adult_declaration,evidence:evidence.results})
})
babyVerification.post('/applications/:id/cancel',async c=>c.json(await cancelBabyApplication(c.env,c.get('user').sub,c.req.param('id'))))
babyVerification.post('/applications/:id/evidence/authorize',async c=>c.json(await authorizeBabyEvidence(c.env,c.get('user').sub,c.req.param('id'),await readBabyJson(c.req.raw))))
babyVerification.post('/evidence/:id/complete',async c=>c.json(await completeBabyEvidence(c.env,c.get('user').sub,c.req.param('id'))))
babyVerification.post('/applications/:id/submit',async c=>c.json(await submitBabyApplication(c.env,c.get('user').sub,c.req.param('id'))))
babyVerification.post('/applications/:id/rejection-acknowledge',async c=>c.json(await acknowledgeBabyRejection(c.env,c.get('user').sub,c.req.param('id'))))
babyVerification.get('/certificates/me',async c=>c.json({certificate:await getBabyCertificateMe(c.env,c.get('user').sub)}))

export default babyVerification
