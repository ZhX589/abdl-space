/**
 * 腾讯云 SES 邮件发送（TC3-HMAC-SHA256 签名）
 * 替代 Resend，用于发送验证码等触发类邮件
 */

const SES_HOST = 'ses.tencentcloudapi.com'
const SES_SERVICE = 'ses'
const SES_VERSION = '2020-10-02'
const SES_REGION = 'ap-guangzhou'

/** HMAC-SHA256 */
async function hmacSha256(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder()
  const keyData = typeof key === 'string' ? enc.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data))
}

/** SHA-256 hex */
async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** ArrayBuffer → hex string */
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * TC3-HMAC-SHA256 签名
 * @returns Authorization header value
 */
async function signRequest(
  secretId: string,
  secretKey: string,
  action: string,
  payload: string,
  timestamp: number
): Promise<Record<string, string>> {
  const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10) // YYYY-MM-DD (UTC)

  // 1. CanonicalRequest
  const hashedPayload = await sha256Hex(payload)
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json\nhost:${SES_HOST}\n`,
    'content-type;host',
    hashedPayload,
  ].join('\n')

  // 2. StringToSign
  const credentialScope = `${dateStr}/${SES_SERVICE}/tc3_request`
  const hashedCanonical = await sha256Hex(canonicalRequest)
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonical}`

  // 3. Signature
  const secretDate = await hmacSha256(`TC3${secretKey}`, dateStr)
  const secretService = await hmacSha256(secretDate, SES_SERVICE)
  const secretSigning = await hmacSha256(secretService, 'tc3_request')
  const signature = toHex(await hmacSha256(secretSigning, stringToSign))

  return {
    'Content-Type': 'application/json',
    'Host': SES_HOST,
    'X-TC-Action': action,
    'X-TC-Version': SES_VERSION,
    'X-TC-Region': SES_REGION,
    'X-TC-Timestamp': String(timestamp),
    'Authorization': `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`,
  }
}

/**
 * 发送模板邮件
 * @param to - 收件人邮箱
 * @param subject - 邮件主题
 * @param templateId - 腾讯云 SES 模板 ID
 * @param templateData - 模板变量 JSON 字符串，如 '{"code":"123456"}'
 * @param env - 环境变量（需含 TENCENT_SECRET_ID, TENCENT_SECRET_KEY, SES_FROM_EMAIL）
 */
export async function sendTencentEmail(
  to: string,
  subject: string,
  templateId: number,
  templateData: string,
  env: { TENCENT_SECRET_ID: string; TENCENT_SECRET_KEY: string; SES_FROM_EMAIL: string }
): Promise<{ messageId: string; requestId: string }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const payload = JSON.stringify({
    FromEmailAddress: env.SES_FROM_EMAIL,
    Destination: [to],
    Subject: subject,
    Template: {
      TemplateID: templateId,
      TemplateData: templateData,
    },
    TriggerType: 1, // 触发类邮件（验证码专用通道）
  })

  const headers = await signRequest(
    env.TENCENT_SECRET_ID,
    env.TENCENT_SECRET_KEY,
    'SendEmail',
    payload,
    timestamp
  )

  const res = await fetch(`https://${SES_HOST}`, {
    method: 'POST',
    headers,
    body: payload,
  })

  const data = await res.json() as {
    Response?: { MessageId?: string; RequestId?: string; Error?: { Code: string; Message: string } }
  }

  if (!res.ok || data.Response?.Error) {
    const err = data.Response?.Error
    throw new Error(`SES error: ${err?.Code || res.status} ${err?.Message || 'unknown'}`)
  }

  return {
    messageId: data.Response?.MessageId || '',
    requestId: data.Response?.RequestId || '',
  }
}
