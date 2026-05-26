import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, computeAvgScore } from '../lib/db.ts'
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
  product_type: string
  thickness: number
  avg_score: number
  rating_count: number
  absorbency_mfr: string
  absorbency_adult: string
  is_baby_diaper: number
  comfort: number | null
  popularity: number
  material: string
  features: string
  avg_price: string
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

  const diaperList = diapers.map((d, i) => {
    const parts = [
      `${i + 1}. 【${d.brand} ${d.model}】`,
      `类型：${d.product_type}`,
      `厚度：${d.thickness}/5`,
      `综合评分：${d.avg_score}（${d.rating_count}人评价）`,
      `厂家标称吸收：${d.absorbency_mfr}，成人实际吸收：${d.absorbency_adult}`,
      d.is_baby_diaper ? '注意：此为婴儿纸尿裤，成人使用需折算吸收量' : '成人专用纸尿裤',
      d.comfort ? `先天舒适度：${d.comfort}/5` : null,
      `社区热度：${d.popularity}/10`,
      `材质：${d.material}`,
      `特点：${d.features}`,
      `参考价：${d.avg_price}`
    ].filter(Boolean)
    return parts.join('；')
  }).join('\n')

  return `你是一个纸尿裤推荐专家，服务于 ABDL（Adult Baby Diaper Lover）社区。用户是 ABDL 群体的一员，他们不仅关注纸尿裤的功能性（吸收、舒适），也关注外观、穿着体验和心理满足感。请从 ABDL 用户的角度出发进行推荐。

${profileLines}
${feelingsLine}

可选纸尿裤详细信息：
${diaperList}

请根据用户信息，推荐最合适的2-4款纸尿裤。

要求：
1. 写一段自然、亲切的推荐分析（150-250字），像朋友聊天一样
2. 分析要结合用户的具体数据（身材、偏好、使用感受等）
3. 提到纸尿裤时用 content 数组中的 diaper 类型引用
4. 可以提到纸尿裤的材质、特点、吸收量等具体信息来支撑推荐理由
5. 理解 ABDL 用户对纸尿裤的情感需求，推荐时兼顾实用性和心理满足

返回格式（只返回JSON）：
{
  "content": [
    {"type": "text", "text": "根据你的数据分析，"},
    {"type": "diaper", "diaper_id": 1},
    {"type": "text", "text": "非常适合你的身材特点..."},
    {"type": "diaper", "diaper_id": 3}
  ],
  "recommendations": [{"diaper_id": 1, "reason": "推荐理由，20字以内", "matchScore": 85}],
  "summary": "一句话总结推荐逻辑，20字以内"
}

matchScore 1-100。content 数组中 text 和 diaper 交替出现，构成完整的分析文本。`
}

/**
 * POST /api/recommend — AI 推荐（DeepSeek 驱动）
 */
recommend.post('/', authMiddleware, async (c) => {
  try {
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
    `SELECT d.id, d.brand, d.model, d.product_type, d.thickness,
      ROUND(AVG(r.absorption_score * 0.30 + r.comfort_score * 0.35 + r.thickness_score * 0.10 + r.appearance_score * 0.20 + r.value_score * 0.05), 1) as rating_avg,
      COUNT(r.id) as rating_count,
      ROUND(COALESCE(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0), 0) as feeling_avg,
      COUNT(DISTINCT f.id) as feeling_count,
      d.absorbency_mfr, d.absorbency_adult, d.is_baby_diaper, d.comfort, d.popularity, d.material, d.features, d.avg_price
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
      product_type: String(d.product_type),
      thickness: Number(d.thickness),
      avg_score: computeAvgScore(ratingAvg, ratingCount, feelingAvg, feelingCount),
      rating_count: ratingCount,
      absorbency_mfr: String(d.absorbency_mfr),
      absorbency_adult: String(d.absorbency_adult),
      is_baby_diaper: Number(d.is_baby_diaper),
      comfort: d.comfort != null ? Number(d.comfort) : null,
      popularity: Number(d.popularity),
      material: String(d.material),
      features: String(d.features),
      avg_price: String(d.avg_price)
    }
  })



  const apiKey = c.env.DEEPSEEK_API_KEY

  if (!apiKey) {
    return c.json({ error: 'AI 推荐未配置，请管理员设置 DeepSeek API Key' }, 503)
  }

  const prompt = buildPrompt(profile, feelings, diapers)

  let rawResponse: string
  try {
    rawResponse = await callDeepSeekAI(apiKey, prompt)
  } catch (e) {
    return c.json({ error: `AI 服务调用失败：${e instanceof Error ? e.message : 'Unknown error'}` }, 502)
  }

  let parsed: { content?: { type: string; text?: string; diaper_id?: number }[]; recommendations: Recommendation[]; summary: string }
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
    summary: parsed.summary || `根据您的信息推荐 ${recommendations.length} 款`,
    content: parsed.content || undefined,
    diapers: diapers.map(d => ({ id: d.id, brand: d.brand, model: d.model, product_type: d.product_type }))
  })
  } catch (e) {
    console.error('[recommend] error:', e)
    return c.json({ error: `推荐失败：${e instanceof Error ? e.message : 'Unknown error'}` }, 500)
  }
})

/**
 * GET /api/recommend/guess — 猜你喜欢（纯数据驱动）
 */
recommend.get('/guess', async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.id, d.brand, d.model, d.thickness,
      ROUND(AVG(r.absorption_score * 0.30 + r.comfort_score * 0.35 + r.thickness_score * 0.10 + r.appearance_score * 0.20 + r.value_score * 0.05), 1) as rating_avg,
      COUNT(r.id) as rating_count,
      ROUND(COALESCE(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0), 0) as feeling_avg,
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