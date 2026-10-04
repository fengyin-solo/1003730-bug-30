import type { EntryRow, ModuleMeta } from './types'

// 待办/异常的唯一判定入口：列表图例、统计卡、运营概览、状态流转全部走这里，
// 避免「写入时按位标标记、读取时按状态统计」两套口径造成数量对不上。
function closedStatuses(meta: ModuleMeta): Set<string> {
  return new Set(meta.closedStatuses ?? [meta.statuses[meta.statuses.length - 1]])
}

const ABNORMAL_KEYWORDS = ['异常', '超标', '故障', '不合格', '需重测', '驳回', '中断', '信号弱']

export function abnormalStatusSet(meta: ModuleMeta): Set<string> {
  if (meta.abnormalStatuses) {
    return new Set(meta.abnormalStatuses)
  }
  // 兜底：没有显式配置的模块，按状态名里的异常语义判断。
  return new Set(meta.statuses.filter((status) => ABNORMAL_KEYWORDS.some((word) => status.includes(word))))
}

export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return !closedStatuses(meta).has(status)
}

export function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  return abnormalStatusSet(meta).has(status)
}

// 由状态反推待办/异常标记，保证任何写入路径产出的行口径一致。
export function deriveFlags(meta: ModuleMeta, row: EntryRow): Pick<EntryRow, 'pending' | 'abnormal'> {
  const status = String(row.status)
  return {
    pending: isPendingStatus(meta, status),
    abnormal: isAbnormalStatus(meta, status),
  }
}
