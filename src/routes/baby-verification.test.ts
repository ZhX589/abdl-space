import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Hono } from 'hono'
import babyVerification from './baby-verification.ts'
import { signJWT } from '../lib/auth.ts'
import { createHash } from 'node:crypto'

function fixtureText(relativePath:string):string { return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),relativePath),'utf8') }

function database(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(fixtureText('../../schemas/schema.sql'));db.exec(fixtureText('../../migrations/0025_account_system_upgrade.sql'));db.exec(fixtureText('../../migrations/0058_badge_colors_notification.sql'));db.exec(fixtureText('../../migrations/0062_sponsors.sql'));return db}
function d1(db:DatabaseSync){const statement=(sql:string,params:SQLInputValue[]=[]):Record<string,unknown>=>({bind:(...next:SQLInputValue[])=>statement(sql,next),first:async()=>db.prepare(sql).get(...params)??null,all:async()=>({success:true,results:db.prepare(sql).all(...params)}),run:async()=>{const r=db.prepare(sql).run(...params);return{success:true,meta:{changes:Number(r.changes)}}}});return{prepare:(sql:string)=>statement(sql),batch:async(items:Array<{run:()=>Promise<unknown>}>)=>Promise.all(items.map(item=>item.run()))}}

async function privateFixture() {
	const db=database();db.exec("UPDATE baby_verification_settings SET enabled=1;INSERT INTO users(id,email,password_hash,username) VALUES(1,'one@example.test','hash','one'),(2,'two@example.test','hash','two')")
	const env={abdl_space_db:d1(db),JWT_SECRET:'route-test-secret',COS_SECRET_ID:'test-id',COS_SECRET_KEY:'test-key',COS_BUCKET:'test-123',COS_REGION:'ap-shanghai',BABY_VERIFICATION_DATA_KEY:Buffer.alloc(32,1).toString('base64')}
	const app=new Hono();app.route('/api/v1/baby-verification',babyVerification)
	const jwt=await signJWT({sub:1,username:'one',email:'one@example.test',role:'user'},env.JWT_SECRET)
	const request=(path:string,body:unknown={},method='POST')=>app.request(`/api/v1/baby-verification${path}`,{method,headers:{Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})},env as never)
	const session=await (await request('/capture-sessions')).json() as {id:string;nonce:string}
	assert.equal((await request(`/capture-sessions/${session.id}/complete`)).status,200)
	const created=await request('/applications',{capture_session_id:session.id,adult_declaration:true,declaration_version:'2026-09-13',qq:'12345678'})
	assert.equal(created.status,201)
	const application=await created.json() as {id:string}
	const photo=new TextEncoder().encode('route-photo-fixture')
	const metadata={kind:'capture_photo',mime_type:'image/jpeg',declared_size:photo.byteLength,content_sha256:createHash('sha256').update(photo).digest('hex'),content_md5:createHash('md5').update(photo).digest('base64')}
	const authorize=()=>request(`/applications/${application.id}/evidence/authorize`,metadata)
	const authorization=await (await authorize()).json() as {evidence_id:string;upload_url:string;required_headers:Record<string,string>;expires_at:number}
	return {db,env,app,request,authorize,authorization,application,session,photo,metadata}
}

