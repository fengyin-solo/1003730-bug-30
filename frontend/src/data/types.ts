/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 乐观锁版本号：并发处置时只认最新版本，旧版本提交直接拒绝。 */
  version?: number
  /** 异常处置结论；并发处置只保留一条。 */
  conclusion?: string
  /** 地下水异常联动写入巡检后，回指的巡检记录编号（幂等键）。 */
  inspectionRef?: string
  /** 巡检记录来源：地下水异常联动生成时标记，便于另一个巡检页面回显来源。 */
  source?: string
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 异常识别/处置的处置台账记录（并发提交只记一次有效结果）。 */
export type AuditEntry = {
  id: number
  module: string
  refId: number
  kind: '异常识别' | '异常处置'
  conclusion: string
  operator: string
  createdAt: string
}
