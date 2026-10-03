import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BabyVerificationError, authorizeBabyEvidence, completeBabyEvidence, createBabyApplication, createBabyCaptureSession, transitionBabyCaptureSession, submitBabyApplication, claimBabyApplication, decideBabyApplication, deriveBabyCredentialToken, getAdminBabyCertificate, getBabyCertificateMe, mutateBabyCertificate, releaseBabyApplication, validateBabyVerificationConfig, verifyBabyCredential } from './baby-verification.ts'
import { createHash } from 'node:crypto'

function fixtureText(relativePath:string):string { return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),relativePath),'utf8') }

function database(): DatabaseSync {
	const db=new DatabaseSync(':memory:')
	db.exec('PRAGMA foreign_keys=ON')
	db.exec(fixtureText('../../schemas/schema.sql'))
	db.exec(fixtureText('../../migrations/0025_account_system_upgrade.sql'))
	db.exec(fixtureText('../../migrations/0058_badge_colors_notification.sql'))
	db.exec(fixtureText('../../migrations/0062_sponsors.sql'))
	db.prepare("INSERT INTO users(id,email,password_hash,username) VALUES(1,'one@example.test','hash','one'),(2,'two@example.test','hash','two')").run()
	return db
}

const photo = new TextEncoder().encode('verification-photo-fixture')
const evidenceInput = { kind:'capture_photo', mime_type:'image/jpeg', declared_size:photo.byteLength, content_sha256:createHash('sha256').update(photo).digest('hex'), content_md5:createHash('md5').update(photo).digest('base64') }

type AfterFirst = (sql:string,row:unknown) => Promise<void>

function signal() {
	let release = () => {}
	const promise = new Promise<void>(resolve => { release = resolve })
	return { promise, release }
}

async function evidenceFixture(afterFirst?:AfterFirst) {
	const db = database()
	db.exec('UPDATE baby_verification_settings SET enabled=1')
	const env = { abdl_space_db:d1(db,afterFirst), COS_SECRET_ID:'test-id', COS_SECRET_KEY:'test-secret', COS_BUCKET:'test-123', COS_REGION:'ap-shanghai', BABY_VERIFICATION_DATA_KEY:Buffer.alloc(32,1).toString('base64') } as never
	const session = await createBabyCaptureSession(env,1)
	await transitionBabyCaptureSession(env,1,String(session.id),'complete')
	const application = await createBabyApplication(env,1,{ capture_session_id:session.id, adult_declaration:true, declaration_version:'2026-09-13', qq:'12345678' })
	const applicationId = String(application.id)
	const authorization = await authorizeBabyEvidence(env,1,applicationId,evidenceInput)
	return { db, env, applicationId, evidenceId:String(authorization.evidence_id), authorization, session }
}

function errorCode(code:string,status?:number) { return (error:unknown) => error instanceof BabyVerificationError && error.code===code && (status===undefined || error.status===status) }
function evidenceState(db:DatabaseSync,id:string) { return db.prepare('SELECT status,verification_token,verification_started_at,upload_expires_at,object_key FROM baby_verification_evidence WHERE id=?').get(id) }
function assertPending(db:DatabaseSync,id:string) { const row=evidenceState(db,id);assert.equal(row?.status,'pending');assert.equal(row?.verification_token,null);assert.equal(row?.verification_started_at,null) }

function d1(db:DatabaseSync,afterFirst?:AfterFirst){const statement=(sql:string,params:SQLInputValue[]=[]):D1PreparedStatement=>({bind:(...next:SQLInputValue[])=>statement(sql,next),first:async<T>()=>{const row=db.prepare(sql).get(...params)??null;await afterFirst?.(sql,row);return row as T|null},run:async()=>{const r=db.prepare(sql).run(...params);return{success:true,meta:{changes:Number(r.changes)}} as D1Result},all:async<T>()=>({success:true,results:db.prepare(sql).all(...params) as T[]}) as D1Result<T>,raw:async()=>[],columnNames:async()=>[]} as unknown as D1PreparedStatement);return{prepare:(sql:string)=>statement(sql),batch:async(items:D1PreparedStatement[])=>{db.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());db.exec('COMMIT');return results}catch(error){db.exec('ROLLBACK');throw error}}}}

