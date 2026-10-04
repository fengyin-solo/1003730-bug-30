import {
  DISPOSAL_LEDGER_KEY,
  commitWrites,
  listRows,
  nextId,
} from '@/data/local-store'
import { deriveFlags } from '@/data/status'
import { runAction, moduleMeta } from './local-service'
import type { ActionResult, EntryRow } from '@/data/types'

// 地下水异常识别与处置的唯一写入管道：列表批量识别、单井人工标记、异常处置都走这里，
// 保证多个入口不会重复生成异常、并发处置只落一条结论。

const MODULE_KEY = 'groundwater'
const INSPECTION_KEY = 'inspection'

export const GW_STATUS = {
  collected: '已采集',
  reviewing: '待审核',
  approved: '已通过',
  abnormal: '异常值',
} as const

export type ReadingResult = { value: number | null; raw: string }

export type IdentifyResult = {
  ok: boolean
  message: string
  flagged: { id: number; recordNo: string; wellNo: string; source: string }[]
  skipped: number
}

export type DisposeInput = {
  conclusion: string
  operator: string
}

export type DisposeResult = ActionResult & {
  inspectionRecordNo?: string
}

// 原始读数兼容：现场可能录成 "12.5"、"12.5m"、"未测" 等，解析失败保留 null，
// 原始字符串始终留在记录里，不覆盖、不丢值。
export function parseReading(raw: unknown): ReadingResult {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return { value: null, raw: text }
  }
  const matched = text.match(/-?\d+(?:\.\d+)?/)
  if (!matched) {
    return { value: null, raw: text }
  }
  return { value: Number(matched[0]), raw: text }
}

// 埋深值：地面到水面的距离，必须为正数且不超过 200m；水位标高给足合理海拔区间。
export function readingIssues(row: EntryRow): string[] {
  const issues: string[] = []
  const depth = parseReading(row['埋深值'])
  if (depth.value === null || !(depth.value > 0) || depth.value > 200) {
    issues.push(`埋深值异常（原始读数：${depth.raw || '缺测'}）`)
  }
  const elevation = parseReading(row['水位标高'])
  if (elevation.value === null || elevation.value < -1000 || elevation.value > 10000) {
    issues.push(`水位标高异常（原始读数：${elevation.raw || '缺测'}）`)
  }
  return issues
}

function patchRow(row: EntryRow, patch: Partial<EntryRow>): EntryRow {
  const merged = { ...row, ...patch } as EntryRow
  return { ...merged, ...deriveFlags(moduleMeta(MODULE_KEY), merged) }
}

// 批量异常识别：埋深值、水位标高、异常井点多个入口共用，重复执行幂等——
// 已识别为异常、已办结通过的记录都不会重复生成。
export function identifyAbnormalWells(): IdentifyResult {
  const rows = listRows(MODULE_KEY)
  const flagged: IdentifyResult['flagged'] = []
  let skipped = 0
  const next = rows.map((row) => {
    const status = String(row.status)
    if (status === GW_STATUS.abnormal) {
      skipped += 1
      return row
    }
    if (status === GW_STATUS.approved) {
      skipped += 1
      return row
    }
    const issues = readingIssues(row)
    if (issues.length === 0) {
      return row
    }
    flagged.push({
      id: Number(row.id),
      recordNo: String(row['记录编号'] ?? ''),
      wellNo: String(row['井点编号'] ?? ''),
      source: issues.join('；'),
    })
    return patchRow(row, {
      status: GW_STATUS.abnormal,
      异常来源: issues.join('；'),
      原始埋深值: String(row['埋深值'] ?? ''),
      原始水位标高: String(row['水位标高'] ?? ''),
    })
  })
  if (flagged.length > 0) {
    commitWrites([{ key: MODULE_KEY, rows: next }])
  }
  return {
    ok: true,
    message:
      flagged.length > 0
        ? `识别完成：新标记 ${flagged.length} 条异常井点记录，跳过 ${skipped} 条已识别或已办结记录`
        : `识别完成：没有新增异常记录（跳过 ${skipped} 条已识别或已办结记录）`,
    flagged,
    skipped,
  }
}

