import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

interface Recommendation {
  diaper_id: number
  brand: string
  model: string
  reason: string
  matchScore: number
}

interface DiaperInfo {
  id: number
  brand: string
  model: string
  thickness: number
  avg_score: number
  rating_count: number
  absorbency_adult: string
}

function computeAvgScore(ratingAvg: number, _ratingCount: number, feelingAvg: number | null, feelingCount: number): number {
  if (feelingCount > 0 && feelingAvg !== null) {
    return Math.round((ratingAvg * 0.9 + (feelingAvg + 5) * 0.1) * 10) / 10
  }
  return Math.round(ratingAvg * 10) / 10
}

const recommend = new Hono<AppType>()

async function callDeepSeekAI(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`DeepSeek API error: ${response.status} - ${err}`)
  }

  const data = await response.json() as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content ?? ''
}

function buildPrompt(
  userProfile: Record<string, unknown>,
  feelings: Record<string, unknown>[],
  diapers: DiaperInfo[]
): string {
  const profileLines = [
    `用户信息：`,
    userProfile.age ? `年龄：${userProfile.age}` : null,
    userProfile.region ? `地区：${userProfile.region}` : null,
    userProfile.weight ? `体重：${userProfile.weight}kg` : null,
    userProfile.waist ? `腰围：${userProfile.waist}cm` : null,
    userProfile.hip ? `臀围：${userProfile.hip}cm` : null,
    userProfile.style_preference ? `偏好：${userProfile.style_preference}` : null,
    userProfile.bio ? `简介：${userProfile.bio}` : null,
  ].filter(Boolean).join('\n')

  const avgFeelings = { looseness: 0, softness: 0, dryness: 0, odor_control: 0, quietness: 0 }
  if (feelings.length > 0) {
    for (const f of feelings) {
      avgFeelings.looseness += Number(f.looseness)
      avgFeelings.softness += Number(f.softness)
      avgFeelings.dryness += Number(f.dryness)
      avgFeelings.odor_control += Number(f.odor_control)
      avgFeelings.quietness += Number(f.quietness)
    }
    const n = feelings.length
    for (const k of Object.keys(avgFeelings) as Array<keyof typeof avgFeelings>) {
      avgFeelings[k] = Math.round(avgFeelings[k] / n * 10) / 10
    }
  }

  const feelingsLine = feelings.length > 0
    ? `平均感受：松紧度${avgFeelings.looseness > 0 ? '偏紧' : avgFeelings.looseness < 0 ? '偏松' : '适中'}、柔软度${avgFeelings.softness > 0 ? '较软' : '较硬'}、干燥感${avgFeelings.dryness > 0 ? '较干' : '较湿'}、防臭${avgFeelings.odor_control > 0 ? '较好' : '一般'}、静音${avgFeelings.quietness > 0 ? '较安静' : '较吵'}`
    : '暂无感受数据'

  const diaperList = diapers.map((d, i) =>
    `${i + 1}. ${d.brand} ${d.model}（厚度${d.thickness}/5，综合评分${d.avg_score}，${d.rating_count}人评价，吸收量${d.absorbency_adult}）`
  ).join('\n')

  return `你是一个纸尿裤推荐专家。用户想根据个人信息找到最合适的纸尿裤。

${profileLines}
${feelingsLine}

可选纸尿裤：
${diaperList}

请根据用户信息，推荐最合适的2-4款纸尿裤，返回格式如下（只返回JSON，不要其他内容）：
{
  "recommendations": [
    {"diaper_id": 1, "reason": "推荐理由，20字以内", "matchScore": 85},
    ...
  ],
  "summary": "一句话总结推荐逻辑，20字以内"
}

matchScore 1-100，表示推荐匹配度。不要返回不存在的diaper_id。`
}

/**
 * POST /api/recommend — AI 推荐（DeepSeek 驱动）
 */
