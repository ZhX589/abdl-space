import type { Context, Next } from 'hono'
import { assertSessionNotStale } from '../middleware/auth.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import type { Env, JWTPayload, PublicSponsor, SponsorConfig, SponsorMe, SponsorPlan } from '../types/index.ts'

export type SponsorAppType = { Bindings: Env; Variables: { user: JWTPayload } }
export type SponsorEnv = Pick<Env, 'abdl_space_db' | 'SPONSOR_CODE_KEY'>
type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 503

/** Safe business error; internal SQL/crypto errors never enter responses or logs. */
export class SponsorError extends Error {
  code: string
  status: ErrorStatus
  details: Record<string, unknown>
  constructor(code: string, message: string, status: ErrorStatus = 422, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

const ERROR_MESSAGES: Record<string, [ErrorStatus, string]> = {
  sponsors_disabled: [503, '赞助者功能暂未开放'], sponsors_unavailable: [503, '赞助者服务暂不可用，请稍后重试'],
  already_permanent: [409, '您已是永久赞助者，无需再次兑换'], code_unavailable: [409, '兑换码无效、已使用、已停用或已过期'],
  plan_changed: [409, '赞助方案已变更，请刷新后重试'], sponsor_required: [403, '此操作需要有效的赞助者身份'],
  invalid_color: [422, '该颜色不可选择'], benefit_unavailable: [409, '该权益尚未开放领取'],
  notice_required: [409, '请阅读并确认当前原图须知'], quota_exhausted: [402, '今日原图额度已用完'],
  invalid_adjustment: [422, '额度调整超出允许范围'], operation_expired: [409, '本次授权已过期，请重新发起操作'],
}

/** Convert exceptions to the contract error envelope, without exposing implementation details. */
export function sponsorErrorResponse(error: unknown, c: Context<SponsorAppType>): Response {
  const safe = error instanceof SponsorError ? error : new SponsorError('sponsors_unavailable', '赞助者服务暂不可用，请稍后重试', 503)
  c.header('Cache-Control', 'private, no-store')
  return c.json({ error: safe.message, code: safe.code, ...safe.details }, safe.status)
}

/** Require a plain object instead of trusting a typed JSON cast. */
export function sponsorObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SponsorError('invalid_request', '请求格式不正确')
  return value as Record<string, unknown>
}

/** Validate bounded text; no truncation or silent normalization of identifiers. */
export function sponsorText(value: unknown, label: string, max = 200, allowEmpty = false): string {
  // eslint-disable-next-line no-control-regex -- 校验文本必须拒绝控制字符
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new SponsorError('invalid_request', `${label}格式不正确`)
  }
  return value.trim()
}

/** Validate a finite integer within the supported domain. */
export function sponsorInteger(value: unknown, min: number, max: number, label = '数值'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new SponsorError('invalid_request', `${label}超出允许范围`)
  return value
}

/** All client-generated operation ids are UUIDs; each is scoped to actor and action. */
export function sponsorOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new SponsorError('invalid_request', 'operation_id 必须为 UUID')
  return value.toLowerCase()
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SponsorError('invalid_request', '开关必须为布尔值')
  return value
}
function identifier(value: unknown): string {
  const id = sponsorText(value, '标识', 64)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new SponsorError('invalid_request', '标识格式不正确')
  return id
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new SponsorError('invalid_request', '标识不能重复')
}

