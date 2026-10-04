import { AUDIT_LEDGER_KEY, ABNORMAL_SOURCE, GROUNDWATER_KEY, INSPECTION_KEY, buildInspectionTask, nextId } from './linkage'
import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import {
  MIRROR_STATUS_FIELD,
  isAbnormalStatus,
  isPendingStatus,
} from './status-rules'
import type { AuditEntry, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
// 处置台账与业务表放在同一张图里，靠一次写入整体提交，保证三处写入同生共死。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

type StoreMap = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 归一化：以权威 status 为唯一事实源，重算 pending/abnormal，补齐版本号，
// 并把同义的业务状态字段（记录状态/巡检状态…）回写一致，旧缓存读出来即自愈。
function normalizeRow(key: string, row: EntryRow): EntryRow {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    return { ...row, version: row.version ?? 1 }
  }
  const status = String(row.status)
  const fixed: EntryRow = {
    ...row,
    status,
    pending: isPendingStatus(meta, status),
    abnormal: isAbnormalStatus(meta, status),
    version: typeof row.version === 'number' ? row.version : 1,
  }
  const mirror = MIRROR_STATUS_FIELD[key]
  if (mirror) {
    fixed[mirror] = status
  }
  return fixed
}

// 存量数据迁移：历史上异常井没有联动巡检事项，读取时给未闭环的异常井补一条，
// 让「列表异常数」与「巡检待处置数」在旧浏览器里也对得上；已有联动的绝不重复补。
function migrateOrphanTasks(map: StoreMap): void {
  const groundwater = map[GROUNDWATER_KEY] as EntryRow[] | undefined
  if (!groundwater) {
    return
  }
  const inspection = (map[INSPECTION_KEY] as EntryRow[] | undefined) ?? []
  const linkedRefs = new Set(
    groundwater
      .map((row) => (row.status === '异常值' ? row.inspectionRef : ''))
      .filter((ref): ref is string => Boolean(ref)),
  )
  for (const row of groundwater) {
    if (row.status !== '异常值' || row.inspectionRef) {
      continue
    }
    const ref = `INSP-GW-${String(row.id).padStart(4, '0')}`
    if (linkedRefs.has(ref) || inspection.some((item) => item.记录编号 === ref)) {
      row.inspectionRef = ref
      continue
    }
    const task = buildInspectionTask(row, nextId(inspection))
    inspection.push(task)
    row.inspectionRef = ref
    linkedRefs.add(ref)
  }
  map[INSPECTION_KEY] = inspection
}

function seedMap(): StoreMap {
  const map: StoreMap = clone(SEED_ROWS)
  map[AUDIT_LEDGER_KEY] = []
  for (const key of Object.keys(map)) {
    if (key === AUDIT_LEDGER_KEY) {
      continue
    }
    if (Array.isArray(map[key])) {
      map[key] = (map[key] as EntryRow[]).map((row) => normalizeRow(key, row))
    }
  }
  migrateOrphanTasks(map)
  return map
}

function hydrate(raw: StoreMap): StoreMap {
  const fallback = seedMap()
  // 种子里新增的模块也要补齐，再用浏览器里的改动覆盖
  const merged: StoreMap = { ...fallback, ...raw }
  for (const key of Object.keys(merged)) {
    if (key === AUDIT_LEDGER_KEY) {
      continue
    }
    if (Array.isArray(merged[key])) {
      merged[key] = (merged[key] as EntryRow[]).map((row) => normalizeRow(key, row))
    }
  }
  if (!Array.isArray(merged[AUDIT_LEDGER_KEY])) {
    merged[AUDIT_LEDGER_KEY] = []
  }
  migrateOrphanTasks(merged)
  return merged
}

function readStorage(): StoreMap {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedMap()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedMap()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return hydrate(JSON.parse(raw) as StoreMap)
  } catch {
    const seeded = seedMap()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: StoreMap | null = null

export function allRows(): StoreMap {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return (allRows()[key] as EntryRow[] | undefined) ?? []
}

export function auditLedger(): AuditEntry[] {
  return (allRows()[AUDIT_LEDGER_KEY] as AuditEntry[] | undefined) ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  commit(next)
}

// 事务：在草稿（整图克隆）上依次执行多处写入，任一环节抛错直接丢弃草稿，
// 缓存与 localStorage 都不动 —— 三处一起回退。
export function commitMap(mutate: (draft: StoreMap) => void): void {
  const draft = clone(allRows())
  mutate(draft)
  commit(draft)
}

function commit(next: StoreMap): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先序列化再换缓存：序列化或写入抛错（数据异常/存储失败）时旧缓存原样保留，
    // 上层据此中止整笔事务，三处写入一起回退。
    const serialized = JSON.stringify(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized)
    } catch (error) {
      throw new Error(error instanceof Error ? `数据落盘失败，已整体回退：${error.message}` : '数据落盘失败，已整体回退')
    }
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []).map((row) => normalizeRow(key, row))
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 仅供验证脚本/测试使用：丢弃内存缓存，强制从 localStorage 重新读取。
export function __resetCacheForTest(): void {
  cache = null
}

export { ABNORMAL_SOURCE, AUDIT_LEDGER_KEY, GROUNDWATER_KEY, INSPECTION_KEY }
