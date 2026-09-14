import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import type { Env } from '../types/index.ts'
import { assertSessionNotStale } from '../middleware/auth.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'

interface AppType { Bindings: Env }
const route = new Hono<AppType>()
const ORIGINS=new Set(['https://abdl-space.top','https://www.abdl-space.top','https://m.abdl-space.top','http://localhost:5173','http://localhost:5174'])
route.use('*',cors({origin:origin=>ORIGINS.has(origin)?origin:'',credentials:true,allowMethods:['GET','POST','PUT','OPTIONS'],allowHeaders:['Content-Type','Authorization','Idempotency-Key']}))
const MAX_JSON = 2 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const CATEGORIES = new Set(['fiction','fantasy','romance','science_fiction','mystery','history','essay','other'])
const RATINGS = new Set(['all_ages','suggest_12','suggest_15','suggest_18'])

async function authenticate(c: Context<AppType>, scope: 'read'|'write') {
  const auth = await mastodonAuthDetails(c)
  if (!auth || (auth.tokenType === 'oauth' && !auth.scopes.includes(scope)) || (auth.tokenType === 'jwt' && await assertSessionNotStale(auth.user, c.env.abdl_space_db))) return null
  const user = await c.env.abdl_space_db.prepare('SELECT id FROM users WHERE id=?').bind(auth.user.sub).first()
  return user ? auth.user : null
}
async function json(c: Context<AppType>) {
  const length = Number(c.req.header('content-length') ?? 0)
  if (!Number.isSafeInteger(length) || length > MAX_JSON) return null
  try { const value: unknown = await c.req.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null }
}
function text(value: unknown, max: number, optional=false) { if (typeof value !== 'string') return optional ? '' : null; const v=value.replace(/\r\n?/g,'\n').trim(); return (optional || v) && v.length<=max && !v.includes('\0') ? v : null }
function id(value: unknown) { return typeof value === 'string' && ID.test(value) ? value : null }
function operation(c: Context<AppType>) { const value=c.req.header('Idempotency-Key')?.trim(); return value && UUID.test(value) ? value.toLowerCase() : null }
async function sha(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('') }

route.post('/sync/start', async c => {
  const user=await authenticate(c,'write'); if(!user)return c.json({error:'Authentication required',code:'unauthorized'},401)
  const op=operation(c), body=await json(c); if(!op||!body)return c.json({error:'Invalid request',code:'invalid_request'},400)
  const work=id(body.client_work_id), title=text(body.title,120), description=text(body.description,2000,true), category=text(body.category,40), rating=text(body.declared_rating,30), warning=text(body.content_warning,500,true)
  if(!work||!title||description===null||!category||!CATEGORIES.has(category)||!rating||!RATINGS.has(rating)||warning===null)return c.json({error:'Invalid work metadata',code:'invalid_request'},422)
  const fingerprint=await sha(JSON.stringify([work,title,description,category,rating,warning]))
  const replay=await c.env.abdl_space_db.prepare('SELECT request_hash,response_json FROM novel_v2_sync_operations WHERE owner_id=? AND operation_id=?').bind(user.sub,op).first<{request_hash:string;response_json:string}>()
  if(replay)return replay.request_hash===fingerprint?c.json(JSON.parse(replay.response_json)):c.json({error:'Idempotency conflict',code:'idempotency_conflict'},409)
  const priorWorkspace=await c.env.abdl_space_db.prepare('SELECT novel_id FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=?').bind(user.sub,work).first<{novel_id:string}>()
  const syncId=crypto.randomUUID(), novelId=priorWorkspace?.novel_id??crypto.randomUUID(), response=JSON.stringify({sync_id:syncId,client_work_id:work})
  const results=await c.env.abdl_space_db.batch([
    priorWorkspace
      ? c.env.abdl_space_db.prepare('UPDATE novels SET title=?,description=?,category=?,updated_at=unixepoch() WHERE id=? AND author_id=? AND deleted_at IS NULL').bind(title,description,category,novelId,user.sub)
      : c.env.abdl_space_db.prepare(`INSERT INTO novels(id,author_id,title,description,category,status,idempotency_key)
          VALUES(?,?,?,?,?,'draft',?)`).bind(novelId,user.sub,title,description,category,`v2:${work}`),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_workspaces(owner_id,client_work_id,novel_id,pending_sync_id,title,description,category,declared_rating,content_warning,updated_at)
      SELECT ?,?,id,?,?,?,?,?,?,unixepoch() FROM novels WHERE author_id=? AND idempotency_key=? AND deleted_at IS NULL
      ON CONFLICT(owner_id,client_work_id) DO UPDATE SET pending_sync_id=excluded.pending_sync_id,title=excluded.title,description=excluded.description,category=excluded.category,declared_rating=excluded.declared_rating,content_warning=excluded.content_warning,updated_at=unixepoch()`).bind(user.sub,work,syncId,title,description,category,rating,warning,user.sub,`v2:${work}`),
    c.env.abdl_space_db.prepare('DELETE FROM novel_v2_sync_staging_chapters WHERE owner_id=? AND client_work_id=?').bind(user.sub,work),
    c.env.abdl_space_db.prepare('DELETE FROM novel_v2_sync_staging_volumes WHERE owner_id=? AND client_work_id=?').bind(user.sub,work),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_sync_operations(owner_id,operation_id,client_work_id,request_hash,response_json)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=? AND pending_sync_id=?)`).bind(user.sub,op,work,fingerprint,response,user.sub,work,syncId),
  ])
  if(results[4].meta.changes!==1)return c.json({error:'Sync start failed',code:'sync_failed'},409)
  return c.json(JSON.parse(response),201)
})