test('authenticated routes recover a missing private object without bypassing proof, ownership or quota',async t=>{
	const f=await privateFixture();let uploaded=false;let reads=0
	t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
		assert.equal(String(input),f.authorization.upload_url)
		if(init?.method==='PUT') {
			const headers=new Headers(init.headers)
			assert.equal(headers.get('content-length'),String(f.photo.byteLength));assert.equal(headers.get('content-md5'),f.metadata.content_md5)
			assert.equal(headers.get('x-cos-meta-sha256'),f.metadata.content_sha256);assert.equal(headers.get('x-cos-acl'),'private');assert.equal(headers.get('x-cos-forbid-overwrite'),'true')
			if(uploaded)return new Response(null,{status:409})
			uploaded=true;return new Response(null,{status:200})
		}
		reads++
		if(!uploaded)return new Response(null,{status:404,headers:{'x-cos-request-id':'request-not-for-client'}})
		return new Response(init?.method==='HEAD'?null:f.photo,{headers:{'content-type':'image/jpeg','content-length':String(f.photo.byteLength)}})
	})
	try {
		const otherJwt=await signJWT({sub:2,username:'two',email:'two@example.test',role:'user'},f.env.JWT_SECRET)
		const forbidden=await f.app.request(`/api/v1/baby-verification/evidence/${f.authorization.evidence_id}/complete`,{method:'POST',headers:{Authorization:`Bearer ${otherJwt}`,'Content-Type':'application/json'},body:'{}'},f.env as never)
		assert.equal(forbidden.status,404);assert.equal((await forbidden.json() as {code:string}).code,'evidence_not_found');assert.equal(reads,0)
		const missing=await f.request(`/evidence/${f.authorization.evidence_id}/complete`)
		assert.equal(missing.status,409);assert.match(missing.headers.get('cache-control')??'',/private, no-store/)
		assert.deepEqual(await missing.json(),{error:'照片尚未上传，请重新授权上传',code:'evidence_object_missing'})
		const row=f.db.prepare('SELECT status,verification_token,verification_started_at FROM baby_verification_evidence').get()
		assert.deepEqual({...row},{status:'pending',verification_token:null,verification_started_at:null})
		const blocked=await f.request(`/applications/${f.application.id}/submit`);assert.equal(blocked.status,409);assert.equal((await blocked.json() as {code:string}).code,'application_incomplete')
		const renewed=await (await f.authorize()).json() as typeof f.authorization
		assert.equal(renewed.evidence_id,f.authorization.evidence_id);assert.equal(renewed.upload_url,f.authorization.upload_url)
		assert.equal((await fetch(renewed.upload_url,{method:'PUT',headers:renewed.required_headers,body:f.photo})).status,200)
		assert.equal((await fetch(renewed.upload_url,{method:'PUT',headers:renewed.required_headers,body:f.photo})).status,409)
		const ready=await f.request(`/evidence/${renewed.evidence_id}/complete`);assert.equal(ready.status,200)
		assert.deepEqual(await ready.json(),{id:renewed.evidence_id,status:'ready',verified_size:f.photo.byteLength})
		const before=reads;f.db.exec('UPDATE baby_verification_evidence SET upload_expires_at=1')
		assert.equal((await f.request(`/evidence/${renewed.evidence_id}/complete`)).status,200);assert.equal(reads,before)
		assert.deepEqual(await (await f.authorize()).json(),{evidence_id:renewed.evidence_id,status:'ready',already_uploaded:true})
		const submitted=await f.request(`/applications/${f.application.id}/submit`);assert.equal(submitted.status,200);assert.equal((await submitted.json() as {replayed:boolean}).replayed,false)
		assert.equal((await (await f.request(`/applications/${f.application.id}/submit`)).json() as {replayed:boolean}).replayed,true)
		const me=await (await f.request('/me',{},'GET')).json() as {quota:{used:number;remaining:number}}
		assert.equal(me.quota.used,1);assert.equal(me.quota.remaining,1)
		assert.equal(f.db.prepare('SELECT nonce FROM baby_verification_capture_sessions WHERE id=?').get(f.session.id)?.nonce,f.session.nonce)
	} finally {f.db.close()}
})

for(const method of ['HEAD','GET']) for(const status of [404,403,503]) test(`route ${method} ${status} preserves safe error and pending retry contract`,async t=>{
	const f=await privateFixture()
	t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>init?.method===method?new Response(null,{status,headers:{'x-cos-request-id':'private-id'}}):new Response(null,{headers:{'content-type':'image/jpeg','content-length':String(f.photo.byteLength)}}))
	try {
		const response=await f.request(`/evidence/${f.authorization.evidence_id}/complete`)
		assert.equal(response.status,status===404?409:502)
		assert.deepEqual(await response.json(),status===404?{error:'照片尚未上传，请重新授权上传',code:'evidence_object_missing'}:{error:'私有照片校验暂不可用',code:'verification_unavailable'})
		const row=f.db.prepare('SELECT status,verification_token,verification_started_at FROM baby_verification_evidence').get()
		assert.deepEqual({...row},{status:'pending',verification_token:null,verification_started_at:null})
		assert.equal((await f.authorize()).status,200)
	} finally {f.db.close()}
})

test('expired route performs no COS calls, failed can reauthorize, and changed metadata/live lease cannot',async t=>{
	const f=await privateFixture()
	t.mock.method(globalThis,'fetch',async()=>{throw new Error('unexpected real service call')})
	try {
		f.db.exec('UPDATE baby_verification_evidence SET upload_expires_at=1')
		const expired=await f.request(`/evidence/${f.authorization.evidence_id}/complete`)
		assert.equal(expired.status,410);assert.equal((await expired.json() as {code:string}).code,'upload_expired')
		f.db.exec("UPDATE baby_verification_evidence SET status='failed'")
		assert.equal((await f.authorize()).status,200)
		const changed=await f.request(`/applications/${f.application.id}/evidence/authorize`,{...f.metadata,content_sha256:'f'.repeat(64)})
		assert.equal(changed.status,409);assert.equal((await changed.json() as {code:string}).code,'evidence_conflict')
		f.db.exec("UPDATE baby_verification_evidence SET status='verifying',verification_token='live',verification_started_at=unixepoch()")
		const locked=await f.authorize();assert.equal(locked.status,409);assert.equal((await locked.json() as {code:string}).code,'evidence_verifying')
	} finally {f.db.close()}
})

test('public verify response is no-store, no-referrer and noindex',async()=>{
	const db=database();const app=new Hono();app.route('/api/v1/baby-verification',babyVerification)
	try{
		const response=await app.request('/api/v1/baby-verification/verify/not-a-token',{}, {abdl_space_db:d1(db)} as never)
		assert.equal(response.status,200);assert.match(response.headers.get('cache-control')??'',/no-store/);assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('x-robots-tag')??'',/noindex/);assert.deepEqual(await response.json(),{valid:false,status:'unknown'})
	}finally{db.close()}
})