/** Validate every catalog setting, including placeholders and only implemented benefit actions. */
export function validateSponsorConfig(input: unknown): SponsorConfig {
  const c = sponsorObject(input)
  const text = (key: string, max = 3000) => sponsorText(c[key], key, max)
  const template = (key: string) => {
    const value = text(key)
    if (value.replace(/\{(?:x|y|a|reset)\}/g, '').match(/[{}]/)) throw new SponsorError('invalid_request', '通知包含不支持的占位符')
    return value
  }
  if (c.timezone !== 'Asia/Shanghai') throw new SponsorError('invalid_request', '时区必须为 Asia/Shanghai')
  if (!Array.isArray(c.colors) || c.colors.length < 1 || c.colors.length > 20 || !Array.isArray(c.benefits) || c.benefits.length > 30 || !Array.isArray(c.purchase_steps) || c.purchase_steps.length < 1 || c.purchase_steps.length > 20) throw new SponsorError('invalid_request', '颜色、权益或购买步骤格式不正确')
  const colors = c.colors.map(value => {
    const color = sponsorObject(value)
    const light = sponsorText(color.light, '浅色主题颜色', 7)
    const dark = sponsorText(color.dark, '深色主题颜色', 7)
    if (!/^#[0-9a-f]{6}$/i.test(light) || !/^#[0-9a-f]{6}$/i.test(dark)) throw new SponsorError('invalid_request', '颜色必须为 #RRGGBB')
    return { key: identifier(color.key), name: sponsorText(color.name, '颜色名称', 40), light, dark, permanent_only: boolean(color.permanent_only) }
  })
  const benefits = c.benefits.map(value => {
    const b = sponsorObject(value)
    if (!['automatic', 'available', 'coming_soon'].includes(String(b.status)) || !['none', 'color', 'original', 'claim'].includes(String(b.action))) throw new SponsorError('invalid_request', '权益状态或动作不受支持')
    if ((b.status === 'coming_soon' && b.action !== 'none') || (b.action === 'claim' && b.status !== 'available') || (b.action === 'original' && b.status !== 'automatic') || (b.action === 'color' && b.status !== 'available')) throw new SponsorError('invalid_request', '权益状态与动作不匹配')
    return { id: identifier(b.id), title: sponsorText(b.title, '权益名称', 80), description: sponsorText(b.description, '权益说明', 1000, true), status: b.status as SponsorConfig['benefits'][number]['status'], action: b.action as SponsorConfig['benefits'][number]['action'], sort_order: sponsorInteger(b.sort_order, -10000, 10000) }
  })
  unique(colors.map(v => v.key)); unique(benefits.map(v => v.id))
  const defaultColor = identifier(c.default_color_key)
  if (!colors.some(v => v.key === defaultColor && !v.permanent_only)) throw new SponsorError('invalid_request', '默认颜色必须允许普通赞助者使用')
  if (!colors.some(v => v.permanent_only)) throw new SponsorError('invalid_request', '必须至少配置一种永久赞助者专属颜色')
  const free = sponsorInteger(c.free_daily_limit, 0, 100000)
  const paid = sponsorInteger(c.sponsor_daily_limit, free, 100000)
  return { enabled: boolean(c.enabled), version: sponsorInteger(c.version, 1, 2147483647), center_title: text('center_title', 100), free_daily_limit: free, sponsor_daily_limit: paid, timezone: 'Asia/Shanghai', notice_version: sponsorInteger(c.notice_version, 1, 2147483647), notice_title: text('notice_title', 100), notice_body: template('notice_body'), exhausted_title: text('exhausted_title', 100), exhausted_body: template('exhausted_body'), sponsor_exhausted_body: template('sponsor_exhausted_body'), purchase_title: text('purchase_title', 100), purchase_steps: c.purchase_steps.map(v => sponsorText(v, '购买步骤', 1000)), minimum_read_seconds: sponsorInteger(c.minimum_read_seconds, 5, 300), default_color_key: defaultColor, colors, benefits }
}

/** Validate dynamically configured plans; purchase links must match their SKU mapping. */
export function validateSponsorPlan(input: unknown): SponsorPlan {
  const p = sponsorObject(input)
  if (!['day', 'month', 'permanent'].includes(String(p.duration_unit)) || p.currency !== 'CNY') throw new SponsorError('invalid_request', '期限单位或币种不受支持')
  const unit = p.duration_unit as SponsorPlan['duration_unit']
  const count = sponsorInteger(p.duration_count, unit === 'permanent' ? 0 : 1, unit === 'permanent' ? 0 : unit === 'month' ? 120 : 3650)
  const purchase = sponsorText(p.purchase_url, '购买链接', 2000, true)
  const planId = sponsorText(p.afdian_plan_id, '爱发电方案', 64, true)
  const skuId = sponsorText(p.afdian_sku_id, '爱发电规格', 64, true)
  if (purchase) {
    try {
      const url = new URL(purchase)
      const sku = JSON.parse(url.searchParams.get('sku') || 'null')
      if (url.origin !== 'https://ifdian.net' || url.pathname !== '/order/create' || url.username || url.password || url.hash || url.searchParams.get('plan_id') !== planId || !/^[0-9a-f]{32}$/i.test(planId) || !/^[0-9a-f]{32}$/i.test(skuId) || url.searchParams.get('product_type') !== '1' || !Array.isArray(sku) || sku.length !== 1 || sku[0]?.sku_id !== skuId || sku[0]?.count !== 1) throw new Error('invalid')
    } catch { throw new SponsorError('invalid_request', '购买链接必须与爱发电方案及规格一致') }
  } else if (planId || skuId) throw new SponsorError('invalid_request', '爱发电映射必须同时提供购买链接')
  return { id: identifier(p.id), version: sponsorInteger(p.version, 1, 2147483647), name: sponsorText(p.name, '方案名称', 100), description: sponsorText(p.description, '方案说明', 2000, true), price_minor: sponsorInteger(p.price_minor, 0, 100000000), currency: 'CNY', duration_unit: unit, duration_count: count, purchase_url: purchase, afdian_plan_id: planId, afdian_sku_id: skuId, enabled: boolean(p.enabled), sort_order: sponsorInteger(p.sort_order, -10000, 10000) }
}

/** Read the singleton without hardcoded fallback; missing migrations fail closed. */
export async function getSponsorConfig(env: SponsorEnv): Promise<SponsorConfig> {
  const row = await env.abdl_space_db.prepare('SELECT version,config_json FROM sponsor_settings WHERE id=1').first<{ version: number; config_json: string }>()
  if (!row) throw new SponsorError('sponsors_unavailable', '赞助者配置不可用', 503)
  return validateSponsorConfig({ ...JSON.parse(row.config_json), version: row.version })
}

/** Stock and core share the exact same dynamic plan source. */
export async function getSponsorPlan(env: SponsorEnv, planId: string): Promise<SponsorPlan | null> {
  const row = await env.abdl_space_db.prepare('SELECT plan_json FROM sponsor_plans WHERE id=?').bind(planId).first<{ plan_json: string }>()
  return row ? validateSponsorPlan(JSON.parse(row.plan_json)) : null
}

/** Return persisted current identity/quota state, including expiry-aware colors. */
export async function getSponsorMe(env: SponsorEnv, userId: number): Promise<SponsorMe> {
  const row = await env.abdl_space_db.prepare('SELECT result_json FROM sponsor_me_json WHERE user_id=?').bind(userId).first<{ result_json: string }>()
  if (!row) throw new SponsorError('not_found', '用户或赞助者配置不存在', 404)
  return JSON.parse(row.result_json) as SponsorMe
}

/** Shared durable audit for external stock modules. Never include credentials or raw codes. */
export async function recordSponsorAudit(env: SponsorEnv, input: { actorId: string | null; userId: string | null; action: string; reason: string }): Promise<void> {
  const action = sponsorText(input.action, '审计动作', 100)
  const reason = sponsorText(input.reason, '操作原因', 500)
  await env.abdl_space_db.prepare('INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), input.actorId, input.userId, action, reason).run()
}

/** Digest only bounded server-normalized payloads; never log them. */
export async function sponsorHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('')
}

function encode64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)) }
function decode64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) }
async function codeKey(env: SponsorEnv) {
  try {
    if (!env.SPONSOR_CODE_KEY || !/^[A-Za-z0-9+/]{43}=$/.test(env.SPONSOR_CODE_KEY)) throw new Error('missing')
    const key = decode64(env.SPONSOR_CODE_KEY)
    if (key.byteLength !== 32) throw new Error('invalid')
    return await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } catch { throw new SponsorError('code_key_unavailable', '兑换码加密密钥未配置或无效', 503) }
}

