import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { BabyVerificationAppType } from '../lib/baby-verification.ts'
import { authorizeAdminBabyEvidence, babyAdminMiddleware, babyText, babyVerificationErrorResponse, claimBabyApplication, decideBabyApplication, decryptBabyQq, getBabyApplication, getBabyVerificationConfig, mutateBabyCertificate, readBabyJson, releaseBabyApplication, updateBabyVerificationConfig } from '../lib/baby-verification.ts'

const adminBabyVerification=new Hono<BabyVerificationAppType>()
adminBabyVerification.use('*',bodyLimit({maxSize:65536,onError:c=>c.json({error:'请求内容过大',code:'request_too_large'},413)}))
adminBabyVerification.onError((error,c)=>babyVerificationErrorResponse(error,c))
adminBabyVerification.use('*',babyAdminMiddleware)

adminBabyVerification.get('/config',async c=>c.json(await getBabyVerificationConfig(c.env)))
adminBabyVerification.put('/config',async c=>c.json(await updateBabyVerificationConfig(c.env,c.get('user').sub,await readBabyJson(c.req.raw))))
adminBabyVerification.get('/applications',async c=>{
	const status=c.req.query('status')??'submitted,reviewing'
	const statuses=status.split(',').filter(Boolean)
	if(!statuses.length||statuses.length>6||statuses.some(item=>!['draft','submitted','reviewing','approved','rejected','cancelled'].includes(item)))return c.json({error:'状态筛选不正确',code:'invalid_request'},400)
	const limit=Math.min(100,Math.max(1,Number(c.req.query('limit')??20)))
	const offset=Math.max(0,Number(c.req.query('offset')??0))
	if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))return c.json({error:'分页参数不正确',code:'invalid_request'},400)
	const placeholders=statuses.map(()=>'?').join(',')
	const rows=await c.env.abdl_space_db.prepare(`SELECT a.id,a.user_id,u.username,u.avatar,a.status,a.submitted_at,a.claimed_by,a.claimed_at,a.decided_at,a.created_at,a.updated_at FROM baby_verification_applications a JOIN users u ON u.id=a.user_id WHERE a.status IN (${placeholders}) ORDER BY COALESCE(a.submitted_at,a.created_at),a.id LIMIT ? OFFSET ?`).bind(...statuses,limit,offset).all()
	const total=await c.env.abdl_space_db.prepare(`SELECT COUNT(*) AS total FROM baby_verification_applications WHERE status IN (${placeholders})`).bind(...statuses).first<{total:number}>()
	return c.json({items:rows.results,total:total?.total??0})
})
adminBabyVerification.get('/applications/:id',async c=>{
	const row=await getBabyApplication(c.env,c.req.param('id'))
	if(!row)return c.json({error:'申请不存在',code:'application_not_found'},404)
	const user=await c.env.abdl_space_db.prepare('SELECT id,username,avatar FROM users WHERE id=?').bind(row.user_id).first()
	const evidence=await c.env.abdl_space_db.prepare('SELECT id,kind,mime_type,declared_size,verified_size,status,completed_at FROM baby_verification_evidence WHERE application_id=? ORDER BY kind').bind(row.id).all()
	const capture_session=await c.env.abdl_space_db.prepare('SELECT id,status,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at FROM baby_verification_capture_sessions WHERE id=? AND user_id=?').bind(row.capture_session_id,row.user_id).first()
	return c.json({...row,qq:await decryptBabyQq(c.env,row.qq,row.id),adult_declaration:!!row.adult_declaration,user,capture_session,evidence:evidence.results})
})
adminBabyVerification.post('/applications/:id/claim',async c=>c.json(await claimBabyApplication(c.env,c.get('user').sub,c.req.param('id'))))
adminBabyVerification.post('/applications/:id/release',async c=>c.json(await releaseBabyApplication(c.env,c.get('user').sub,c.req.param('id'))))
adminBabyVerification.post('/applications/:id/decision',async c=>{
	const result=await decideBabyApplication(c.env,c.get('user').sub,c.req.param('id'),await readBabyJson(c.req.raw))
	if(result.notification)c.executionCtx.waitUntil(result.notification.catch(error=>console.error('baby verification push failed',error instanceof Error?error.message:'unknown')))
	return c.json(result.body)
})
adminBabyVerification.post('/applications/:applicationId/evidence/:evidenceId/view-authorize',async c=>c.json(await authorizeAdminBabyEvidence(c.env,c.get('user').sub,c.req.param('applicationId'),c.req.param('evidenceId'))))
adminBabyVerification.post('/certificates/:id/revoke',async c=>c.json(await mutateBabyCertificate(c.env,c.get('user').sub,c.req.param('id'),'revoke',await readBabyJson(c.req.raw))))
adminBabyVerification.post('/certificates/:id/reissue',async c=>c.json(await mutateBabyCertificate(c.env,c.get('user').sub,c.req.param('id'),'reissue',await readBabyJson(c.req.raw))))
adminBabyVerification.get('/audit',async c=>{
	const limit=Math.min(100,Math.max(1,Number(c.req.query('limit')??20)));const offset=Math.max(0,Number(c.req.query('offset')??0))
	if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))return c.json({error:'分页参数不正确',code:'invalid_request'},400)
	const applicationId=c.req.query('application_id')?babyText(c.req.query('application_id'),'申请标识',64):null
	const rows=applicationId?await c.env.abdl_space_db.prepare('SELECT id,actor_id,user_id,application_id,action,reason,metadata_json,created_at FROM baby_verification_audit WHERE application_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(applicationId,limit,offset).all():await c.env.abdl_space_db.prepare('SELECT id,actor_id,user_id,application_id,action,reason,metadata_json,created_at FROM baby_verification_audit ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(limit,offset).all()
	return c.json({items:rows.results.map(row=>({...row,metadata:JSON.parse(String(row.metadata_json)),metadata_json:undefined}))})
})

export default adminBabyVerification