test('real evidence functions recover authorize -> missing object -> reauthorize -> PUT -> ready -> submit',async t=>{
	const {db,env,applicationId,evidenceId,authorization,session}=await evidenceFixture()
	let uploaded=false
	t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
		assert.equal(String(input),authorization.upload_url)
		if(init?.method==='PUT') {
			assert.equal(uploaded,false)
			assert.equal(new Headers(init.headers).get('x-cos-acl'),'private')
			assert.equal(new Headers(init.headers).get('x-cos-forbid-overwrite'),'true')
			uploaded=true;return new Response(null,{status:200})
		}
		if(!uploaded)return new Response(null,{status:404,headers:{'x-cos-request-id':'missing-fixture'}})
		return new Response(init?.method==='HEAD'?null:photo,{headers:{'content-type':'image/jpeg','content-length':String(photo.byteLength)}})
	})
	try {
		const original=evidenceState(db,evidenceId)
		await assert.rejects(()=>completeBabyEvidence(env,1,evidenceId),errorCode('evidence_object_missing',409))
		assertPending(db,evidenceId)
		await assert.rejects(()=>submitBabyApplication(env,1,applicationId),errorCode('application_incomplete'))
		const renewed=await authorizeBabyEvidence(env,1,applicationId,evidenceInput)
		assert.equal(renewed.evidence_id,evidenceId);assert.equal(renewed.upload_url,authorization.upload_url)
		assert.equal(evidenceState(db,evidenceId)?.object_key,original?.object_key)
		assert.equal(db.prepare('SELECT nonce FROM baby_verification_capture_sessions WHERE id=?').get(String(session.id))?.nonce,session.nonce)
		assert.equal(Number(renewed.expires_at)-Math.floor(Date.now()/1000),300)
		await fetch(String(renewed.upload_url),{method:'PUT',headers:renewed.required_headers as Record<string,string>,body:photo})
		const ready=await completeBabyEvidence(env,1,evidenceId)
		assert.deepEqual(ready,{id:evidenceId,status:'ready',verified_size:photo.byteLength})
		const replay=await completeBabyEvidence(env,1,evidenceId);assert.deepEqual(replay,ready)
		assert.deepEqual(await authorizeBabyEvidence(env,1,applicationId,evidenceInput),{evidence_id:evidenceId,status:'ready',already_uploaded:true})
		assert.equal((await submitBabyApplication(env,1,applicationId)).replayed,false)
		assert.equal((await submitBabyApplication(env,1,applicationId)).replayed,true)
		assert.equal(db.prepare('SELECT COUNT(*) AS used FROM baby_verification_applications WHERE submitted_at IS NOT NULL').get()?.used,1)
	} finally {db.close()}
})

for(const method of ['HEAD','GET']) for(const status of [404,401,403,500,503]) {
	test(`real complete ${method} ${status} classifies only 404 as missing and releases its lease`,async t=>{
		const {db,env,evidenceId}=await evidenceFixture()
		t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>init?.method===method
			?new Response(null,{status,headers:{'x-cos-request-id':'private-diagnostic-id'}})
			:new Response(null,{headers:{'content-type':'image/jpeg','content-length':String(photo.byteLength)}}))
		try {
			await assert.rejects(()=>completeBabyEvidence(env,1,evidenceId),errorCode(status===404?'evidence_object_missing':'verification_unavailable',status===404?409:502))
			assertPending(db,evidenceId)
		} finally {db.close()}
	})
}

