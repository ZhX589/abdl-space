/**
 * NBW 双发同步逻辑
 * 用户在 ABDL Space 发帖后，异步推送到 NBW
 */

import type { Env } from '../types/index.ts'
import { queryOne, run } from './db.ts'
import { nbwS2SRequest, nbwS2SUpload } from './nbw.ts'

const NBW_FORUMS = [
  { fid: 28, name: '自拍' },
  { fid: 27, name: '分享' },
  { fid: 26, name: '小说/漫画' },
  { fid: 3, name: '交友' },
]

/**
 * HTML → BBCode 转换器
 * ABDL Space 存储 HTML，NBW 使用 BBCode
 */
export function htmlToBBCode(html: string, aids: number[]): string {
  let text = html
  // <p> 标签 → 换行
  text = text.replace(/<\/p>\s*<p[^>]*>/g, '\n\n')
  text = text.replace(/<p[^>]*>/g, '').replace(/<\/p>/g, '')
  // <br> → 换行
  text = text.replace(/<br\s*\/?>/g, '\n')
  // <a href="url">text</a> → [url=addr]text[/url]
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[url=$1]$2[/url]')
  // <b>/<strong> → [b]
  text = text.replace(/<(?:b|strong)[^>]*>/gi, '[b]').replace(/<\/(?:b|strong)>/gi, '[/b]')
  // <i>/<em> → [i]
  text = text.replace(/<(?:i|em)[^>]*>/gi, '[i]').replace(/<\/(?:i|em)>/gi, '[/i]')
  // HTML 实体还原
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
  // 图片附件标记
  if (aids.length > 0) {
    const attachTags = aids.map(aid => `[attachimg]${aid}[/attachimg]`).join('\n')
    text = text + '\n' + attachTags
  }
  return text.trim()
}

/**
 * 从 HTML 内容中提取标题（取前 50 字符）
 */
function extractSubject(content: string): string {
  // 去掉 HTML 标签
  const plain = content.replace(/<[^>]+>/g, '').trim()
  if (!plain) return '来自 ABDL Space'
  return plain.length > 50 ? plain.substring(0, 50) + '...' : plain
}

/**
 * 上传图片到 NBW
 * 从 imgbed URL 下载图片，上传到 NBW，返回 aid
 */
async function uploadImageToNBW(env: Env, nbwUid: string, imageUrl: string): Promise<number | null> {
  try {
    const imageRes = await fetch(imageUrl)
    if (!imageRes.ok) return null
    const blob = await imageRes.blob()
    const result = await nbwS2SUpload(env, nbwUid, blob, 'image.jpg')
    if (result.code === 200 && result.data) {
      return result.data.aid
    }
    return null
  } catch (e) {
    console.error('NBW image upload failed:', imageUrl, e)
    return null
  }
}

/**
 * 主同步函数：将 ABDL Space 帖子推送到 NBW
 * 异步执行，失败不阻塞主流程
 */
export async function syncPostToNBW(
  env: Env,
  userId: number,
  postId: number,
  content: string,
  mediaUrls: string[],
  nbwFid?: number
): Promise<void> {
  try {
    // 1. 查 nbw_uid，为空跳过
    const user = await queryOne<{ nbw_uid: string | null }>(
      env.abdl_space_db, 'SELECT nbw_uid FROM users WHERE id = ?', [userId]
    )
    if (!user?.nbw_uid) return

    // 2. 上传图片到 NBW
    const aids: number[] = []
    for (const url of mediaUrls) {
      const aid = await uploadImageToNBW(env, user.nbw_uid, url)
      if (aid) aids.push(aid)
    }

    // 3. HTML → BBCode 转换
    const bbcode = htmlToBBCode(content, aids)

    // 4. 确定版块（用户选择的或默认分享）
    const fid = nbwFid || 27

    // 5. 调用 NBW create_thread
    const result = await nbwS2SRequest(env, 'create_thread', {
      uid: user.nbw_uid,
      fid: String(fid),
      subject: extractSubject(content),
      message: bbcode,
    })

    // 6. 存储 nbw_tid/nbw_pid
    if (result.code === 200 && result.data) {
      const data = result.data as { tid: number; pid: number }
      if (data.tid) {
        await run(env.abdl_space_db,
          'UPDATE posts SET nbw_tid = ?, nbw_pid = ? WHERE id = ?',
          [data.tid, data.pid || 0, postId]
        )
      }
    }
  } catch (e) {
    console.error('NBW sync failed for post', postId, e)
  }
}
