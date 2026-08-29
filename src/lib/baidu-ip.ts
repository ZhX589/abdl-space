/**
 * 百度地图普通IP定位（SN 校验）
 *
 * SN 计算步骤（按百度官方 Python 算法）：
 *   queryStr   = uri + "?" + qs          # 含原始参数值（未编码）
 *   encodedStr = quote(queryStr, safe="/:=&?#+!$,;'@()*[]")
 *   rawStr     = encodedStr + sk
 *   sn         = md5(quote_plus(rawStr))
 *
 * 文档：
 * - 服务：https://lbsyun.baidu.com/docs/webapi?title=locationip/ip-api-base
 * - SN：https://lbsyun.baidu.com/faq/api?title=lbscloud/api/appendix
 */

const BAIDU_IP_URI = '/location/ip'
const BAIDU_IP_HOST = 'https://api.map.baidu.com'

interface BaiduIpResult {
  province: string | null
  city: string | null
}

/** 百度 SN 第一步使用的 safe 字符集合（与 Python urllib.quote 的 safe 参数一致） */
const SN_SAFE = "/:=&?#+!$,;'@()*[]"

/** 实现 Python urllib.quote(s, safe=X)：safe 集合内字符保留，其余 %XX（UTF-8 字节） */
function pyQuote(s: string, safe: string): string {
  const safeSet = new Set(safe)
  let out = ''
  for (const ch of s) {
    if (/[A-Za-z0-9_\.~\-]/.test(ch) || safeSet.has(ch)) {
      out += ch
    } else {
      out += utf8PercentEncode(ch)
    }
  }
  return out
}

/** 实现 Python urllib.quote_plus(s)：等价于 quote(s, safe='') 且空格 → + */
function pyQuotePlus(s: string): string {
  let out = ''
  for (const ch of s) {
    if (/[A-Za-z0-9_\.~\-]/.test(ch)) {
      out += ch
    } else if (ch === ' ') {
      out += '+'
    } else {
      out += utf8PercentEncode(ch)
    }
  }
  return out
}

/** 单字符按 UTF-8 字节做 %XX 编码（大写十六进制，与 Python 一致） */
function utf8PercentEncode(ch: string): string {
  const bytes = new TextEncoder().encode(ch)
  let out = ''
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  return out
}

/** 计算 MD5 并输出 32 位小写十六进制（百度规范） */
async function md5Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 调用百度 IP 定位。
 * @param clientIp 客户端真实 IP（来自 CF-Connecting-IP）
 * @param ak 百度地图 AK（SN 校验）
 * @param sk 对应的 SK
 * @returns 省/市（任一可能为 null）
 */
export async function resolveProvinceFromBaiduIp(
  clientIp: string,
  ak: string,
  sk: string,
): Promise<BaiduIpResult> {
  // GET 请求按 LinkedHashMap 插入顺序拼接参数（ip 在前）
  const orderedParams: Array<[string, string]> = [
    ['ip', clientIp],
    ['coor', 'bd09ll'],
    ['ak', ak],
  ]
  const qs = orderedParams.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const queryStr = `${BAIDU_IP_URI}?${qs}`
  const encodedStr = pyQuote(queryStr, SN_SAFE)
  const rawStr = encodedStr + sk
  const sn = await md5Hex(pyQuotePlus(rawStr))

  const url = `${BAIDU_IP_HOST}${BAIDU_IP_URI}?${qs}&sn=${sn}`
  const resp = await fetch(url, { method: 'GET' })
  if (!resp.ok) return { province: null, city: null }
  const data = await resp.json() as {
    status?: number | string
    message?: string
    content?: { address_detail?: { province?: string; city?: string } }
  }
  const status = String(data.status ?? '1')
  if (status !== '0') return { province: null, city: null }
  const detail = data.content?.address_detail
  if (!detail) return { province: null, city: null }
  return {
    province: detail.province || null,
    city: detail.city || null,
  }
}