for(const mismatch of ['mime','length','hash','body-length','network']) test(`real evidence ${mismatch} failure never grants ready and permits same-metadata retry`,async t=>{
	const {db,env,applicationId,evidenceId}=await evidenceFixture()
	t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{
		if(mismatch==='network')throw new TypeError('network failure')
		const body=mismatch==='hash'?new Uint8Array(photo.byteLength):mismatch==='body-length'?photo.slice(1):photo
		return new Response(init?.method==='HEAD'?null:body,{headers:{'content-type':mismatch==='mime'?'image/png':'image/jpeg','content-length':String(photo.byteLength+(mismatch==='length'?1:0))}})
	})
	try {
		await assert.rejects(()=>completeBabyEvidence(env,1,evidenceId),errorCode(mismatch==='network'?'verification_unavailable':'evidence_mismatch'))
		assertPending(db,evidenceId)
		await assert.rejects(()=>authorizeBabyEvidence(env,1,applicationId,{...evidenceInput,content_sha256:'f'.repeat(64)}),errorCode('evidence_conflict'))
		await assert.rejects(()=>submitBabyApplication(env,1,applicationId),errorCode('application_incomplete'))
		assert.equal((await authorizeBabyEvidence(env,1,applicationId,evidenceInput)).evidence_id,evidenceId)
	} finally {db.close()}
})

test('real evidence authorization repairs failed/stale states but never steals a live lease or crosses ownership',async t=>{
	const {db,env,applicationId,evidenceId}=await evidenceFixture()
	t.mock.method(globalThis,'fetch',async()=>{throw new Error('unexpected COS request')})
	try {
		await assert.rejects(()=>completeBabyEvidence(env,2,evidenceId),errorCode('evidence_not_found'))
		await assert.rejects(()=>authorizeBabyEvidence(env,2,applicationId,evidenceInput),errorCode('application_not_found'))
		db.prepare("UPDATE baby_verification_evidence SET status='failed',upload_expires_at=1 WHERE id=?").run(evidenceId)
		await assert.rejects(()=>completeBabyEvidence(env,1,evidenceId),errorCode('upload_expired',410))
		assert.equal((await authorizeBabyEvidence(env,1,applicationId,evidenceInput)).status,'pending');assertPending(db,evidenceId)
		db.prepare("UPDATE baby_verification_evidence SET status='verifying',verification_token='old-token',verification_started_at=unixepoch() WHERE id=?").run(evidenceId)
		await assert.rejects(()=>authorizeBabyEvidence(env,1,applicationId,evidenceInput),errorCode('evidence_verifying'))
		await assert.rejects(()=>completeBabyEvidence(env,1,evidenceId),errorCode('evidence_verifying'))
		assert.equal(evidenceState(db,evidenceId)?.verification_token,'old-token')
		db.prepare('UPDATE baby_verification_evidence SET verification_started_at=unixepoch()-121,upload_expires_at=1 WHERE id=?').run(evidenceId)
		await authorizeBabyEvidence(env,1,applicationId,evidenceInput);assertPending(db,evidenceId)
		assert.ok(Number(evidenceState(db,evidenceId)?.upload_expires_at)>Math.floor(Date.now()/1000))
	} finally {db.close()}
})

test('an obsolete completion cannot release a replacement verification token',async t=>{
	const {db,env,evidenceId}=await evidenceFixture()
	t.mock.method(globalThis,'fetch',async()=>{
		db.prepare("UPDATE baby_verification_evidence SET verification_token='replacement-token' WHERE id=?").run(evidenceId)
		return new Response(null,{status:404})
	})
	try {
		await assert.rejects(()=>completeBabyEvidence(env,1,evidenceId),errorCode('evidence_object_missing'))
		assert.equal(evidenceState(db,evidenceId)?.status,'verifying')
		assert.equal(evidenceState(db,evidenceId)?.verification_token,'replacement-token')
	} finally {db.close()}
})

test('concurrent first authorizations both read absence but insert only one evidence and retry its identity',async()=>{
	const bothRead=signal();let armed=false;let reads=0
	const {db,env,applicationId,evidenceId}=await evidenceFixture(async(sql,row)=>{
		if(armed && sql.startsWith('SELECT id,kind,mime_type')) {
			assert.equal(row,null)
			if(++reads===2)bothRead.release()
			await bothRead.promise
		}
	})
	try {
		db.prepare('DELETE FROM baby_verification_evidence WHERE id=?').run(evidenceId)
		armed=true
		const results=await Promise.allSettled([authorizeBabyEvidence(env,1,applicationId,evidenceInput),authorizeBabyEvidence(env,1,applicationId,evidenceInput)])
		armed=false
		assert.equal(reads,2)
		const winners=results.filter(result=>result.status==='fulfilled')
		const losers=results.filter(result=>result.status==='rejected')
		assert.equal(winners.length,1);assert.equal(losers.length,1)
		assert.ok(errorCode('evidence_conflict',409)(losers[0].reason))
		const winner=winners[0].value
		assert.equal(db.prepare('SELECT COUNT(*) AS count FROM baby_verification_evidence').get()?.count,1)
		assertPending(db,String(winner.evidence_id))
		const replay=await authorizeBabyEvidence(env,1,applicationId,evidenceInput)
		assert.equal(replay.evidence_id,winner.evidence_id);assert.equal(replay.upload_url,winner.upload_url)
	} finally {bothRead.release();db.close()}
})