route.put('/sync/:syncId/parts/:part', async c => {
  const user=await authenticate(c,'write'); if(!user)return c.json({error:'Authentication required',code:'unauthorized'},401)
  const op=operation(c), body=await json(c), syncId=c.req.param('syncId'); if(!op||!UUID.test(syncId)||!body)return c.json({error:'Invalid request',code:'invalid_request'},400)
  const work=id(body.client_work_id); if(!work)return c.json({error:'Invalid work',code:'invalid_request'},422)
  const volumes=Array.isArray(body.volumes)?body.volumes:[], chapters=Array.isArray(body.chapters)?body.chapters:[]
  if(volumes.length>50||chapters.length>50)return c.json({error:'Too many items',code:'invalid_request'},422)
  const normalizedVolumes: Array<{id:string;title:string;sort:number}>=[], normalizedChapters: Array<{id:string;volume:string;title:string;sort:number;generation:number;body:string;hash:string}>=[]
  for(const value of volumes){ if(!value||typeof value!=='object')return c.json({error:'Invalid volume',code:'invalid_request'},422);const v=value as Record<string,unknown>,vid=id(v.client_volume_id),title=text(v.title,120),sort=v.sort_order;if(!vid||!title||!Number.isSafeInteger(sort)||Number(sort)<0)return c.json({error:'Invalid volume',code:'invalid_request'},422);normalizedVolumes.push({id:vid,title,sort:Number(sort)}) }
  for(const value of chapters){ if(!value||typeof value!=='object')return c.json({error:'Invalid chapter',code:'invalid_request'},422);const v=value as Record<string,unknown>,cid=id(v.client_chapter_id),volume=id(v.client_volume_id),title=text(v.title,160),content=typeof v.body==='string'?v.body.replace(/\r\n?/g,'\n'):null,generation=v.generation,sort=v.sort_order,hash=typeof v.body_sha256==='string'?v.body_sha256.toLowerCase():'';if(!cid||!volume||!title||!content||content.length>500000||!Number.isSafeInteger(generation)||Number(generation)<1||!Number.isSafeInteger(sort)||Number(sort)<0||!SHA.test(hash)||await sha(content)!==hash)return c.json({error:'Invalid chapter',code:'invalid_request'},422);normalizedChapters.push({id:cid,volume,title,sort:Number(sort),generation:Number(generation),body:content,hash}) }
  const fingerprint=await sha(JSON.stringify([work,c.req.param('part'),normalizedVolumes,normalizedChapters]))
  const replay=await c.env.abdl_space_db.prepare('SELECT request_hash,response_json FROM novel_v2_sync_operations WHERE owner_id=? AND operation_id=?').bind(user.sub,op).first<{request_hash:string;response_json:string}>()
  if(replay)return replay.request_hash===fingerprint?c.json(JSON.parse(replay.response_json)):c.json({error:'Idempotency conflict',code:'idempotency_conflict'},409)
  const workspace=await c.env.abdl_space_db.prepare('SELECT 1 ok FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=? AND pending_sync_id=?').bind(user.sub,work,syncId).first()
  if(!workspace)return c.json({error:'Sync session not found',code:'sync_not_found'},404)
  const statements=[]
  for(const v of normalizedVolumes)statements.push(c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_sync_staging_volumes(owner_id,client_work_id,sync_id,client_volume_id,title,sort_order)
    VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,client_work_id,sync_id,client_volume_id) DO UPDATE SET title=excluded.title,sort_order=excluded.sort_order`).bind(user.sub,work,syncId,v.id,v.title,v.sort))
  for(const chapter of normalizedChapters)statements.push(c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_sync_staging_chapters(owner_id,client_work_id,sync_id,client_chapter_id,client_volume_id,title,sort_order,generation,body,body_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,client_work_id,sync_id,client_chapter_id) DO UPDATE SET client_volume_id=excluded.client_volume_id,title=excluded.title,sort_order=excluded.sort_order,generation=excluded.generation,body=excluded.body,body_sha256=excluded.body_sha256`).bind(user.sub,work,syncId,chapter.id,chapter.volume,chapter.title,chapter.sort,chapter.generation,chapter.body,chapter.hash))
  const response=JSON.stringify({sync_id:syncId,part:c.req.param('part'),accepted_volumes:normalizedVolumes.length,accepted_chapters:normalizedChapters.length})
  statements.push(c.env.abdl_space_db.prepare('INSERT INTO novel_v2_sync_operations(owner_id,operation_id,client_work_id,request_hash,response_json) VALUES(?,?,?,?,?)').bind(user.sub,op,work,fingerprint,response))
  await c.env.abdl_space_db.batch(statements);return c.json(JSON.parse(response))
})

