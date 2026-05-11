/**
 * 通用工具函数
 */

/** 截断字符串到指定长度，超长追加省略号 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + '…'
}

/** 格式化 ISO 日期为可读格式 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

/** 延迟函数（用于测试 loading 状态等） */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 从 paragraph text 计算用于段评选中的简单 hash */
export function paragraphHash(text: string): string {
  const head = text.slice(0, 50).replace(/\s+/g, ' ').trim()
  return btoa(head).replace(/[+/=]/g, '').slice(0, 12) + text.length.toString(36)
}
