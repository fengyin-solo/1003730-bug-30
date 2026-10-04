import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import { deriveFlags } from './status'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 异常处置结论台账：不是业务模块，不进运营概览的模块统计，但要和观测记录、巡检记录同库同事务。
export const DISPOSAL_LEDGER_KEY = '_groundwaterDisposalLedger'

export type StagedWrite = {
  key: string
  rows: EntryRow[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 旧数据兼容：pending/abnormal 可能缺失或与状态对不上（旧逻辑写「已通过」仍标 pending），
// 统一按状态重新派生；观测人等字段旧记录缺失时留空，绝不补造；埋深值等原始读数原样保留。
function normalizeRow(key: string, row: EntryRow): EntryRow {
  const meta = MODULE_BY_KEY.get(key)
  const flags = meta ? deriveFlags(meta, row) : { pending: Boolean(row.pending), abnormal: Boolean(row.abnormal) }
  return { ...row, ...flags }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalizeAll(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalizeAll(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 种子里新增的模块也要补齐，旧浏览器缓存不会因为发版而缺模块。
    const merged: Record<string, EntryRow[]> = { ...clone(parsed) }
    for (const [key, rows] of Object.entries(fallback)) {
      if (!Array.isArray(merged[key])) {
        merged[key] = rows
      }
    }
    return normalizeAll(merged)
  } catch {
    const seeded = normalizeAll(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

function normalizeAll(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(data)) {
    if (key === DISPOSAL_LEDGER_KEY) {
      next[key] = rows
      continue
    }
    if (Array.isArray(rows)) {
      next[key] = rows.map((row) => normalizeRow(key, row))
    }
  }
  return next
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 多表一次性提交：先在缓存里暂存全部写入，再落 localStorage；
// 任一步失败都把缓存与存储恢复到提交前快照，三处写入要么全成要么全退。
export function commitWrites(writes: StagedWrite[]): void {
  const snapshot = cache
  let storageSnapshot: string | null = null
  if (typeof window !== 'undefined' && window.localStorage) {
    storageSnapshot = window.localStorage.getItem(STORAGE_KEY)
  }
  try {
    let next = { ...allRows() }
    for (const write of writes) {
      next = { ...next, [write.key]: write.rows }
    }
    cache = next
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch (error) {
    cache = snapshot
    if (typeof window !== 'undefined' && window.localStorage) {
      if (storageSnapshot === null) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, storageSnapshot)
      }
    }
    throw error
  }
}

export function nextId(key: string): number {
  const rows = listRows(key)
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