route.post('/sync/:syncId/finalize', async c => {
  const user=await authenticate(c,'write');if(!user)return c.json({error:'Authentication required',code:'unauthorized'},401)
  const op=operation(c),body=await json(c),syncId=c.req.param('syncId'),work=body&&id(body.client_work_id);if(!op||!body||!UUID.test(syncId)||!work)return c.json({error:'Invalid request',code:'invalid_request'},400)
  const fingerprint=await sha(JSON.stringify([work,syncId]))
  const replay=await c.env.abdl_space_db.prepare('SELECT request_hash,response_json FROM novel_v2_sync_operations WHERE owner_id=? AND operation_id=?').bind(user.sub,op).first<{request_hash:string;response_json:string}>();if(replay)return replay.request_hash===fingerprint?c.json(JSON.parse(replay.response_json)):c.json({error:'Idempotency conflict',code:'idempotency_conflict'},409)
  const counts=await c.env.abdl_space_db.prepare(`SELECT (SELECT COUNT(*) FROM novel_v2_sync_staging_volumes WHERE owner_id=? AND client_work_id=? AND sync_id=?) volumes,
    (SELECT COUNT(*) FROM novel_v2_sync_staging_chapters WHERE owner_id=? AND client_work_id=? AND sync_id=?) chapters`).bind(user.sub,work,syncId,user.sub,work,syncId).first<{volumes:number;chapters:number}>()
  if(!counts||counts.volumes<1||counts.chapters<1)return c.json({error:'Sync session is incomplete',code:'sync_incomplete'},409)
  const response=JSON.stringify({sync_id:syncId,client_work_id:work,manifest_version:1,volumes:counts.volumes,chapters:counts.chapters})
  const statements=[
    c.env.abdl_space_db.prepare('DELETE FROM novel_v2_chapters WHERE owner_id=? AND client_work_id=?').bind(user.sub,work),
    c.env.abdl_space_db.prepare('DELETE FROM novel_v2_volumes WHERE owner_id=? AND client_work_id=?').bind(user.sub,work),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_volumes(owner_id,client_work_id,client_volume_id,title,sort_order,updated_at)
      SELECT owner_id,client_work_id,client_volume_id,title,sort_order,unixepoch() FROM novel_v2_sync_staging_volumes WHERE owner_id=? AND client_work_id=? AND sync_id=?`).bind(user.sub,work,syncId),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_chapters(owner_id,client_work_id,client_chapter_id,client_volume_id,title,sort_order,generation,body,body_sha256,updated_at)
      SELECT owner_id,client_work_id,client_chapter_id,client_volume_id,title,sort_order,generation,body,body_sha256,unixepoch() FROM novel_v2_sync_staging_chapters WHERE owner_id=? AND client_work_id=? AND sync_id=?`).bind(user.sub,work,syncId),
    c.env.abdl_space_db.prepare('UPDATE novel_v2_workspaces SET manifest_version=manifest_version+1,pending_sync_id=NULL,updated_at=unixepoch() WHERE owner_id=? AND client_work_id=? AND pending_sync_id=?').bind(user.sub,work,syncId),
    c.env.abdl_space_db.prepare('DELETE FROM novel_v2_sync_staging_chapters WHERE owner_id=? AND client_work_id=? AND sync_id=?').bind(user.sub,work,syncId),
    c.env.abdl_space_db.prepare('DELETE FROM novel_v2_sync_staging_volumes WHERE owner_id=? AND client_work_id=? AND sync_id=?').bind(user.sub,work,syncId),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_sync_operations(owner_id,operation_id,client_work_id,request_hash,response_json)
      SELECT ?,?,?,?,json_set(?,'$.manifest_version',manifest_version) FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=? AND pending_sync_id IS NULL`).bind(user.sub,op,work,fingerprint,response,user.sub,work),
  ]
  const results=await c.env.abdl_space_db.batch(statements);if(results[4].meta.changes!==1||results[7].meta.changes!==1)return c.json({error:'Finalize conflict',code:'sync_conflict'},409)
  const saved=await c.env.abdl_space_db.prepare('SELECT response_json FROM novel_v2_sync_operations WHERE owner_id=? AND operation_id=?').bind(user.sub,op).first<{response_json:string}>();return c.json(JSON.parse(saved!.response_json))
})

route.get('/works/:clientWorkId/manifest',async c=>{
  const user=await authenticate(c,'read');if(!user)return c.json({error:'Authentication required',code:'unauthorized'},401);const work=id(c.req.param('clientWorkId'));if(!work)return c.json({error:'Invalid work',code:'invalid_request'},400)
  const workspace=await c.env.abdl_space_db.prepare('SELECT client_work_id,novel_id,manifest_version,title,description,category,declared_rating,content_warning,updated_at FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=?').bind(user.sub,work).first();if(!workspace)return c.json({error:'Work not found',code:'not_found'},404)
  const volumes=await c.env.abdl_space_db.prepare('SELECT client_volume_id,title,sort_order FROM novel_v2_volumes WHERE owner_id=? AND client_work_id=? ORDER BY sort_order,client_volume_id').bind(user.sub,work).all();const chapters=await c.env.abdl_space_db.prepare('SELECT client_chapter_id,client_volume_id,title,sort_order,generation,body_sha256,LENGTH(body) body_length FROM novel_v2_chapters WHERE owner_id=? AND client_work_id=? ORDER BY client_volume_id,sort_order,client_chapter_id').bind(user.sub,work).all();return c.json({work:workspace,volumes:volumes.results,chapters:chapters.results})
})

route.post('/works/:clientWorkId/releases',async c=>{
  const user=await authenticate(c,'write');if(!user)return c.json({error:'Authentication required',code:'unauthorized'},401);const op=operation(c),body=await json(c),work=id(c.req.param('clientWorkId')),manifest=body&&body.manifest_version;if(!op||!body||!work||!Number.isSafeInteger(manifest)||Number(manifest)<1)return c.json({error:'Invalid request',code:'invalid_request'},400)
  const fingerprint=await sha(JSON.stringify([work,manifest]))
  const replay=await c.env.abdl_space_db.prepare('SELECT request_hash,response_json FROM novel_v2_release_operations WHERE owner_id=? AND operation_id=?').bind(user.sub,op).first<{request_hash:string;response_json:string}>();if(replay)return replay.request_hash===fingerprint?c.json(JSON.parse(replay.response_json)):c.json({error:'Idempotency conflict',code:'idempotency_conflict'},409)
  const workspace=await c.env.abdl_space_db.prepare('SELECT novel_id,title,description,category,declared_rating,content_warning,manifest_version FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=?').bind(user.sub,work).first<Record<string,unknown>>();if(!workspace)return c.json({error:'Work not found',code:'not_found'},404);if(workspace.manifest_version!==manifest)return c.json({error:'Manifest changed',code:'manifest_conflict'},409)
  const counts=await c.env.abdl_space_db.prepare('SELECT COUNT(*) chapters FROM novel_v2_chapters WHERE owner_id=? AND client_work_id=?').bind(user.sub,work).first<{chapters:number}>();if(!counts||counts.chapters<1)return c.json({error:'Work has no chapters',code:'empty_work'},409)
  const eligibility=await c.env.abdl_space_db.prepare(`SELECT CASE WHEN datetime(created_at)<=datetime('now','-72 hours') AND EXISTS(SELECT 1 FROM posts WHERE user_id=users.id) THEN 1 ELSE 0 END ok FROM users WHERE id=?`).bind(user.sub).first<{ok:number}>();if(!eligibility||eligibility.ok!==1)return c.json({error:'Author is not eligible to publish',code:'author_not_eligible'},403)
  const releaseId=crypto.randomUUID();const version=Number((await c.env.abdl_space_db.prepare('SELECT COALESCE(MAX(release_version),0)+1 version FROM novel_v2_releases WHERE novel_id=?').bind(workspace.novel_id).first<{version:number}>())!.version);const response=JSON.stringify({work_id:workspace.novel_id,client_work_id:work,release_id:releaseId,release_version:version,manifest_version:manifest,status:'published'})
  const statements=[
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_releases(id,novel_id,owner_id,client_work_id,release_version,manifest_version,title,description,category,declared_rating,content_warning)
      SELECT ?,novel_id,owner_id,client_work_id,?,manifest_version,title,description,category,declared_rating,content_warning FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=? AND manifest_version=?`).bind(releaseId,version,user.sub,work,manifest),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_release_volumes(release_id,client_volume_id,title,sort_order)
      SELECT ?,client_volume_id,title,sort_order FROM novel_v2_volumes WHERE owner_id=? AND client_work_id=?`).bind(releaseId,user.sub,work),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_release_chapters(release_id,client_chapter_id,client_volume_id,title,sort_order,generation,body,body_sha256)
      SELECT ?,client_chapter_id,client_volume_id,title,sort_order,generation,body,body_sha256 FROM novel_v2_chapters WHERE owner_id=? AND client_work_id=?`).bind(releaseId,user.sub,work),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_current_releases(novel_id,release_id,updated_at)
      SELECT novel_id,?,unixepoch() FROM novel_v2_workspaces WHERE owner_id=? AND client_work_id=? ON CONFLICT(novel_id) DO UPDATE SET release_id=excluded.release_id,updated_at=excluded.updated_at`).bind(releaseId,user.sub,work),
    c.env.abdl_space_db.prepare("UPDATE novels SET title=?,description=?,category=?,status='published',updated_at=unixepoch() WHERE id=? AND author_id=?").bind(workspace.title,workspace.description,workspace.category,workspace.novel_id,user.sub),
    c.env.abdl_space_db.prepare(`INSERT INTO novel_v2_release_operations(owner_id,operation_id,client_work_id,request_hash,response_json)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM novel_v2_current_releases WHERE novel_id=? AND release_id=?)`).bind(user.sub,op,work,fingerprint,response,workspace.novel_id,releaseId),
  ]
  const results=await c.env.abdl_space_db.batch(statements);if(results[0].meta.changes!==1||results[1].meta.changes<1||results[2].meta.changes!==counts.chapters||results[5].meta.changes!==1)return c.json({error:'Release failed',code:'release_failed'},409);return c.json(JSON.parse(response),201)
})

export default route
