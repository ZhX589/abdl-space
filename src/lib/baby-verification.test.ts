import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { claimBabyApplication, decideBabyApplication, deriveBabyCredentialToken, mutateBabyCertificate, releaseBabyApplication, validateBabyVerificationConfig, verifyBabyCredential } from './baby-verification.ts'

function database(): DatabaseSync {
	const db=new DatabaseSync(':memory:')
	db.exec('PRAGMA foreign_keys=ON')
	db.exec(readFileSync(new URL('../../schemas/schema.sql',import.meta.url),'utf8'))
	db.exec(readFileSync(new URL('../../migrations/0025_account_system_upgrade.sql',import.meta.url),'utf8'))
	db.exec(readFileSync(new URL('../../migrations/0058_badge_colors_notification.sql',import.meta.url),'utf8'))
	db.exec(readFileSync(new URL('../../migrations/0062_sponsors.sql',import.meta.url),'utf8'))
	db.prepare("INSERT INTO users(id,email,password_hash,username) VALUES(1,'one@example.test','hash','one'),(2,'two@example.test','hash','two')").run()
	return db
}

function d1(db:DatabaseSync){const statement=(sql:string,params:unknown[]=[]):D1PreparedStatement=>({bind:(...next:unknown[])=>statement(sql,next),first:async<T>()=>(db.prepare(sql).get(...params)??null) as T|null,run:async()=>{const r=db.prepare(sql).run(...params);return{success:true,meta:{changes:Number(r.changes)}} as D1Result},all:async<T>()=>({success:true,results:db.prepare(sql).all(...params) as T[]}) as D1Result<T>,raw:async()=>[],columnNames:async()=>[]} as unknown as D1PreparedStatement);return{prepare:(sql:string)=>statement(sql),batch:async(items:D1PreparedStatement[])=>{db.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());db.exec('COMMIT');return results}catch(error){db.exec('ROLLBACK');throw error}}}}

