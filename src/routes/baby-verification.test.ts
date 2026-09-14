import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import babyVerification from './baby-verification.ts'

function database(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(readFileSync(new URL('../../schemas/schema.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../../migrations/0025_account_system_upgrade.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../../migrations/0058_badge_colors_notification.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../../migrations/0062_sponsors.sql',import.meta.url),'utf8'));return db}
function d1(db:DatabaseSync){const statement=(sql:string,params:unknown[]=[]):Record<string,unknown>=>({bind:(...next:unknown[])=>statement(sql,next),first:async()=>db.prepare(sql).get(...params)??null,all:async()=>({success:true,results:db.prepare(sql).all(...params)}),run:async()=>{const r=db.prepare(sql).run(...params);return{success:true,meta:{changes:Number(r.changes)}}}});return{prepare:(sql:string)=>statement(sql),batch:async(items:Array<{run:()=>Promise<unknown>}>)=>Promise.all(items.map(item=>item.run()))}}

test('public verify response is no-store, no-referrer and noindex',async()=>{
	const db=database();const app=new Hono();app.route('/api/v1/baby-verification',babyVerification)
	try{
		const response=await app.request('/api/v1/baby-verification/verify/not-a-token',{}, {abdl_space_db:d1(db)} as never)
		assert.equal(response.status,200);assert.match(response.headers.get('cache-control')??'',/no-store/);assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('x-robots-tag')??'',/noindex/);assert.deepEqual(await response.json(),{valid:false,status:'unknown'})
	}finally{db.close()}
})
