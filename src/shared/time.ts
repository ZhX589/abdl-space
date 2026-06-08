/**
 * 时区工具 — 使用 Intl.DateTimeFormat，不用 Date.now() + offset
 * 时区：Asia/Shanghai (GMT+8)
 */

/**
 * 获取北京时间的日期字符串 YYYY-MM-DD
 */
export function getBeijingDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d) // "2026-06-08"
}

/**
 * 获取北京时间的日期时间字符串 YYYY-MM-DD HH:mm:ss
 */
export function getBeijingDateTime(d: Date = new Date()): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d)
  return `${date} ${time}`
}

/**
 * 判断两个日期是否为同一天（北京时间）
 */
export function isSameBeijingDate(a: Date, b: Date): boolean {
  return getBeijingDate(a) === getBeijingDate(b)
}
