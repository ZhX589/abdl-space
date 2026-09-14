import { Hono } from 'hono'
import type { Env } from '../types/index.ts'

const square=new Hono<{Bindings:Env}>()
function limit(value:string|undefined){const n=Number(value??20);return Number.isSafeInteger(n)&&n>=1&&n<=50?n:null}

square.get('/works',async c=>{
  const take=limit(c.req.query('limit'));if(take===null)return c.json({error:'Invalid limit',code:'invalid_request'},400)
  const q=(c.req.query('query')??'').trim();if(q.length>100)return c.json({error:'Query too long',code:'invalid_request'},400)
  const category=(c.req.query('category')??'').trim();const rating=(c.req.query('rating')??'').trim();const cursor=(c.req.query('cursor')??'').trim();const where=[];const args:(string|number)[]=[]
  if(q){where.push('(r.title LIKE ? ESCAPE \'\\\' OR r.description LIKE ? ESCAPE \'\\\')');const pattern=`%${q.replace(/[\\%_]/g,v=>`\\${v}`)}%`;args.push(pattern,pattern)}
  if(category){where.push('r.category=?');args.push(category)}if(rating){where.push('r.declared_rating=?');args.push(rating)}
  if(cursor){const [time,id]=cursor.split(':',2);if(!/^\d+$/.test(time)||!id)return c.json({error:'Invalid cursor',code:'invalid_request'},400);where.push('(r.published_at<? OR (r.published_at=? AND r.id<?))');args.push(Number(time),Number(time),id)}
  const rows=await c.env.abdl_space_db.prepare(`SELECT r.id release_id,r.novel_id id,r.title,r.description,r.category,r.declared_rating,r.content_warning,r.published_at,r.release_version,
    u.id author_id,u.username,u.avatar,(SELECT COUNT(*) FROM novel_v2_release_chapters c WHERE c.release_id=r.id) chapter_count
    FROM novel_v2_current_releases current JOIN novel_v2_releases r ON r.id=current.release_id JOIN users u ON u.id=r.owner_id
    ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY r.published_at DESC,r.id DESC LIMIT ?`).bind(...args,take+1).all<Record<string,unknown>>()
  const items=rows.results.slice(0,take).map(row=>({id:row.id,release_id:row.release_id,title:row.title,description:row.description,category:row.category,declared_rating:row.declared_rating,content_warning:row.content_warning,published_at:row.published_at,release_version:row.release_version,published_chapter_count:row.chapter_count,author:{id:row.author_id,username:row.username,avatar:row.avatar??'',url:`https://abdl-space.top/profile/${row.author_id}`}}))
  const last=rows.results.length>take?rows.results[take-1]:null;return c.json({items,next_cursor:last?`${last.published_at}:${last.release_id}`:null})
})

square.get('/works/:workId',async c=>{
  const release=c.req.query('release_id');const args=[c.req.param('workId')];let extra='';if(release){extra=' AND r.id=?';args.push(release)}
  const row=await c.env.abdl_space_db.prepare(`SELECT r.*,u.username,u.avatar FROM novel_v2_current_releases current JOIN novel_v2_releases r ON r.id=current.release_id JOIN users u ON u.id=r.owner_id WHERE r.novel_id=?${extra}`).bind(...args).first<Record<string,unknown>>()
  if(!row)return c.json({error:'Work not found',code:'not_found'},404)
  const volumes=await c.env.abdl_space_db.prepare('SELECT client_volume_id id,title,sort_order FROM novel_v2_release_volumes WHERE release_id=? ORDER BY sort_order,client_volume_id').bind(row.id).all<Record<string,unknown>>()
  const chapters=await c.env.abdl_space_db.prepare('SELECT client_chapter_id id,client_volume_id volume_id,title,sort_order,generation,body_sha256 FROM novel_v2_release_chapters WHERE release_id=? ORDER BY client_volume_id,sort_order,client_chapter_id').bind(row.id).all<Record<string,unknown>>()
  return c.json({id:row.novel_id,release_id:row.id,release_version:row.release_version,title:row.title,description:row.description,category:row.category,declared_rating:row.declared_rating,content_warning:row.content_warning,published_at:row.published_at,author:{id:row.owner_id,username:row.username,avatar:row.avatar??'',url:`https://abdl-space.top/profile/${row.owner_id}`},volumes:volumes.results.map(v=>({...v,chapters:chapters.results.filter(ch=>ch.volume_id===v.id)}))})
})

square.get('/works/:workId/chapters/:chapterId',async c=>{
  const release=c.req.query('release_id');if(!release)return c.json({error:'release_id is required',code:'invalid_request'},400)
  const current=await c.env.abdl_space_db.prepare('SELECT release_id FROM novel_v2_current_releases WHERE novel_id=?').bind(c.req.param('workId')).first<{release_id:string}>();if(!current)return c.json({error:'Work not found',code:'not_found'},404);if(current.release_id!==release)return c.json({error:'Release changed',code:'release_changed',release_id:current.release_id},409)
  const chapter=await c.env.abdl_space_db.prepare('SELECT client_chapter_id id,title,generation,body,body_sha256 FROM novel_v2_release_chapters WHERE release_id=? AND client_chapter_id=?').bind(release,c.req.param('chapterId')).first();return chapter?c.json({...chapter,release_id:release}):c.json({error:'Chapter not found',code:'not_found'},404)
})

export default square
