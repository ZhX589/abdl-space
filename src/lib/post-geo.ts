/**
 * 同城帖子：发帖地理位置解析
 *
 * 优先级：
 * 1. 客户端定位（Android 端拿到系统定位后随请求携带精确经纬度或省市名）
 * 2. 无定位权限时：Cloudflare request.cf 的 IP 属地（country=CN 时用 region 映射到省名）
 *
 * Cloudflare 在中国大陆的边缘节点通常无法给出可靠的省级 region 代码，
 * 因此 IP 兜底策略是：cf.country === 'CN' 且 cf.region 有映射则返回省名，
 * 否则返回 null，让客户端提示用户开启定位权限。
 */

/** Cloudflare region code → 中文省名（仅中国直辖市/省；港澳台单列） */
const CF_REGION_TO_PROVINCE: Record<string, string> = {
  BJ: '北京市', TJ: '天津市', SH: '上海市', CQ: '重庆市',
  HE: '河北省', SX: '山西省', NM: '内蒙古自治区', LN: '辽宁省', JL: '吉林省',
  HL: '黑龙江省', JS: '江苏省', ZJ: '浙江省', AH: '安徽省', FJ: '福建省',
  JX: '江西省', SD: '山东省', HA: '河南省', HB: '湖北省', HN: '湖南省',
  GD: '广东省', GX: '广西壮族自治区', HI: '海南省', SC: '四川省', GZ: '贵州省',
  YN: '云南省', XZ: '西藏自治区', SN: '陕西省', GS: '甘肃省', QH: '青海省',
  NX: '宁夏回族自治区', XJ: '新疆维吾尔自治区',
  HK: '香港特别行政区', MO: '澳门特别行政区', TW: '台湾省',
}

export interface ResolvedGeo {
  province: string | null
  city: string | null
  district: string | null
}

/** 从客户端请求体中提取并校验地理快照字段 */
export function resolveGeoFromClient(body: {
  geo_province?: unknown
  geo_city?: unknown
  geo_district?: unknown
}): ResolvedGeo {
  const clean = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() && v.length <= 50 ? v.trim() : null
  return {
    province: clean(body.geo_province),
    city: clean(body.geo_city),
    district: clean(body.geo_district),
  }
}

/**
 * IP 属地兜底：仅用于"无定位权限但用户选择展示所在省"的场景。
 * 从 Cloudflare 请求对象读取国家与一级行政区。
 */
export function resolveProvinceFromIP(c: { req: { cf?: { country?: string; region?: string } } }): string | null {
  const cf = c.req.cf
  if (!cf || cf.country !== 'CN') return null
  return CF_REGION_TO_PROVINCE[cf.region ?? ''] ?? null
}