for(const next of ['ready','verifying']) test(`authorize CAS rejects ${next} state installed after its pending snapshot`,async()=>{
	const read=signal();const resume=signal();let armed=false
	const {db,env,applicationId,evidenceId}=await evidenceFixture(async(sql,row)=>{
		if(armed && sql.startsWith('SELECT id,kind,mime_type')) {
			assert.equal((row as {status:string}).status,'pending')
			read.release();await resume.promise
		}
	})
	try {
		armed=true
		const authorization=authorizeBabyEvidence(env,1,applicationId,evidenceInput)
		const rejected=assert.rejects(authorization,errorCode('evidence_conflict',409))
		await read.promise
		if(next==='ready')db.prepare("UPDATE baby_verification_evidence SET status='ready',verified_size=?,completed_at=unixepoch() WHERE id=?").run(photo.byteLength,evidenceId)
		else db.prepare("UPDATE baby_verification_evidence SET status='verifying',verification_token='new-live-token',verification_started_at=unixepoch() WHERE id=?").run(evidenceId)
		const changed=evidenceState(db,evidenceId)
		resume.release();await rejected
		assert.deepEqual(evidenceState(db,evidenceId),changed)
		assert.equal(db.prepare('SELECT verified_size FROM baby_verification_evidence WHERE id=?').get(evidenceId)?.verified_size,next==='ready'?photo.byteLength:null)
	} finally {resume.release();db.close()}
})

for(const next of ['pending','verifying','ready']) test(`old complete receiving valid COS bytes cannot overwrite reauthorization and newer ${next} state`,async t=>{
	const {db,env,applicationId,evidenceId}=await evidenceFixture()
	const oldGet=signal();const oldResume=signal();const newHead=signal();const newResume=signal()
	let gets=0;let heads=0
	t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{
		if(init?.method==='GET' && ++gets===1) {oldGet.release();await oldResume.promise}
		if(init?.method==='HEAD' && ++heads===2 && next==='verifying') {newHead.release();await newResume.promise}
		return new Response(init?.method==='HEAD'?null:photo,{headers:{'content-type':'image/jpeg','content-length':String(photo.byteLength)}})
	})
	let newer:Promise<Record<string,unknown>>|undefined
	try {
		const old=completeBabyEvidence(env,1,evidenceId)
		const rejected=assert.rejects(old,errorCode('evidence_conflict',409))
		await oldGet.promise
		const oldToken=evidenceState(db,evidenceId)?.verification_token
		db.prepare('UPDATE baby_verification_evidence SET verification_started_at=unixepoch()-121 WHERE id=?').run(evidenceId)
		assert.equal((await authorizeBabyEvidence(env,1,applicationId,evidenceInput)).status,'pending')
		if(next!=='pending') {
			newer=completeBabyEvidence(env,1,evidenceId)
			if(next==='verifying')await newHead.promise
			else assert.equal((await newer).status,'ready')
		}
		const replacement=evidenceState(db,evidenceId)
		assert.equal(replacement?.status,next)
		if(next==='verifying')assert.notEqual(replacement?.verification_token,oldToken)
		oldResume.release();await rejected
		assert.deepEqual(evidenceState(db,evidenceId),replacement)
		if(next!=='ready')await assert.rejects(()=>submitBabyApplication(env,1,applicationId),errorCode('application_incomplete'))
		if(next==='verifying') {newResume.release();assert.equal((await newer)?.status,'ready')}
		if(next==='pending')assert.equal((await completeBabyEvidence(env,1,evidenceId)).status,'ready')
		assert.equal((await submitBabyApplication(env,1,applicationId)).replayed,false)
	} finally {oldResume.release();newResume.release();await newer;db.close()}
})