/** Atomically generate a batch of encrypted single-use codes, snapshotted to its plan. */
export async function createSponsorCodeBatch(env: SponsorEnv, input: { planId: string; count: number; expiresAt: number | null; operationId: string; reason: string; actorId: string | null; source: 'afdian' | 'admin' }): Promise<{ id: string; count: number }> {
  const operationId = sponsorOperationId(input.operationId)
  const count = sponsorInteger(input.count, 1, 200)
  const reason = sponsorText(input.reason, '操作原因', 500)
  const planId = identifier(input.planId)
  if (!['afdian', 'admin'].includes(input.source)) throw new SponsorError('invalid_request', '兑换码来源不正确')
  const expiresAt = input.expiresAt == null ? null : sponsorInteger(input.expiresAt, 1, 253402300799)
  const operation = `${input.source}:${input.actorId ?? 'system'}:${operationId}`
  const hash = await sponsorHash(JSON.stringify([planId, count, expiresAt, reason]))
  const prior = await env.abdl_space_db.prepare('SELECT id,count,request_hash FROM sponsor_code_batches WHERE operation_id=?').bind(operation).first<{ id: string; count: number; request_hash: string }>()
  if (prior) {
    if (prior.request_hash !== hash) throw new SponsorError('idempotency_conflict', '该操作编号已用于不同请求', 409)
    return { id: prior.id, count: prior.count }
  }
  const key = await codeKey(env)
  const config = await getSponsorConfig(env)
  if (!config.enabled) throw new SponsorError('sponsors_disabled', '赞助者功能暂未开放', 503)
  const planRow = await env.abdl_space_db.prepare('SELECT plan_json FROM sponsor_plans WHERE id=? AND enabled=1').bind(planId).first<{ plan_json: string }>()
  if (!planRow) throw new SponsorError('not_found', '赞助方案不存在或已停用', 404)
  if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) throw new SponsorError('invalid_request', '兑换码过期时间必须在未来')
  const batchId = crypto.randomUUID()
  const statements = [env.abdl_space_db.prepare(`INSERT INTO sponsor_code_batches(id,operation_id,request_hash,plan_id,count,source,actor_id)
    SELECT ?,?,?,?,?,?,? FROM sponsor_plans p,sponsor_settings s WHERE p.id=? AND p.enabled=1 AND p.plan_json=? AND s.id=1 AND json_extract(s.config_json,'$.enabled')=1
    ON CONFLICT(operation_id) DO NOTHING`).bind(batchId, operation, hash, planId, count, input.source, input.actorId, planId, planRow.plan_json)]
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID()
    const raw = `ABDL-${Array.from(crypto.getRandomValues(new Uint8Array(20)), n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${batchId}:${id}`) }, key, new TextEncoder().encode(raw))
    const encrypted = `${encode64(iv)}.${encode64(new Uint8Array(ciphertext))}`
    statements.push(env.abdl_space_db.prepare(`INSERT INTO sponsor_codes(id,batch_id,plan_id,snapshot_json,code_hash,masked_code,encrypted_code,expires_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sponsor_code_batches WHERE id=?)`).bind(id, batchId, planId, planRow.plan_json, await sponsorHash(raw), `ABDL-••••-${raw.slice(-4)}`, encrypted, expiresAt, batchId))
  }
  statements.push(env.abdl_space_db.prepare(`INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason)
    SELECT ?,?,NULL,'code_batch_create',? WHERE EXISTS(SELECT 1 FROM sponsor_code_batches WHERE id=?)`).bind(crypto.randomUUID(), input.actorId, reason, batchId))
  // D1 batch is a single write transaction; encryption happens before taking the lock.
  await env.abdl_space_db.batch(statements)
  const batch = await env.abdl_space_db.prepare('SELECT id,count,request_hash FROM sponsor_code_batches WHERE operation_id=?').bind(operation).first<{ id: string; count: number; request_hash: string }>()
  if (!batch) throw new SponsorError('plan_changed', '配置或方案已变更，请刷新重试', 409)
  if (batch.request_hash !== hash) throw new SponsorError('idempotency_conflict', '该操作编号已用于不同请求', 409)
  return { id: batch.id, count: batch.count }
}