// 人工标记单条异常：与批量识别同一写入口径，重复标记不重复写。
export function markAbnormal(id: number, source = '人工标记异常'): ActionResult {
  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的地下水观测记录` }
  }
  const current = String(rows[index].status)
  if (current === GW_STATUS.abnormal) {
    return { ok: true, message: '该记录已是异常值，无需重复标记' }
  }
  if (current === GW_STATUS.approved) {
    return { ok: false, message: '该记录已确认通过并办结，不能再标记异常' }
  }
  const next = [...rows]
  next[index] = patchRow(rows[index], {
    status: GW_STATUS.abnormal,
    异常来源: source,
    原始埋深值: String(rows[index]['埋深值'] ?? ''),
    原始水位标高: String(rows[index]['水位标高'] ?? ''),
  })
  commitWrites([{ key: MODULE_KEY, rows: next }])
  return { ok: true, message: '已标记为异常值，等待处置' }
}

function getStatus(id: number): { row?: EntryRow; status: string } {
  const rows = listRows(MODULE_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  return { row, status: row ? String(row.status) : '' }
}

// 审核序在领域层强约束：只有「已采集/异常值」可提交审核，只有「待审核」可确认通过，
// 通用动作层保持宽松，但地下水记录不允许跳状态或回头提交。
export function submitForReview(id: number): ActionResult {
  const { row, status } = getStatus(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的地下水观测记录` }
  }
  if (status === GW_STATUS.reviewing) {
    return { ok: false, message: '记录已在待审核，不能重复提交' }
  }
  if (status === GW_STATUS.approved) {
    return { ok: false, message: '记录已确认通过并办结，不能再次提交审核' }
  }
  if (status !== GW_STATUS.collected && status !== GW_STATUS.abnormal) {
    return { ok: false, message: `记录当前为「${status}」，不能提交审核` }
  }
  return runAction(MODULE_KEY, id, '提交审核')
}

