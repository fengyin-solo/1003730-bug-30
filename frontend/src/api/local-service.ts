import {
  AUDIT_LEDGER_KEY,
  GROUNDWATER_KEY,
  INSPECTION_KEY,
  ABNORMAL_SOURCE,
  buildAuditEntry,
  buildInspectionTask,
  checkGroundwaterReading,
  nextId,
} from '@/data/linkage'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  auditLedger,
  commitMap,
  listRows,
  resetRows,
} from '@/data/local-store'
import {
  MIRROR_STATUS_FIELD,
  canTransit,
  isAbnormalStatus,
  isPendingStatus,
} from '@/data/status-rules'
import type { ActionResult, AuditEntry, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 处置在途锁：同一事项的提交未结束前，第二个并发提交直接挡回 —— 只记一次有效结果。
const inflightKeys = new Set<string>()

function lock(key: string): ActionResult | null {
  if (inflightKeys.has(key)) {
    return { ok: false, message: '该事项正在处置中，请勿重复提交' }
  }
  inflightKeys.add(key)
  return null
}

function unlock(key: string): void {
  inflightKeys.delete(key)
}

// 仅供验证脚本/测试：模拟第一笔异步提交尚未结束的在途状态。
export function __holdLockForTest(key: string, held: boolean): void {
  if (held) {
    inflightKeys.add(key)
  } else {
    inflightKeys.delete(key)
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 以权威状态为中心组装新行：待办、异常标志、镜像状态字段、版本号全部从状态推导，
// 不再出现「确认通过后待办不消」「标记异常后概览不计数」这种分叉。
function applyStatus(meta: ModuleMeta, row: EntryRow, target: string): EntryRow {
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal: isAbnormalStatus(meta, target),
    version: (typeof row.version === 'number' ? row.version : 1) + 1,
  }
  const mirror = MIRROR_STATUS_FIELD[meta.key]
  if (mirror) {
    updated[mirror] = target
  }
  return updated
}

// 当前状态下页面允许展示的动作：不满足流转前置条件的按钮不再渲染，从入口上杜绝重复处置。
export function availableActions(meta: ModuleMeta, status: string): string[] {
  return meta.actions.filter((action) => canTransit(meta.key, action, status))
}

type RunOptions = {
  expectedVersion?: number
  operator?: string
}

export function runAction(key: string, id: number, action: string, options: RunOptions = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const lockKey = `${key}:${id}:${action}`
  const busy = lock(lockKey)
  if (busy) {
    return busy
  }
  try {
    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const current = rows[index]
    const currentStatus = String(current.status)
    if (!canTransit(key, action, currentStatus)) {
      if (currentStatus === target) {
        return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
      }
      return { ok: false, message: `当前状态「${currentStatus}」不能执行「${action}」` }
    }
    if (typeof options.expectedVersion === 'number' && current.version !== options.expectedVersion) {
      // 乐观锁：别人已经先处置过，本次并发提交作废，不会再写一遍。
      return { ok: false, message: '记录已被其他人处置，页面数据已更新，请刷新后查看最新结论' }
    }
    const nextRows = [...rows]
    nextRows[index] = applyStatus(meta, current, target)
    try {
      commitMap((draft) => {
        draft[key] = nextRows
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '提交失败，已整体回退' }
    }
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } finally {
    unlock(lockKey)
  }
}

function findRow(rows: EntryRow[], id: number): { row: EntryRow; index: number } | null {
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { row: rows[index], index }
}

function ledgerHas(kind: AuditEntry['kind'], refId: number): boolean {
  return auditLedger().some((entry) => entry.kind === kind && entry.refId === refId)
}

// 异常识别（三处写入：地下水记录置异常、联动生成巡检核查、台账留痕）。
// 幂等：同一异常井反复识别只保留一条核查事项；旧缺观测人允许留空。
export function identifyGroundwaterAbnormal(
  id: number,
  reason: string,
  operator = '值班管理员',
): ActionResult {
  const lockKey = `gw-identify:${id}`
  const busy = lock(lockKey)
  if (busy) {
    return busy
  }
  try {
    const gwRows = listRows(GROUNDWATER_KEY)
    const found = findRow(gwRows, id)
    if (!found) {
      return { ok: false, message: `没有找到编号为 ${id} 的地下水观测记录` }
    }
    const gwMeta = moduleMeta(GROUNDWATER_KEY)
    const gwRow = found.row
    if (String(gwRow.status) === '异常值') {
      if (gwRow.inspectionRef) {
        return { ok: false, message: '该异常井点已生成巡检核查事项，请勿重复生成' }
      }
    } else if (!canTransit(GROUNDWATER_KEY, '标记异常', String(gwRow.status))) {
      return { ok: false, message: `当前状态「${gwRow.status}」不能标记异常` }
    }
    if (ledgerHas('异常识别', id)) {
      return { ok: false, message: '该记录已有异常识别结论，只保留一条' }
    }
    const inspectionRows = listRows(INSPECTION_KEY)
    const ref = `INSP-GW-${String(id).padStart(4, '0')}`
    if (gwRow.inspectionRef || inspectionRows.some((row) => row.记录编号 === ref)) {
      return { ok: false, message: '巡检核查事项已存在，不能重复生成' }
    }

    const nextGw = [...gwRows]
    const updated = applyStatus(gwMeta, gwRow, '异常值')
    updated.异常原因 = reason || String(gwRow.异常原因 ?? '人工标记埋深读数异常')
    const task = buildInspectionTask(updated, nextId(inspectionRows))
    updated.inspectionRef = ref
    nextGw[found.index] = updated
    const audit = buildAuditEntry(nextId(auditLedger()), id, '异常识别', String(updated.异常原因), operator)

    try {
      commitMap((draft) => {
        draft[GROUNDWATER_KEY] = nextGw
        draft[INSPECTION_KEY] = [...inspectionRows, task]
        const ledger = (draft[AUDIT_LEDGER_KEY] as AuditEntry[] | undefined) ?? []
        draft[AUDIT_LEDGER_KEY] = [...ledger, audit]
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '异常识别写入失败，已整体回退' }
    }
    return { ok: true, message: `已标记异常并联动生成巡检核查事项 ${ref}` }
  } finally {
    unlock(lockKey)
  }
}

type DisposeSource = typeof GROUNDWATER_KEY | typeof INSPECTION_KEY

// 异常处置：地下水页面与巡检页面共用同一条闭环路径。
// 并发处置只保留一条结论（在途锁 + 台账幂等 + 乐观版本），三处写入任一失败整体回退。
export function disposeGroundwaterAbnormal(
  source: DisposeSource,
  id: number,
  conclusion: string,
  operator = '值班管理员',
  expectedVersion?: number,
): ActionResult {
  const text = conclusion.trim()
  if (!text) {
    return { ok: false, message: '请填写核查处置结论后再提交' }
  }
  let gwId = id
  if (source === INSPECTION_KEY) {
    const task = listRows(INSPECTION_KEY).find((row) => Number(row.id) === id)
    if (!task) {
      return { ok: false, message: `没有找到编号为 ${id} 的巡检记录` }
    }
    const ref = String(task.记录编号 ?? '')
    const matched = ref.match(/^INSP-GW-(\d+)$/)
    if (!matched) {
      return { ok: false, message: '该巡检记录不是地下水异常核查事项' }
    }
    gwId = Number(matched[1])
  }
  const lockKey = `gw-dispose:${gwId}`
  const busy = lock(lockKey)
  if (busy) {
    return busy
  }
  try {
    const gwRows = listRows(GROUNDWATER_KEY)
    const gwFound = findRow(gwRows, gwId)
    if (!gwFound) {
      return { ok: false, message: `没有找到编号为 ${gwId} 的地下水观测记录` }
    }
    const gwRow = gwFound.row
    if (String(gwRow.status) !== '异常值') {
      return { ok: false, message: '该井点已有处置结论，无需重复处置' }
    }
    if (ledgerHas('异常处置', gwId)) {
      return { ok: false, message: '处置结论已登记，并发提交只记录一次有效结果' }
    }
    if (typeof expectedVersion === 'number' && gwRow.version !== expectedVersion) {
      return { ok: false, message: '记录已被其他人处置，请刷新后查看最新结论' }
    }

    const inspectionRows = listRows(INSPECTION_KEY)
    const ref = String(gwRow.inspectionRef ?? `INSP-GW-${String(gwId).padStart(4, '0')}`)
    const taskIndex = inspectionRows.findIndex((row) => row.记录编号 === ref)
    if (taskIndex < 0) {
      return { ok: false, message: '联动巡检核查事项缺失，已中止处置（数据未改动）' }
    }
    const task = inspectionRows[taskIndex]
    if (String(task.status) === '已处置') {
      return { ok: false, message: '巡检侧已完成处置，结论以首次提交为准' }
    }

    const gwMeta = moduleMeta(GROUNDWATER_KEY)
    const inspMeta = moduleMeta(INSPECTION_KEY)
    const nextGw = [...gwRows]
    const closedGw = applyStatus(gwMeta, gwRow, '已通过')
    closedGw.conclusion = text
    nextGw[gwFound.index] = closedGw

    const nextInspection = [...inspectionRows]
    const closedTask = applyStatus(inspMeta, task, '已处置')
    closedTask.处理措施 = text
    closedTask.核查结论 = text
    if (!closedTask.巡检人员) {
      closedTask.巡检人员 = operator
    }
    nextInspection[taskIndex] = closedTask

    const audit = buildAuditEntry(nextId(auditLedger()), gwId, '异常处置', text, operator)

    try {
      commitMap((draft) => {
        draft[GROUNDWATER_KEY] = nextGw
        draft[INSPECTION_KEY] = nextInspection
        const ledger = (draft[AUDIT_LEDGER_KEY] as AuditEntry[] | undefined) ?? []
        draft[AUDIT_LEDGER_KEY] = [...ledger, audit]
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '处置提交失败，三处写入已整体回退' }
    }
    return { ok: true, message: `处置完成：${text}（地下水与巡检核查已同步闭环）` }
  } finally {
    unlock(lockKey)
  }
}

// 巡检页面自身的确认处置：地下水联动事项走双写闭环；普通故障只写巡检一侧。
export function handleInspection(
  id: number,
  conclusion: string,
  operator = '值班管理员',
  expectedVersion?: number,
): ActionResult {
  const task = listRows(INSPECTION_KEY).find((row) => Number(row.id) === id)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${id} 的巡检记录` }
  }
  if (String(task.source) === ABNORMAL_SOURCE || /^INSP-GW-\d+$/.test(String(task.记录编号 ?? ''))) {
    return disposeGroundwaterAbnormal(INSPECTION_KEY, id, conclusion, operator, expectedVersion)
  }
  return runAction(INSPECTION_KEY, id, '确认处置', { expectedVersion, operator })
}

export type CreateGroundwaterInput = {
  井点编号: string
  观测日期: string
  埋深值: string
  水位标高: string
  水温?: string
  观测人?: string
}

// 登记地下水观测记录：记录编号唯一（防多入口重复生成），登记即按原始读数做异常识别；
// 埋深/水位标高保留原始读数文本，判异只解析其中数字，历史非数值读数照常保存。
export function createGroundwaterEntry(input: CreateGroundwaterInput, operator = '值班管理员'): ActionResult {
  const wellNo = input.井点编号.trim()
  const date = input.观测日期.trim()
  const depthRaw = input.埋深值.trim()
  if (!wellNo || !date || !depthRaw) {
    return { ok: false, message: '井点编号、观测日期、埋深值为必填项' }
  }
  const rows = listRows(GROUNDWATER_KEY)
  const id = nextId(rows)
  const recordNo = `GROU-${String(id).padStart(4, '0')}`
  if (rows.some((row) => row.记录编号 === recordNo || (row.井点编号 === wellNo && row.观测日期 === date))) {
    return { ok: false, message: '同一井点同一天的观测记录已存在，不能重复登记' }
  }
  const meta = moduleMeta(GROUNDWATER_KEY)
  const check = checkGroundwaterReading({ 埋深值: depthRaw, 水位标高: input.水位标高 })

  const initialStatus = check.abnormal ? '异常值' : '已采集'
  const created: EntryRow = {
    id,
    status: initialStatus,
    pending: isPendingStatus(meta, initialStatus),
    abnormal: check.abnormal,
    version: 1,
    记录编号: recordNo,
    井点编号: wellNo,
    观测日期: date,
    埋深值: depthRaw,
    水位标高: input.水位标高?.trim() ?? '',
    水温: input.水温?.trim() ?? '',
    观测人: input.观测人?.trim() ?? '', // 旧记录缺观测人保持留空，不强制补值
    记录状态: check.abnormal ? '异常值' : '已采集',
  }

  const lockKey = `gw-create:${id}`
  const busy = lock(lockKey)
  if (busy) {
    return busy
  }
  try {
    if (check.abnormal) {
      created.异常原因 = check.reason
      const inspectionRows = listRows(INSPECTION_KEY)
      const ref = `INSP-GW-${String(id).padStart(4, '0')}`
      created.inspectionRef = ref
      const task = buildInspectionTask(created, nextId(inspectionRows))
      const audit = buildAuditEntry(nextId(auditLedger()), id, '异常识别', check.reason, operator)
      try {
        commitMap((draft) => {
          draft[GROUNDWATER_KEY] = [...rows, created]
          draft[INSPECTION_KEY] = [...inspectionRows, task]
          const ledger = (draft[AUDIT_LEDGER_KEY] as AuditEntry[] | undefined) ?? []
          draft[AUDIT_LEDGER_KEY] = [...ledger, audit]
        })
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '登记失败，已整体回退' }
      }
      return { ok: true, message: `登记成功，读数判定异常（${check.reason}），已联动生成巡检核查事项 ${ref}` }
    }
    try {
      commitMap((draft) => {
        draft[GROUNDWATER_KEY] = [...rows, created]
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '登记失败，已整体回退' }
    }
    return { ok: true, message: `登记成功，记录编号 ${recordNo}` }
  } finally {
    unlock(lockKey)
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export type ModuleStats = { label: string; value: number }[]

function currentMonthPrefix(): string {
  return new Date().toISOString().slice(0, 7)
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

// 页面卡片统计与列表、概览共用同一份行数据、同一套状态语义，不再各写死一个 0。
export function groundwaterStats(): ModuleStats {
  const rows = listRows(GROUNDWATER_KEY)
  const today = todayText()
  return [
    { label: '今日观测井次', value: rows.filter((row) => row.观测日期 === today).length },
    { label: '待审核记录', value: rows.filter((row) => String(row.status) === '待审核').length },
    { label: '异常记录数', value: rows.filter((row) => String(row.status) === '异常值').length },
  ]
}

export function inspectionStats(): ModuleStats {
  const rows = listRows(INSPECTION_KEY)
  const monthPrefix = currentMonthPrefix()
  const monthRows = rows.filter((row) => String(row.巡检日期 ?? '').startsWith(monthPrefix))
  const inspected = monthRows.filter((row) =>
    ['已巡检', '发现故障', '已处置'].includes(String(row.status)),
  )
  return [
    { label: '本月巡检次数', value: inspected.length },
    { label: '已巡检站点', value: new Set(inspected.map((row) => String(row.站点编号))).size },
    { label: '待处置故障', value: rows.filter((row) => String(row.status) === '发现故障').length },
  ]
}

export function loadOverview(): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = listRows(meta.key)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