/** Decrypt a complete batch for trusted audited exports/stock integration only. */
export async function exportSponsorCodeBatch(env: SponsorEnv, batchId: string): Promise<string[]> {
  const key = await codeKey(env)
  const batch = await env.abdl_space_db.prepare('SELECT count FROM sponsor_code_batches WHERE id=?').bind(batchId).first<{ count: number }>()
  if (!batch) throw new SponsorError('not_found', '兑换码批次不存在', 404)
  const rows = await env.abdl_space_db.prepare('SELECT id,encrypted_code FROM sponsor_codes WHERE batch_id=? ORDER BY id').bind(batchId).all<{ id: string; encrypted_code: string }>()
  if (rows.results.length !== batch.count) throw new SponsorError('batch_incomplete', '兑换码批次不完整', 503)
  try {
    return await Promise.all(rows.results.map(async row => {
      const [iv, data] = row.encrypted_code.split('.')
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(iv), additionalData: new TextEncoder().encode(`${batchId}:${row.id}`) }, key, decode64(data))
      return new TextDecoder().decode(plaintext)
    }))
  } catch { throw new SponsorError('code_key_unavailable', '兑换码解密失败，请检查密钥配置', 503) }
}

type OperationKind = 'redeem' | 'grant' | 'revoke' | 'quota' | 'claim' | 'original' | 'color'
interface OperationInput {
  kind: OperationKind; userId: number; actorId: string; operationId: string; reason: string; payload: unknown
  codeId?: string; planJson?: string; benefitId?: string; colorKey?: string; mediaKey?: string; noticeVersion?: number; adjustment?: number
}