test('complete schema and migration 0065 are independently repeatable',()=>{
	const complete=new DatabaseSync(':memory:')
	const migrated=new DatabaseSync(':memory:')
	try{
		const schema=fixtureText('../../schemas/schema.sql')
		complete.exec(schema);complete.exec(schema)
		migrated.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE notifications(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL);CREATE TABLE badges(id INTEGER PRIMARY KEY,key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,icon TEXT NOT NULL,description TEXT NOT NULL,condition_type TEXT NOT NULL,condition_value INTEGER NOT NULL);`)
		const migration=fixtureText('../../migrations/0065_baby_verification.sql')
		migrated.exec(migration);migrated.exec(migration)
		assert.equal(complete.prepare("SELECT COUNT(*) AS count FROM baby_verification_settings").get()?.count,1)
		assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM baby_verification_settings").get()?.count,1)
		assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get()?.count,0)
	}finally{complete.close();migrated.close()}
})

test('config requires explicit adult-independent declaration settings and 2/3 quotas',()=>{
	const config=validateBabyVerificationConfig({version:1,enabled:true,declaration_version:'2026-09-13',free_monthly_limit:2,sponsor_monthly_limit:3,capture_ttl_seconds:900,upload_ttl_seconds:300,max_evidence_size:5*1024*1024})
	assert.equal(config.free_monthly_limit,2);assert.equal(config.sponsor_monthly_limit,3)
	assert.throws(()=>validateBabyVerificationConfig({...config,sponsor_monthly_limit:1}))
})

test('schema enforces one submitted/reviewing application and submit-only quota accounting',()=>{
	const db=database()
	try{
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s1',1,'completed','n',1,'正方形','无需折角','正中间','认证甲',9999999999,1),('s2',1,'completed','n2',1,'圆形','折起左上角','左上角','认证乙',9999999999,1)").run()
		db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at) VALUES('a1',1,'s1','submitted','encrypted-qq-value-long-enough-111',1,'v1',1,1)").run()
		assert.throws(()=>db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at) VALUES('a2',1,'s2','reviewing','encrypted-qq-value-long-enough-222',1,'v1',1,1)").run(),/UNIQUE/)
			assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baby_verification_applications WHERE user_id=1 AND submitted_at IS NOT NULL").get()?.count,1)
	}finally{db.close()}
})

test('capture session conditional completion is idempotent and cannot complete an expired session',()=>{
	const db=database()
	try{
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('live',1,'active','n',1,'正方形','无需折角','正中间','认证甲',unixepoch()+60,NULL),('expired',1,'active','x',1,'圆形','无需折角','右侧','认证乙',1,NULL)").run()
			const complete=db.prepare("UPDATE baby_verification_capture_sessions SET status='completed',completed_at=unixepoch() WHERE id=? AND user_id=? AND status='active' AND expires_at>unixepoch()")
		assert.equal(complete.run('live',1).changes,1);assert.equal(complete.run('live',1).changes,0);assert.equal(complete.run('expired',1).changes,0)
	}finally{db.close()}
})

test('evidence is application-bound, server-keyed and unique per kind',()=>{
	const db=database()
	try{
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','无需折角','正中间','认证甲',9999999999,1)").run()
			db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at) VALUES('a',1,'s','draft','encrypted-qq-value-long-enough-111',1,'v1',1)").run()
			db.prepare("INSERT INTO baby_verification_evidence(id,application_id,user_id,kind,mime_type,object_key,declared_size,content_sha256,content_md5,status,upload_expires_at,verified_size,completed_at) VALUES('e','a',1,'capture_photo','image/jpeg','baby-verification/private/1/a/e.jpg',1,?,'kAFQmDzST7DWlj99KOF/cg==','ready',9999999999,1,1)").run('a'.repeat(64))
			assert.throws(()=>db.prepare("INSERT INTO baby_verification_evidence(id,application_id,user_id,kind,mime_type,object_key,declared_size,content_sha256,content_md5,status,upload_expires_at) VALUES('e2','a',1,'capture_photo','image/jpeg','other',1,?,'kAFQmDzST7DWlj99KOF/cg==','pending',9)").run('b'.repeat(64)),/UNIQUE/)
	}finally{db.close()}
})

test('admin claim/release/approval is conditional, atomic and idempotent',async()=>{
	const db=database();const env={abdl_space_db:d1(db),BABY_VERIFICATION_TOKEN_KEY:'test-token-key'} as never
	try{
		db.prepare("INSERT INTO users(id,email,password_hash,username,role) VALUES(9,'admin@example.test','hash','admin','admin')").run()
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','无需折角','正中间','认证甲',9999999999,1)").run()
		db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at) VALUES('a',1,'s','submitted','encrypted-qq-value-long-enough-111',1,'v1',1,1)").run()
		assert.equal((await claimBabyApplication(env,9,'a')).status,'reviewing')
		assert.equal((await claimBabyApplication(env,9,'a')).status,'reviewing')
		await releaseBabyApplication(env,9,'a');await claimBabyApplication(env,9,'a')
		const operation=crypto.randomUUID();const approved=await decideBabyApplication(env,9,'a',{decision:'approve',note:'资料一致',operation_id:operation})
			assert.equal(approved.body.status,'approved');assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baby_verification_certificates").get()?.count,1);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_badges WHERE badge_key='verified'").get()?.count,1);assert.equal(db.prepare("SELECT target_path FROM baby_verification_notification_details").get()?.target_path,'/settings/baby-verification')
			const replay=await decideBabyApplication(env,9,'a',{decision:'approve',note:'资料一致',operation_id:operation});assert.deepEqual(replay.body,approved.body);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baby_verification_certificates").get()?.count,1);assert.equal(String(db.prepare("SELECT response_body FROM baby_verification_operations WHERE operation_id=?").get(operation)?.response_body).includes(String(approved.body.verification_token)),false)
	}finally{db.close()}
})

test('owner, admin and public certificate states preserve revoke and supersede details',async()=>{
	const db=database();const env={abdl_space_db:d1(db),BABY_VERIFICATION_TOKEN_KEY:'test-token-key'} as never
	try{
		db.prepare("INSERT INTO users(id,email,password_hash,username,role) VALUES(9,'admin@example.test','hash','admin','admin')").run()
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','无需折角','正中间','认证甲',9999999999,1)").run()
		db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at,decided_by,decided_at) VALUES('a',1,'s','approved','encrypted-qq-value-long-enough-111',1,'v1',1,1,9,2)").run()
		const oldToken=await deriveBabyCredentialToken(env,'g1');const cryptoMod=await import('node:crypto');const hash=cryptoMod.createHash('sha256').update(`abdl-space:baby-verification:public-credential:v1\0${oldToken}`).digest('hex')
		db.prepare("INSERT INTO baby_verification_certificates(id,user_id,application_id,status,issued_at,current_credential_id) VALUES('c',1,'a','active',1,'g1')").run()
		db.prepare("INSERT INTO baby_verification_credentials(id,certificate_id,generation,token_hash,status,issued_at) VALUES('g1','c',1,?,'active',1)").run(hash)
		db.prepare("INSERT INTO user_badges(user_id,badge_key) VALUES(1,'verified')").run();db.prepare("INSERT INTO baby_verification_badge_sources(certificate_id,user_id,badge_key,preserved_existing_badge) VALUES('c',1,'verified',0)").run()

		const activeOwner=await getBabyCertificateMe(env,1)
		assert.equal(activeOwner?.status,'active');assert.equal(activeOwner?.generation,1);assert.equal(activeOwner?.verification_token,oldToken);assert.equal(activeOwner?.verify_path,`/api/v1/baby-verification/verify/${oldToken}`)
		const activeAdmin=await getAdminBabyCertificate(env,'a')
		assert.equal(activeAdmin?.status,'active');assert.equal(activeAdmin?.revoked_at,null);assert.equal(activeAdmin?.revoke_reason,null);assert.equal(activeAdmin?.revoked_by,null);assert.equal(activeAdmin?.generation,1);assert.equal(activeAdmin?.verification_token,oldToken)

		const reissueOperation=crypto.randomUUID();const reissued=await mutateBabyCertificate(env,9,'c','reissue',{reason:'二维码遗失',operation_id:reissueOperation})
		assert.equal(reissued.generation,2)
		const oldPublic=await verifyBabyCredential(env,oldToken)
		assert.equal(oldPublic.status,'superseded');assert.equal(typeof oldPublic.superseded_at,'number')
		const replay=await mutateBabyCertificate(env,9,'c','reissue',{reason:'二维码遗失',operation_id:reissueOperation});assert.deepEqual(replay,reissued);assert.equal(String(db.prepare("SELECT response_body FROM baby_verification_operations WHERE operation_id=?").get(reissueOperation)?.response_body).includes(String(reissued.verification_token)),false)

		const revoked=await mutateBabyCertificate(env,9,'c','revoke',{reason:'认证失效',operation_id:crypto.randomUUID()})
		assert.equal(revoked.revoke_reason,'认证失效');assert.equal(typeof revoked.revoked_at,'number')
		const owner=await getBabyCertificateMe(env,1)
		assert.deepEqual(owner,{id:'c',status:'revoked',issued_at:1,revoked_at:revoked.revoked_at,revoke_reason:'认证失效',generation:2})
		const admin=await getAdminBabyCertificate(env,'a')
		assert.deepEqual(admin,{id:'c',status:'revoked',issued_at:1,revoked_at:revoked.revoked_at,revoke_reason:'认证失效',revoked_by:9,revoked_by_username:'admin',generation:2})
		const currentPublic=await verifyBabyCredential(env,String(reissued.verification_token))
		assert.deepEqual(currentPublic,{valid:false,status:'revoked',revoked_at:revoked.revoked_at,revoke_reason:'认证失效'})
		const stillSuperseded=await verifyBabyCredential(env,oldToken)
		assert.equal(stillSuperseded.status,'superseded');assert.equal(typeof stillSuperseded.superseded_at,'number');assert.equal('revoke_reason' in stillSuperseded,false)
		await assert.rejects(()=>mutateBabyCertificate(env,9,'c','reissue',{reason:'再次补发',operation_id:crypto.randomUUID()}),(error:unknown)=>error instanceof BabyVerificationError&&error.code==='certificate_conflict')
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_badges WHERE user_id=1 AND badge_key='verified'").get()?.count,0)
	}finally{db.close()}
})

test('credential tokens are 256-bit, database stores only hashes, and old codes become superseded',async()=>{
	const db=database();const env={abdl_space_db:d1(db),BABY_VERIFICATION_TOKEN_KEY:'test-token-key'} as never
	try{
			db.prepare("INSERT INTO users(id,email,password_hash,username,role) VALUES(9,'admin2@example.test','hash','admin2','admin')").run()
			db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','无需折角','正中间','认证甲',9999999999,1)").run()
			db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at,decided_by,decided_at) VALUES('a',1,'s','approved','encrypted-qq-value-long-enough-111',1,'v1',1,1,9,2)").run()
			db.prepare("INSERT INTO baby_verification_certificates(id,user_id,application_id,status,issued_at,current_credential_id) VALUES('c',1,'a','active',1,'g1')").run()
		const token=await deriveBabyCredentialToken(env,'g1');assert.equal(token.length,43)
		const cryptoMod=await import('node:crypto');const hash=cryptoMod.createHash('sha256').update(`abdl-space:baby-verification:public-credential:v1\0${token}`).digest('hex')
		db.prepare("INSERT INTO baby_verification_credentials(id,certificate_id,generation,token_hash,status,issued_at) VALUES('g1','c',1,?,'active',1)").run(hash)
		assert.equal((await verifyBabyCredential(env,token)).valid,true)
		db.prepare("UPDATE baby_verification_credentials SET status='superseded',superseded_at=2 WHERE id='g1'").run()
		assert.deepEqual(await verifyBabyCredential(env,token),{valid:false,status:'superseded',superseded:true,superseded_at:2})
		assert.equal(db.prepare("SELECT instr(token_hash,?) AS leaked FROM baby_verification_credentials WHERE id='g1'").get(token)?.leaked,0)
	}finally{db.close()}
})