export function approve(id: number): ActionResult {
  const { row, status } = getStatus(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的地下水观测记录` }
  }
  if (status === GW_STATUS.approved) {
    return { ok: false, message: '记录已确认通过，不用重复操作' }
  }
  if (status !== GW_STATUS.reviewing) {
    return { ok: false, message: `只有待审核记录可以确认通过，当前为「${status}」` }
  }
  return runAction(MODULE_KEY, id, '确认通过')
}

export type GroundwaterDraft = {
  recordNo?: string
  wellNo: string
  observedAt: string
  depth: string
  elevation: string
  temperature: string
  observer: string
}

// 登记观测记录：观测人允许留空（历史旧记录缺观测人时不补造），原始读数原样保存。
export function createEntry(draft: GroundwaterDraft): ActionResult {
  const wellNo = draft.wellNo.trim()
  if (!wellNo) {
    return { ok: false, message: '井点编号不能为空' }
  }
  const observedAt = draft.observedAt || new Date().toISOString().slice(0, 10)
  const rows = listRows(MODULE_KEY)
  const duplicate = rows.some(
    (row) =>
      String(row['井点编号'] ?? '') === wellNo &&
      String(row['观测日期'] ?? '') === observedAt &&
      String(row['埋深值'] ?? '') === draft.depth.trim(),
  )
  if (duplicate) {
    return { ok: false, message: '该井点当日相同埋深值的观测记录已存在，不能重复登记' }
  }
  const newId = nextId(MODULE_KEY)
  const recordNo = draft.recordNo?.trim() || `GROU-${String(newId).padStart(4, '0')}`
  if (rows.some((row) => String(row['记录编号'] ?? '') === recordNo)) {
    return { ok: false, message: `记录编号 ${recordNo} 已存在` }
  }
  const created: EntryRow = {
    id: newId,
    status: GW_STATUS.collected,
    pending: true,
    abnormal: false,
    记录编号: recordNo,
    井点编号: wellNo,
    观测日期: observedAt,
    埋深值: draft.depth.trim(),
    水位标高: draft.elevation.trim(),
    水温: draft.temperature.trim(),
    观测人: draft.observer.trim(),
    记录状态: GW_STATUS.collected,
  }
  commitWrites([{ key: MODULE_KEY, rows: [...rows, created] }])
  return { ok: true, message: `观测记录 ${recordNo} 已登记` }
}

// 同一记录的并发处置锁：拿到锁的调用负责写结论，其余调用直接复用同一个 Promise，
// 保证一条异常记录只保留一条处置结论。
const disposing = new Map<number, Promise<DisposeResult>>()

export function disposeAbnormal(id: number, input: DisposeInput): Promise<DisposeResult> {
  const existing = disposing.get(id)
  if (existing) {
    return existing
  }
  const task = runDispose(id, input).finally(() => {
    disposing.delete(id)
  })
  disposing.set(id, task)
  return task
}

async function runDispose(id: number, input: DisposeInput): Promise<DisposeResult> {
  const conclusion = input.conclusion.trim()
  if (!conclusion) {
    return { ok: false, message: '处置结论不能为空' }
  }
  // 留出并发窗口：重复点击时后到的请求在锁上复用同一结论。
  await new Promise((resolve) => window.setTimeout(resolve, 200))

  try {
    // 以下三张表的读取、校验、组装、提交都在同一同步段内完成，
    // 任一处校验失败或落盘失败，commitWrites 把三处一起回退。
    const gwRows = listRows(MODULE_KEY)
    const index = gwRows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的地下水观测记录` }
    }
    const target = gwRows[index]
    if (String(target.status) !== GW_STATUS.abnormal) {
      return { ok: false, message: `记录当前为「${target.status}」，只有异常值记录需要处置` }
    }

    const recordNo = String(target['记录编号'] ?? '')
    const wellNo = String(target['井点编号'] ?? '')
    const observedAt = String(target['观测日期'] ?? '')
    const today = new Date().toISOString().slice(0, 10)
    const timestamp = new Date().toISOString()
    // 业务键去重：同一异常记录即便绕过状态校验，也只能记一次有效处置结果。
    const businessKey = `${recordNo}@${observedAt}`

    const ledger = listRows(DISPOSAL_LEDGER_KEY)
    if (ledger.some((row) => String(row['业务键'] ?? '') === businessKey)) {
      return { ok: false, message: '该异常记录已处置过，不能重复提交处置结果' }
    }

    const inspectionRows = listRows(INSPECTION_KEY)
    const inspectionId = nextId(INSPECTION_KEY)
    const inspectionRecordNo = `INSP-CHK-${String(inspectionId).padStart(4, '0')}`
    const inspectionRow: EntryRow = {
      id: inspectionId,
      status: '已处置',
      pending: false,
      abnormal: false,
      记录编号: inspectionRecordNo,
      站点编号: wellNo,
      巡检日期: today,
      巡检人员: input.operator,
      检查项目: `地下水异常核查（来源记录 ${recordNo}）`,
      发现问题: String(target['异常来源'] ?? '地下水观测数据异常'),
      处理措施: conclusion,
      巡检状态: '已处置',
    }

    const ledgerId = nextId(DISPOSAL_LEDGER_KEY)
    const ledgerRow: EntryRow = {
      id: ledgerId,
      status: '已处置',
      pending: false,
      abnormal: false,
      记录编号: `GROU-DISP-${String(ledgerId).padStart(4, '0')}`,
      井点编号: wellNo,
      观测日期: observedAt,
      埋深值: target['埋深值'] ?? '',
      水位标高: target['水位标高'] ?? '',
      异常来源: target['异常来源'] ?? '',
      处置结论: conclusion,
      处置人: input.operator,
      处置时间: timestamp,
      巡检记录编号: inspectionRecordNo,
      业务键: businessKey,
    }

    const nextGwRows = [...gwRows]
    nextGwRows[index] = patchRow(target, {
      // 处置完成后重新进入审核流：待审核 → 确认通过 → 办结。
      status: GW_STATUS.reviewing,
      处置结论: conclusion,
      处置人: input.operator,
      处置时间: timestamp,
      巡检记录编号: inspectionRecordNo,
    })

    commitWrites([
      { key: MODULE_KEY, rows: nextGwRows },
      { key: INSPECTION_KEY, rows: [...inspectionRows, inspectionRow] },
      { key: DISPOSAL_LEDGER_KEY, rows: [...ledger, ledgerRow] },
    ])
    return {
      ok: true,
      message: `异常记录 ${recordNo} 已处置，巡检核查 ${inspectionRecordNo} 已写入，记录回到待审核`,
      inspectionRecordNo,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `处置提交失败，三处写入已全部回退：${error.message}` : '处置提交失败，已全部回退',
    }
  }
}