test('complete schema and migration 0065 are independently repeatable',()=>{
	const complete=new DatabaseSync(':memory:')
	const migrated=new DatabaseSync(':memory:')
	try{
		const schema=readFileSync(new URL('../../schemas/schema.sql',import.meta.url),'utf8')
		complete.exec(schema);complete.exec(schema)
		migrated.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE notifications(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL);CREATE TABLE badges(id INTEGER PRIMARY KEY,key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,icon TEXT NOT NULL,description TEXT NOT NULL,condition_type TEXT NOT NULL,condition_value INTEGER NOT NULL);`)
		const migration=readFileSync(new URL('../../migrations/0065_baby_verification.sql',import.meta.url),'utf8')
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
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s1',1,'completed','n',1,'正方形','白色','无需折角','正中间','认证甲',9999999999,1),('s2',1,'completed','n2',1,'圆形','浅蓝色','折起左上角','左上角','认证乙',9999999999,1)").run()
		db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at) VALUES('a1',1,'s1','submitted','encrypted-qq-value-long-enough-111',1,'v1',1,1)").run()
		assert.throws(()=>db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at) VALUES('a2',1,'s2','reviewing','encrypted-qq-value-long-enough-222',1,'v1',1,1)").run(),/UNIQUE/)
			assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baby_verification_applications WHERE user_id=1 AND submitted_at IS NOT NULL").get()?.count,1)
	}finally{db.close()}
})

test('capture session conditional completion is idempotent and cannot complete an expired session',()=>{
	const db=database()
	try{
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('live',1,'active','n',1,'正方形','白色','无需折角','正中间','认证甲',unixepoch()+60,NULL),('expired',1,'active','x',1,'圆形','浅蓝色','无需折角','右侧','认证乙',1,NULL)").run()
			const complete=db.prepare("UPDATE baby_verification_capture_sessions SET status='completed',completed_at=unixepoch() WHERE id=? AND user_id=? AND status='active' AND expires_at>unixepoch()")
		assert.equal(complete.run('live',1).changes,1);assert.equal(complete.run('live',1).changes,0);assert.equal(complete.run('expired',1).changes,0)
	}finally{db.close()}
})

test('evidence is application-bound, server-keyed and unique per kind',()=>{
	const db=database()
	try{
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','白色','无需折角','正中间','认证甲',9999999999,1)").run()
			db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at) VALUES('a',1,'s','draft','encrypted-qq-value-long-enough-111',1,'v1',1)").run()
			db.prepare("INSERT INTO baby_verification_evidence(id,application_id,user_id,kind,mime_type,object_key,declared_size,content_sha256,content_md5,status,upload_expires_at,verified_size,completed_at) VALUES('e','a',1,'capture_photo','image/jpeg','baby-verification/private/1/a/e.jpg',1,?,'kAFQmDzST7DWlj99KOF/cg==','ready',9999999999,1,1)").run('a'.repeat(64))
			assert.throws(()=>db.prepare("INSERT INTO baby_verification_evidence(id,application_id,user_id,kind,mime_type,object_key,declared_size,content_sha256,content_md5,status,upload_expires_at) VALUES('e2','a',1,'capture_photo','image/jpeg','other',1,?,'kAFQmDzST7DWlj99KOF/cg==','pending',9)").run('b'.repeat(64)),/UNIQUE/)
	}finally{db.close()}
})

test('admin claim/release/approval is conditional, atomic and idempotent',async()=>{
	const db=database();const env={abdl_space_db:d1(db),BABY_VERIFICATION_TOKEN_KEY:'test-token-key'} as never
	try{
		db.prepare("INSERT INTO users(id,email,password_hash,username,role) VALUES(9,'admin@example.test','hash','admin','admin')").run()
		db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','白色','无需折角','正中间','认证甲',9999999999,1)").run()
		db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at) VALUES('a',1,'s','submitted','encrypted-qq-value-long-enough-111',1,'v1',1,1)").run()
		assert.equal((await claimBabyApplication(env,9,'a')).status,'reviewing')
		assert.equal((await claimBabyApplication(env,9,'a')).status,'reviewing')
		await releaseBabyApplication(env,9,'a');await claimBabyApplication(env,9,'a')
		const operation=crypto.randomUUID();const approved=await decideBabyApplication(env,9,'a',{decision:'approve',note:'资料一致',operation_id:operation})
			assert.equal(approved.body.status,'approved');assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baby_verification_certificates").get()?.count,1);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_badges WHERE badge_key='verified'").get()?.count,1);assert.equal(db.prepare("SELECT target_path FROM baby_verification_notification_details").get()?.target_path,'/settings/baby-verification')
			const replay=await decideBabyApplication(env,9,'a',{decision:'approve',note:'资料一致',operation_id:operation});assert.deepEqual(replay.body,approved.body);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baby_verification_certificates").get()?.count,1);assert.equal(String(db.prepare("SELECT response_body FROM baby_verification_operations WHERE operation_id=?").get(operation)?.response_body).includes(String(approved.body.verification_token)),false)
	}finally{db.close()}
})

test('certificate revoke and reissue preserve old credential states',async()=>{
	const db=database();const env={abdl_space_db:d1(db),BABY_VERIFICATION_TOKEN_KEY:'test-token-key'} as never
	try{
		db.prepare("INSERT INTO users(id,email,password_hash,username,role) VALUES(9,'admin@example.test','hash','admin','admin')").run();db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','白色','无需折角','正中间','认证甲',9999999999,1)").run();db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at,decided_by,decided_at) VALUES('a',1,'s','approved','encrypted-qq-value-long-enough-111',1,'v1',1,1,9,2)").run()
		const oldToken=await deriveBabyCredentialToken(env,'g1');const cryptoMod=await import('node:crypto');const hash=cryptoMod.createHash('sha256').update(`abdl-space:baby-verification:public-credential:v1\0${oldToken}`).digest('hex')
			db.prepare("INSERT INTO baby_verification_certificates(id,user_id,application_id,status,issued_at,current_credential_id) VALUES('c',1,'a','active',1,'g1')").run();db.prepare("INSERT INTO baby_verification_credentials(id,certificate_id,generation,token_hash,status,issued_at) VALUES('g1','c',1,?,'active',1)").run(hash);db.prepare("INSERT INTO user_badges(user_id,badge_key) VALUES(1,'verified')").run();db.prepare("INSERT INTO baby_verification_badge_sources(certificate_id,user_id,badge_key,preserved_existing_badge) VALUES('c',1,'verified',0)").run()
			const reissueOperation=crypto.randomUUID();const reissued=await mutateBabyCertificate(env,9,'c','reissue',{reason:'二维码遗失',operation_id:reissueOperation});assert.equal(reissued.generation,2);assert.equal((await verifyBabyCredential(env,oldToken)).status,'superseded');const replay=await mutateBabyCertificate(env,9,'c','reissue',{reason:'二维码遗失',operation_id:reissueOperation});assert.deepEqual(replay,reissued);assert.equal(String(db.prepare("SELECT response_body FROM baby_verification_operations WHERE operation_id=?").get(reissueOperation)?.response_body).includes(String(reissued.verification_token)),false)
		await mutateBabyCertificate(env,9,'c','revoke',{reason:'认证失效',operation_id:crypto.randomUUID()});assert.equal(db.prepare("SELECT status FROM baby_verification_certificates WHERE id='c'").get()?.status,'revoked');assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_badges WHERE user_id=1 AND badge_key='verified'").get()?.count,0)
	}finally{db.close()}
})

test('credential tokens are 256-bit, database stores only hashes, and old codes become superseded',async()=>{
	const db=database();const env={abdl_space_db:d1(db),BABY_VERIFICATION_TOKEN_KEY:'test-token-key'} as never
	try{
			db.prepare("INSERT INTO users(id,email,password_hash,username,role) VALUES(9,'admin2@example.test','hash','admin2','admin')").run()
			db.prepare("INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at) VALUES('s',1,'completed','n',1,'正方形','白色','无需折角','正中间','认证甲',9999999999,1)").run()
			db.prepare("INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at,decided_by,decided_at) VALUES('a',1,'s','approved','encrypted-qq-value-long-enough-111',1,'v1',1,1,9,2)").run()
			db.prepare("INSERT INTO baby_verification_certificates(id,user_id,application_id,status,issued_at,current_credential_id) VALUES('c',1,'a','active',1,'g1')").run()
		const token=await deriveBabyCredentialToken(env,'g1');assert.equal(token.length,43)
		const cryptoMod=await import('node:crypto');const hash=cryptoMod.createHash('sha256').update(`abdl-space:baby-verification:public-credential:v1\0${token}`).digest('hex')
		db.prepare("INSERT INTO baby_verification_credentials(id,certificate_id,generation,token_hash,status,issued_at) VALUES('g1','c',1,?,'active',1)").run(hash)
		assert.equal((await verifyBabyCredential(env,token)).valid,true)
		db.prepare("UPDATE baby_verification_credentials SET status='superseded',superseded_at=2 WHERE id='g1'").run()
		assert.deepEqual(await verifyBabyCredential(env,token),{valid:false,status:'superseded',superseded:true})
		assert.equal(db.prepare("SELECT instr(token_hash,?) AS leaked FROM baby_verification_credentials WHERE id='g1'").get(token)?.leaked,0)
	}finally{db.close()}
})