async function storedOperation(env: SponsorEnv, id: string, hash: string): Promise<{ me: SponsorMe; replayed: boolean } | null> {
  const row = await env.abdl_space_db.prepare('SELECT request_hash,result_json,kind,day_key FROM sponsor_operations WHERE id=?').bind(id).first<{ request_hash: string; result_json: string; kind: string; day_key: string }>()
  if (!row) return null
  if (row.request_hash !== hash) throw new SponsorError('idempotency_conflict', '该操作编号已用于不同请求', 409)
  if (row.kind === 'original') {
    const day = await env.abdl_space_db.prepare("SELECT date('now','+8 hours') AS day").first<{ day: string }>()
    if (row.day_key !== day?.day) throw new SponsorError('operation_expired', '原图授权已过期，请重新发起', 409)
  }
  if (!row.result_json) throw new SponsorError('sponsors_unavailable', '操作结果暂不可用', 503)
  return { me: JSON.parse(row.result_json) as SponsorMe, replayed: true }
}

async function operate(env: SponsorEnv, input: OperationInput): Promise<{ me: SponsorMe; replayed: boolean }> {
  const id = `${input.actorId}:${input.kind}:${sponsorOperationId(input.operationId)}`
  const hash = await sponsorHash(JSON.stringify([input.userId, input.payload, input.reason]))
  const prior = await storedOperation(env, id, hash)
  if (prior) return prior
  try {
    const result = await env.abdl_space_db.prepare(`INSERT INTO sponsor_operations(id,operation_id,user_id,actor_id,kind,request_hash,reason,code_id,plan_json,benefit_id,color_key,media_key,notice_version,adjustment)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id, input.operationId, input.userId, input.actorId, input.kind, hash, sponsorText(input.reason, '操作原因', 500), input.codeId ?? null, input.planJson ?? null, input.benefitId ?? null, input.colorKey ?? null, input.mediaKey ?? null, input.noticeVersion ?? null, input.adjustment ?? null).run()
    const stored = await storedOperation(env, id, hash)
    if (!stored) throw new SponsorError('sponsors_unavailable', '操作结果暂不可用', 503)
    return { ...stored, replayed: result.meta.changes === 0 }
  } catch (error) {
    if (error instanceof SponsorError) throw error
    const text = error instanceof Error ? error.message : ''
    const code = Object.keys(ERROR_MESSAGES).find(key => new RegExp(`\\b${key}\\b`).test(text))
    if (!code) throw error
    const [status, message] = ERROR_MESSAGES[code]
    const details: Record<string, unknown> = {}
    if (code === 'quota_exhausted') details.quota = (await getSponsorMe(env, input.userId)).quota
    if (code === 'notice_required') details.notice_version = (await getSponsorConfig(env)).notice_version
    throw new SponsorError(code, message, status, details)
  }
}

/** Redeem exactly once. The DB trigger consumes the code and extends the current identity atomically. */
export async function redeemSponsorCode(env: SponsorEnv, userId: number, body: unknown): Promise<SponsorMe> {
  const b = sponsorObject(body)
  const raw = sponsorText(b.code, '兑换码', 100).toUpperCase().replace(/\s/g, '')
  const hash = await sponsorHash(raw)
  const operationId = sponsorOperationId(b.operation_id)
  const payload = [hash]
  const prior = await storedOperation(env, `${userId}:redeem:${operationId}`, await sponsorHash(JSON.stringify([userId, payload, '用户兑换'])))
  if (prior) return prior.me
  const code = await env.abdl_space_db.prepare('SELECT id,snapshot_json FROM sponsor_codes WHERE code_hash=?').bind(hash).first<{ id: string; snapshot_json: string }>()
  if (!code) throw new SponsorError('code_unavailable', '兑换码无效、已使用、已停用或已过期', 409)
  return (await operate(env, { kind: 'redeem', userId, actorId: String(userId), operationId, reason: '用户兑换', payload, codeId: code.id, planJson: code.snapshot_json })).me
}

/** Authorize a new original once; duplicate payloads replay only within the request's Shanghai day. */
export async function authorizeSponsorOriginal(env: SponsorEnv, userId: number, body: unknown): Promise<{ operation_id: string; quota: SponsorMe['quota']; replayed: boolean }> {
  const b = sponsorObject(body)
  const operationId = sponsorOperationId(b.operation_id)
  const mediaKey = sponsorText(b.media_key, '媒体标识', 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(mediaKey)) throw new SponsorError('invalid_request', 'media_key 必须为 SHA-256')
  const noticeVersion = b.notice_version == null ? undefined : sponsorInteger(b.notice_version, 1, 2147483647)
  // Notice is acknowledgement evidence, not authorization identity. A retry can omit it.
  const result = await operate(env, { kind: 'original', userId, actorId: String(userId), operationId, reason: '原图授权', payload: [mediaKey], mediaKey, noticeVersion })
  return { operation_id: operationId, quota: result.me.quota, replayed: result.replayed }
}

/** Select only a currently permitted server color. */
export async function setSponsorColor(env: SponsorEnv, userId: number, body: unknown): Promise<SponsorMe> {
  const colorKey = identifier(sponsorObject(body).color_key)
  return (await operate(env, { kind: 'color', userId, actorId: String(userId), operationId: crypto.randomUUID(), reason: '选择用户名颜色', payload: [colorKey], colorKey })).me
}

/** Persist one supported entitlement claim, never fake lottery fulfillment. */
export async function claimSponsorBenefit(env: SponsorEnv, userId: number, body: unknown): Promise<SponsorMe> {
  const b = sponsorObject(body)
  const benefitId = identifier(b.benefit_id)
  return (await operate(env, { kind: 'claim', userId, actorId: String(userId), operationId: sponsorOperationId(b.operation_id), reason: '领取赞助者权益', payload: [benefitId], benefitId })).me
}

/** Audited admin grants, revocations and today's bonus deltas. Revocation never deletes history. */
export async function mutateSponsorUser(env: SponsorEnv, actorId: number, userId: number, kind: 'grant' | 'revoke' | 'quota', body: unknown): Promise<SponsorMe> {
  const b = sponsorObject(body)
  const reason = sponsorText(b.reason, '操作原因', 500)
  const operationId = sponsorOperationId(b.operation_id)
  const planId = kind === 'grant' ? identifier(b.plan_id) : null
  const adjustment = kind === 'quota' ? sponsorInteger(b.adjustment, -100000, 100000) : undefined
  const payload = [planId, adjustment ?? null]
  const prior = await storedOperation(env, `${actorId}:${kind}:${operationId}`, await sponsorHash(JSON.stringify([userId, payload, reason])))
  if (prior) return prior.me
  const user = await env.abdl_space_db.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()
  if (!user) throw new SponsorError('not_found', '用户不存在', 404)
  const plan = planId ? await env.abdl_space_db.prepare('SELECT plan_json FROM sponsor_plans WHERE id=? AND enabled=1').bind(planId).first<{ plan_json: string }>() : null
  if (planId && !plan) throw new SponsorError('not_found', '赞助方案不存在或已停用', 404)
  return (await operate(env, { kind, userId, actorId: String(actorId), operationId, reason, payload, adjustment, planJson: plan?.plan_json })).me
}

/** Optimistic singleton update with audit committed in the same transaction. */
export async function updateSponsorConfig(env: SponsorEnv, actorId: number, body: unknown): Promise<SponsorConfig> {
  const b = sponsorObject(body)
  const expected = sponsorInteger(b.expected_version, 1, 2147483646)
  const config = validateSponsorConfig(b.config)
  const reason = sponsorText(b.reason, '操作原因', 500)
  const previous = await getSponsorConfig(env)
  if (config.version !== expected || previous.version !== expected) throw new SponsorError('version_conflict', '配置已被修改，请刷新后重试', 409)
  const noticeChanged = config.notice_title !== previous.notice_title || config.notice_body !== previous.notice_body || config.free_daily_limit !== previous.free_daily_limit || config.sponsor_daily_limit !== previous.sponsor_daily_limit
  if (config.notice_version < previous.notice_version || (noticeChanged && config.notice_version <= previous.notice_version)) throw new SponsorError('invalid_request', '须知或额度变更时必须增加 notice_version')
  const updated = { ...config, version: expected + 1 }
  const results = await env.abdl_space_db.batch([
    env.abdl_space_db.prepare('UPDATE sponsor_settings SET config_json=?,version=version+1 WHERE id=1 AND version=?').bind(JSON.stringify(updated), expected),
    env.abdl_space_db.prepare("INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) SELECT ?,?,NULL,'config_update',? WHERE changes()=1").bind(crypto.randomUUID(), String(actorId), reason),
  ])
  if (results[0].meta.changes !== 1) throw new SponsorError('version_conflict', '配置已被修改，请刷新后重试', 409)
  return updated
}

/** Create or archive/update a dynamic plan without rewriting existing code entitlements. */
export async function saveSponsorPlan(env: SponsorEnv, actorId: number, body: unknown, id?: string): Promise<SponsorPlan> {
  const b = sponsorObject(body)
  const plan = validateSponsorPlan(b.plan)
  const reason = sponsorText(b.reason, '操作原因', 500)
  const expected = id ? sponsorInteger(b.expected_version, 1, 2147483646) : 0
  if ((id && (id !== plan.id || expected !== plan.version)) || (!id && plan.version !== 1)) throw new SponsorError('invalid_request', '方案标识或版本不匹配')
  const updated = { ...plan, version: expected + 1 }
  const statement = id
    ? env.abdl_space_db.prepare('UPDATE sponsor_plans SET plan_json=?,version=version+1,enabled=?,sort_order=? WHERE id=? AND version=?').bind(JSON.stringify(updated), Number(plan.enabled), plan.sort_order, id, expected)
    : env.abdl_space_db.prepare('INSERT INTO sponsor_plans(id,version,enabled,sort_order,plan_json) VALUES(?,1,?,?,?) ON CONFLICT(id) DO NOTHING').bind(plan.id, Number(plan.enabled), plan.sort_order, JSON.stringify(updated))
  const results = await env.abdl_space_db.batch([statement,
    env.abdl_space_db.prepare('INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) SELECT ?,?,NULL,?,? WHERE changes()=1').bind(crypto.randomUUID(), String(actorId), id ? 'plan_update' : 'plan_create', reason),
  ])
  if (results[0].meta.changes !== 1) throw new SponsorError('version_conflict', '方案已存在或版本已变更', 409)
  return updated
}

const TRUSTED_ORIGINS = new Set(['https://abdl-space.top', 'https://www.abdl-space.top', 'https://m.abdl-space.top', 'https://wiki.abdl-space.top', 'https://open.abdl-space.top', 'https://abdl-space-mobile.pages.dev', 'http://localhost:5173', 'http://localhost:5174'])

/** Enforce JSON + explicit trusted Origin for cookie writes; native bearer calls need no Origin. */
export function assertSponsorWriteOrigin(c: Context<SponsorAppType>): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return
  const contentType = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new SponsorError('invalid_request', '写入请求必须使用 application/json', 400)
  const origin = c.req.header('origin')
  const cookie = c.req.header('cookie')
  const allowed = origin && (TRUSTED_ORIGINS.has(origin) || origin === new URL(c.req.url).origin || origin === c.env.FRONTEND_ORIGIN)
  if ((cookie && !allowed) || (origin && !allowed) || c.req.header('sec-fetch-site') === 'cross-site') throw new SponsorError('origin_forbidden', '请求来源验证失败', 403)
}

/** D1-enforced fixed-window rate limits, no process-local security state. */
export async function enforceSponsorRateLimit(env: SponsorEnv, bucket: string, limit: number, seconds = 60): Promise<void> {
  const result = await env.abdl_space_db.prepare(`INSERT INTO sponsor_rate_limits(bucket,window_start,count) VALUES(?,unixepoch(),1)
    ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window_start<=unixepoch()-? THEN 1 ELSE count+1 END,
    window_start=CASE WHEN window_start<=unixepoch()-? THEN unixepoch() ELSE window_start END
    RETURNING count`).bind(bucket, seconds, seconds).first<{ count: number }>()
  if (!result || result.count > limit) throw new SponsorError('rate_limited', '操作过于频繁，请稍后重试', 429)
}

async function authenticateSponsor(c: Context<SponsorAppType>, admin: boolean): Promise<void> {
  // Adapt the existing scope-aware Mastodon authentication for first-party cookie sessions.
  // An explicit invalid bearer never falls back to a more privileged cookie.
  const cookieToken = c.req.header('cookie')?.match(/(?:^|;\s*)token=([^;]+)/)?.[1]
  const authorization = c.req.header('authorization') ?? (cookieToken ? `Bearer ${cookieToken}` : undefined)
  const auth = await mastodonAuthDetails({ env: c.env, req: { header: name => name.toLowerCase() === 'authorization' ? authorization : c.req.header(name) } })
  if (!auth || (auth.tokenType === 'jwt' && await assertSessionNotStale(auth.user, c.env.abdl_space_db))) throw new SponsorError('unauthenticated', '请先登录', 401)
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
  const requiredScope = write ? 'write' : 'read'
  if (auth.tokenType === 'oauth' && !auth.scopes.includes(requiredScope)) throw new SponsorError('insufficient_scope', '授权范围不足', 403)
  // Shared Mastodon auth caches profile rows; sponsor authorization always rechecks existence/role.
  const current = await c.env.abdl_space_db.prepare('SELECT role FROM users WHERE id=?').bind(auth.user.sub).first<{ role: string }>()
  if (!current) throw new SponsorError('unauthenticated', '请先登录', 401)
  if (admin && current.role !== 'admin') throw new SponsorError('admin_required', '需要管理员权限', 403)
  c.set('user', { ...auth.user, role: current.role })
}

/** Reusable admin guard for core and isolated stock routes. */
export async function sponsorAdminMiddleware(c: Context<SponsorAppType>, next: Next): Promise<Response | void> {
  c.header('Cache-Control', 'private, no-store')
  try {
    await authenticateSponsor(c, true)
    assertSponsorWriteOrigin(c)
    await enforceSponsorRateLimit(c.env, `admin:${c.get('user').sub}`, c.req.method === 'GET' ? 180 : 60)
    await next()
  } catch (error) { return sponsorErrorResponse(error, c) }
}

/** Sponsor-specific authenticated guard with the stable Chinese error contract. */
export async function sponsorAuthMiddleware(c: Context<SponsorAppType>, next: Next): Promise<Response | void> {
  c.header('Cache-Control', 'private, no-store')
  try {
    await authenticateSponsor(c, false)
    assertSponsorWriteOrigin(c)
    const sensitive = c.req.path.endsWith('/redeem')
    await enforceSponsorRateLimit(c.env, `user:${c.get('user').sub}:${sensitive ? 'redeem' : 'core'}`, sensitive ? 10 : 180)
    const ip = c.req.header('cf-connecting-ip')
    if (sensitive && ip && ip.length <= 64) await enforceSponsorRateLimit(c.env, `redeem-ip:${await sponsorHash(ip)}`, 60)
    await next()
  } catch (error) { return sponsorErrorResponse(error, c) }
}

/** Scheduled maintenance hook; current sponsor windows are at most 60 seconds. */
export async function cleanupSponsorRateLimits(env: SponsorEnv): Promise<void> {
  await env.abdl_space_db.prepare('DELETE FROM sponsor_rate_limits WHERE window_start < unixepoch()-86400').run()
}

/** Batch minimal public projections; missing migrations or unavailable appearance reads fail ordinary. */
export async function getPublicSponsors(env: SponsorEnv, userIds: number[]): Promise<Map<number, PublicSponsor>> {
  const result = new Map<number, PublicSponsor>()
  const ids = [...new Set(userIds)].filter(v => Number.isSafeInteger(v) && v > 0)
  try {
    for (let start = 0; start < ids.length; start += 80) {
      const chunk = ids.slice(start, start + 80)
      const rows = await env.abdl_space_db.prepare(`SELECT user_id,result_json FROM sponsor_me_json WHERE user_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ user_id: number; result_json: string }>()
      for (const row of rows.results) {
        const s = (JSON.parse(row.result_json) as SponsorMe).sponsor
        if (s.active) result.set(row.user_id, { active: true, permanent: s.permanent, valid_until: s.expires_at, color_light: s.color_light, color_dark: s.color_dark })
      }
    }
  } catch { return new Map() }
  return result
}

