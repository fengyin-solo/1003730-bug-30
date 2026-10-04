import type { AuditEntry, EntryRow } from './types'

// 地下水异常识别与处置的跨模块联动：
// 异常井 -> 巡检模块生成一条「核查」事项；处置 -> 两边一起闭环，并在处置台账留一条结论。
// 三处写入由 local-store 的事务一次性提交，任一失败整体回退。

export const AUDIT_LEDGER_KEY = '__audit_ledger__'
export const GROUNDWATER_KEY = 'groundwater'
export const INSPECTION_KEY = 'inspection'
export const ABNORMAL_SOURCE = '地下水异常核查'

export type LinkedData = {
  [GROUNDWATER_KEY]: EntryRow[]
  [INSPECTION_KEY]: EntryRow[]
  [AUDIT_LEDGER_KEY]?: AuditEntry[]
}

// 埋深合法区间（米）：原始读数无法解析为数字时视为原始记录，不参与自动判定，保持兼容。
export const DEPTH_MIN = 0.1
export const DEPTH_MAX = 30

/** 从原始读数里取第一个数字；取不到（历史占位文本等）返回 null，按原始读数兼容处理。 */
export function parseReading(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string') {
    const matched = raw.trim().match(/-?\d+(\.\d+)?/)
    if (matched) {
      const value = Number(matched[0])
      return Number.isFinite(value) ? value : null
    }
  }
  return null
}

export type AbnormalCheck = { abnormal: boolean; reason: string }

export function checkGroundwaterReading(row: Pick<EntryRow, '埋深值' | '水位标高'>): AbnormalCheck {
  const depth = parseReading(row.埋深值)
  if (depth === null) {
    // 旧的非数值原始读数：不自动判异，交给人工标记，保证历史记录兼容
    return { abnormal: false, reason: '' }
  }
  if (depth < DEPTH_MIN || depth > DEPTH_MAX) {
    return { abnormal: true, reason: `埋深值 ${depth}m 超出合理区间 ${DEPTH_MIN}~${DEPTH_MAX}m` }
  }
  return { abnormal: false, reason: '' }
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 为异常井拼装一条巡检核查事项（尚未持久化）。 */
export function buildInspectionTask(gwRow: EntryRow, inspectionId: number): EntryRow {
  const wellNo = String(gwRow.井点编号 ?? '')
  const reason = String(gwRow.异常原因 ?? '埋深读数异常')
  return {
    id: inspectionId,
    status: '发现故障',
    pending: true,
    abnormal: true,
    记录编号: `INSP-GW-${String(gwRow.id).padStart(4, '0')}`,
    站点编号: wellNo,
    巡检日期: todayText(),
    巡检人员: '',
    检查项目: `地下水异常井点核查：${wellNo}`,
    发现问题: reason,
    处理措施: '',
    巡检状态: '发现故障',
    source: ABNORMAL_SOURCE,
    核查结论: '',
  }
}

export function buildAuditEntry(
  id: number,
  refId: number,
  kind: AuditEntry['kind'],
  conclusion: string,
  operator: string,
): AuditEntry {
  return {
    id,
    module: GROUNDWATER_KEY,
    refId,
    kind,
    conclusion,
    operator,
    createdAt: new Date().toISOString(),
  }
}

export function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}
