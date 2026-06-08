/**
 * 等级系统 — 后端工具函数
 * 等级阈值：Lv.1=0, Lv.2=100, Lv.3=300, Lv.4=600, Lv.5=1000, Lv.6=1500, Lv.7=2100
 */

export const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2100]

export const LEVEL_NAMES: Record<number, string> = {
  1: 'Lv.1',
  2: 'Lv.2',
  3: 'Lv.3',
  4: 'Lv.4',
  5: 'Lv.5',
  6: 'Lv.6',
  7: 'Lv.7',
}

/**
 * 根据总经验计算等级
 */
export function calcLevel(totalExp: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalExp >= LEVEL_THRESHOLDS[i]) return i + 1
  }
  return 1
}

/**
 * 获取当前等级进度（当前经验 / 升级所需经验）
 * 返回 0~1 的进度值，满级返回 1
 */
export function calcLevelProgress(totalExp: number): { current: number; needed: number; progress: number } {
  const level = calcLevel(totalExp)
  if (level >= 7) {
    return { current: totalExp - LEVEL_THRESHOLDS[6], needed: 0, progress: 1 }
  }
  const currentThreshold = LEVEL_THRESHOLDS[level - 1]
  const nextThreshold = LEVEL_THRESHOLDS[level]
  const current = totalExp - currentThreshold
  const needed = nextThreshold - currentThreshold
  return { current, needed, progress: current / needed }
}

/**
 * 签到倍率
 */
export function getCheckinMultiplier(level: number): number {
  const multipliers: Record<number, number> = {
    1: 1.0,
    2: 1.1,
    3: 1.2,
    4: 1.3,
    5: 1.5,
    6: 1.8,
    7: 2.0,
  }
  return multipliers[level] || 1.0
}

/**
 * 积分倍率
 */
export function getPointsMultiplier(level: number): number {
  const multipliers: Record<number, number> = {
    1: 1.0,
    2: 1.05,
    3: 1.15,
    4: 1.15,
    5: 1.20,
    6: 1.30,
    7: 1.50,
  }
  return multipliers[level] || 1.0
}
