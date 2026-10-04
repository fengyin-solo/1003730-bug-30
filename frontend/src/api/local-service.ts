import { MODULE_BY_KEY } from '@/data/modules'
import { commitWrites, listRows, resetRows } from '@/data/local-store'
import { deriveFlags, isAbnormalStatus, isPendingStatus } from '@/data/status'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

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

// 同一动作不允许回头路（已通过 → 提交审核），办结项不能再处置，从根上挡住重复生成、重复提交。
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (!isPendingStatus(meta, current)) {
    return { ok: false, message: `${meta.entity}已办结为「${current}」，不能再${action}` }
  }
  // 通用层保持宽松：设备维修、通讯恢复、重测确认等业务允许回到正常态；
  // 地下水等需要严格审核序的模块在各自领域服务里限定允许的来源状态。
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    ...deriveFlags(meta, { ...rows[index], status: target }),
  }
  const next = [...rows]
  next[index] = updated
  commitWrites([{ key, rows: next }])
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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

// 模块指标卡：与状态图例、概览共用同一套状态口径，数量不再各算各的。
function dateFieldOf(meta: ModuleMeta): string | undefined {
  return meta.fields.find((field) => field.includes('日期') || field.includes('时间') || field.includes('时段'))
}

function inCurrentPeriod(row: EntryRow, field: string | undefined, label: string): boolean {
  if (!field) {
    return true
  }
  const value = String(row[field] ?? '').slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  if (label.includes('今日')) {
    return value === today
  }
  if (label.includes('本月')) {
    return value.slice(0, 7) === today.slice(0, 7)
  }
  return true
}

export function metricValue(meta: ModuleMeta, label: string, rows: EntryRow[] = listRows(meta.key)): number {
  const dateField = dateFieldOf(meta)
  const periodRows = rows.filter((row) => inCurrentPeriod(row, dateField, label))
  const countByStatus = (predicate: (status: string) => boolean) =>
    rows.filter((row) => predicate(String(row.status))).length

  if (label.includes('待审核') || label.includes('待校核') || label.includes('待审批')) {
    return countByStatus((status) => ['待审核', '待校核', '待审批'].includes(status))
  }
  if (label.includes('待处置')) {
    return countByStatus((status) => status === '发现故障')
  }
  if (label.includes('待维修')) {
    return countByStatus((status) => status === '待维修')
  }
  if (label.includes('待维护')) {
    return countByStatus((status) => status === '待安排')
  }
  if (label.includes('待送检')) {
    return countByStatus((status) => status === '待送检')
  }
  if (label.includes('待整编')) {
    return countByStatus((status) => status === '待整编')
  }
  if (label.includes('检测中')) {
    return countByStatus((status) => status === '检测中')
  }
  if (label.includes('施工中')) {
    return countByStatus((status) => status === '施工中')
  }
  if (label.includes('整编中')) {
    return countByStatus((status) => status === '整编中')
  }
  if (label.includes('需检修')) {
    return countByStatus((status) => status === '需检修')
  }
  if (label.includes('需重测')) {
    return countByStatus((status) => status === '需重测')
  }
  if (label.includes('中断')) {
    return countByStatus((status) => status === '通讯中断')
  }
  if (label.includes('故障')) {
    return countByStatus((status) => status === '设备故障')
  }
  if (label.includes('不合格')) {
    return countByStatus((status) => status === '不合格')
  }
  if (label.includes('超标')) {
    return countByStatus((status) => status === '超标')
  }
  if (label.includes('已刊印')) {
    return countByStatus((status) => status === '已刊印')
  }
  if (label.includes('已生效')) {
    return countByStatus((status) => status === '已生效')
  }
  if (label.includes('本月调整')) {
    return periodRows.filter((row) => ['已生效', '已调整'].includes(String(row.status))).length
  }
  if (label.includes('本月已验收')) {
    return periodRows.filter((row) => String(row.status) === '已验收').length
  }
  if (label.includes('已巡检站点')) {
    return new Set(
      rows.filter((row) => ['已巡检', '发现故障', '已处置'].includes(String(row.status))).map((row) => String(row['站点编号'] ?? '')),
    ).size
  }
  if (label.includes('已批准')) {
    return countByStatus((status) => status === '已批准')
  }
  if (label.includes('已合格')) {
    return countByStatus((status) => status === '已合格')
  }
  if (label.includes('正常运行') || label.includes('通讯正常')) {
    return countByStatus((status) => status === '正常运行' || status === '通讯正常')
  }
  if (label.includes('异常')) {
    return rows.filter((row) => isAbnormalStatus(meta, String(row.status))).length
  }
  if (label.includes('暴雨') || label.includes('超警戒')) {
    return rows.filter((row) => isAbnormalStatus(meta, String(row.status))).length
  }
  // 今日/本月类次数卡按观测/采集/测量时间落在当期统计。
  if (label.includes('今日') || label.includes('本月')) {
    return periodRows.length
  }
  // 各类「总数」卡兜底。
  return rows.length
}

export function computeStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  return meta.metrics.map((label) => ({ label, value: metricValue(meta, label) }))
}

export { isPendingStatus }

export function loadOverview(): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = listRows(meta.key)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => isPendingStatus(meta, String(row.status))).length,
      abnormal: entries.filter((row) => isAbnormalStatus(meta, String(row.status))).length,
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