/** Cover bounded Mastodon account JSON only, without changing roles or existing badges. */
export async function sponsorAccountProjectionMiddleware(c: Context<SponsorAppType>, next: Next): Promise<void> {
  await next()
  if (!/^\/api\/v[12]\/(?:accounts|statuses|timelines|notifications|search|favourites|bookmarks|follow_requests|conversations|mutes|blocks|directory|suggestions|trends\/statuses)(?:\/|$)/.test(c.req.path)) return
  const maximumBytes = 2 * 1024 * 1024
  if (!c.res.ok || !c.res.headers.get('content-type')?.includes('application/json') || c.res.headers.has('content-encoding') || Number(c.res.headers.get('content-length')) > maximumBytes) return
  const reader = c.res.clone().body?.getReader()
  if (!reader) return
  let body: unknown
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        // A tee branch cancellation waits for the original stream; do not await it here.
        void reader.cancel().catch(() => {})
        return
      }
      text += decoder.decode(value, { stream: true })
    }
    body = JSON.parse(text + decoder.decode())
  } catch {
    void reader.cancel().catch(() => {})
    return
  }
  const accounts: Record<string, unknown>[] = []
  const collect = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 16 || accounts.length >= 2000) return
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return }
    const object = value as Record<string, unknown>
    if (typeof object.id === 'string' && /^\d+$/.test(object.id) && typeof object.username === 'string' && object.acct === object.username && typeof object.url === 'string' && typeof object.avatar === 'string') accounts.push(object)
    for (const [key, child] of Object.entries(object)) if (key !== 'sponsor') collect(child, depth + 1)
  }
  collect(body, 0)
  if (!accounts.length) return
  const sponsors = await getPublicSponsors(c.env, accounts.map(v => Number(v.id)))
  for (const account of accounts) account.sponsor = sponsors.get(Number(account.id)) ?? null
  const headers = new Headers(c.res.headers)
  headers.delete('content-length'); headers.delete('etag')
  // Accounts contain time-sensitive appearance and must not retain stale cached grants/revocations.
  headers.set('Cache-Control', 'private, no-store')
  c.res = new Response(JSON.stringify(body), { status: c.res.status, headers })
}