recommend.post('/', authMiddleware, async (c) => {
  const user = c.get('user')

  const [{ selected }] = await Promise.all([
    c.req.json<{ selected: Record<string, boolean> }>()
  ])

  const userData = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT age, region, weight, waist, hip, style_preference, bio FROM users WHERE id = ?',
    [user.sub]
  )
  if (!userData) return c.json({ error: 'User not found' }, 404)

  const profile: Record<string, unknown> = {}
  if (selected?.basic && userData.age) profile.age = userData.age
  if (selected?.basic && userData.region) profile.region = userData.region
  if (selected?.body && userData.weight) profile.weight = userData.weight
  if (selected?.body && userData.waist) profile.waist = userData.waist
  if (selected?.body && userData.hip) profile.hip = userData.hip
  if (selected?.prefs && userData.style_preference) profile.style_preference = userData.style_preference
  if (selected?.bio && userData.bio) profile.bio = userData.bio

  const feelings = (await query(
    c.env.abdl_space_db,
    `SELECT f.looseness, f.softness, f.dryness, f.odor_control, f.quietness
     FROM feelings f WHERE f.user_id = ?`,
    [user.sub]
  )) as Record<string, unknown>[]

  const diapersRaw = (await query(
    c.env.abdl_space_db,
    `SELECT d.id, d.brand, d.model, d.thickness,
      ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as rating_avg,
      COUNT(r.id) as rating_count,
      COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0) as feeling_avg,
      COUNT(DISTINCT f.id) as feeling_count,
      d.absorbency_adult
     FROM diapers d
     LEFT JOIN ratings r ON r.diaper_id = d.id
     LEFT JOIN feelings f ON f.diaper_id = d.id
     GROUP BY d.id
     ORDER BY rating_avg DESC
     LIMIT 20`
  )) as Record<string, unknown>[]

  const diapers: DiaperInfo[] = diapersRaw.map(d => {
    const ratingAvg = Number(d.rating_avg) || 0
    const ratingCount = Number(d.rating_count) || 0
    const feelingAvg = Number(d.feeling_avg) || null
    const feelingCount = Number(d.feeling_count) || 0
    return {
      id: Number(d.id),
      brand: String(d.brand),
      model: String(d.model),
      thickness: Number(d.thickness),
      avg_score: computeAvgScore(ratingAvg, ratingCount, feelingAvg, feelingCount),
      rating_count: ratingCount,
      absorbency_adult: String(d.absorbency_adult)
    }
  })

  const apiKeyRow = await queryOne<{ key_value: string }>(
    c.env.abdl_space_db,
    "SELECT key_value FROM api_keys WHERE provider = 'deepseek'"
  )

  if (!apiKeyRow?.key_value) {
    return c.json({ error: 'AI 推荐未配置，请管理员设置 DeepSeek API Key' }, 503)
  }

  const prompt = buildPrompt(profile, feelings, diapers)

  let rawResponse: string
  try {
    rawResponse = await callDeepSeekAI(apiKeyRow.key_value, prompt)
  } catch (e) {
    return c.json({ error: `AI 服务调用失败：${e instanceof Error ? e.message : 'Unknown error'}` }, 502)
  }

  let parsed: { recommendations: Recommendation[]; summary: string }
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return c.json({ error: 'AI 返回格式解析失败，请重试' }, 502)
  }

  const validIds = new Set(diapers.map(d => d.id))
  const recommendations = parsed.recommendations
    .filter(r => validIds.has(r.diaper_id))
    .slice(0, 5)
    .map(r => {
      const diaper = diapers.find(d => d.id === r.diaper_id)!
      return {
        diaper_id: r.diaper_id,
        brand: diaper.brand,
        model: diaper.model,
        reason: r.reason,
        matchScore: Math.min(100, Math.max(1, r.matchScore))
      }
    })

  return c.json({
    recommendations,
    summary: parsed.summary || `根据您的信息推荐 ${recommendations.length} 款`
  })
})

/**
 * GET /api/recommend/guess — 猜你喜欢（纯数据驱动）
 */
recommend.get('/guess', async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.id, d.brand, d.model, d.thickness,
      ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as rating_avg,
      COUNT(r.id) as rating_count,
      COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0) as feeling_avg,
      COUNT(DISTINCT f.id) as feeling_count
     FROM diapers d
     LEFT JOIN ratings r ON r.diaper_id = d.id
     LEFT JOIN feelings f ON f.diaper_id = d.id
     GROUP BY d.id
     ORDER BY rating_avg DESC
     LIMIT 5`
  )

  return c.json({
    recommendations: rows.map(r => {
      const ratingAvg = Number(r.rating_avg) || 0
      const ratingCount = Number(r.rating_count) || 0
      const feelingAvg = Number(r.feeling_avg) || null
      const feelingCount = Number(r.feeling_count) || 0
      const avgScore = computeAvgScore(ratingAvg, ratingCount, feelingAvg, feelingCount)
      return {
        id: r.id,
        brand: r.brand,
        model: r.model,
        avg_score: avgScore,
        rating_count: ratingCount,
        thickness: r.thickness,
        reason: avgScore >= 8 ? '综合评分超高，社区力荐' :
                Number(r.thickness) <= 2 ? '超薄设计，适合日常穿着' :
                '热门之选'
      }
    })
  })
})

export default recommend