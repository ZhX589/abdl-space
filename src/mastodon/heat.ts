/**
 * 帖子热度计算 —— 单一事实源，App 不重算。
 *
 * 公式：
 *   热度 = (分享*0.6 + 点赞*0.4 + 收藏*0.3 + 浏览*0.25) * 人气加成 * 100
 *   人气加成 = 1 + (24h 内 ? 0.5 : 0) + (含图 ? 0.1 : 0)
 *
 * 历史帖子处理：未统计的指标（如旧帖浏览量恒为 0）按 0 计入，
 * 即权重为 0 不纳入计算，与"该指标不参与公式"数学等价。
 *
 * 示例（来自需求）：
 *   分享1 点赞6 收藏1 浏览未知(0) 有图 24h内 → (0.6+2.4+0.3+0)*1.6*100 = 528
 *   同上但超 24h → (0.6+2.4+0.3+0)*1.1*100 = 363
 *   分享2 点赞4 收藏3 浏览10 有图 24h内 → (1.2+1.6+0.9+2.5)*1.6*100 = 992
 */
export interface HeatInput {
  sharesCount: number       // 原生分享数
  favouritesCount: number   // 点赞数
  bookmarksCount: number    // 收藏数
  viewsCount: number        // 浏览量
  hasImage: boolean         // 是否含图片
  within24h: boolean        // 是否发布于 24 小时内
}

/** 人气加成：基准 1 + 24h 内 +0.5 + 含图 +0.1（可叠加）。 */
export function popularityMultiplier(input: Pick<HeatInput, 'hasImage' | 'within24h'>): number {
  let m = 1
  if (input.within24h) m += 0.5
  if (input.hasImage) m += 0.1
  return m
}

/** 计算帖子热度，返回整数。 */
export function computeHeat(input: HeatInput): number {
  const base =
    input.sharesCount * 0.6 +
    input.favouritesCount * 0.4 +
    input.bookmarksCount * 0.3 +
    input.viewsCount * 0.25
  const heat = base * popularityMultiplier(input) * 100
  return Math.round(heat)
}

/** 12 小时滑窗阈值（秒）。同一用户对同一帖子在此窗口内重复浏览不计数。 */
export const VIEW_DEDUP_WINDOW_SECONDS = 12 * 60 * 60

/**
 * 判断 created_at（SQLite CURRENT_TIMESTAMP，UTC，形如 "2026-08-30 01:02:03"）
 * 距离现在是否在 24 小时内。容错处理带 T 的 ISO 串。
 */
export function isWithin24h(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false
  try {
    // SQLite CURRENT_TIMESTAMP 格式："YYYY-MM-DD HH:MM:SS"（UTC）。Date 能解析空格分隔的 UTC 串。
    const ms = Date.parse(createdAt.endsWith('Z') || createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z')
    if (Number.isNaN(ms)) return false
    return Date.now() - ms < 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}
