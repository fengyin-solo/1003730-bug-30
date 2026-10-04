import type { ModuleMeta } from './types'

// 状态语义统一规则层：
// 列表、概览、巡检的数量都从「权威状态 status」推导，
// 不再用「状态数组最后一位」「动作名是否含驳回等字眼」这种与业务语义分叉的取巧规则。

export type StatusSemantics = {
  // 终态：事情办完，不再进待办
  closed: string[]
  // 异常态：需要被统计为异常、生成核查事项
  abnormal: string[]
}

// 允许的流转：既是页面按钮的显隐依据，也是写入侧的强校验。
// 不在表里的动作一律拒绝，杜绝任意状态下重复处置。
export const ALLOWED_TRANSITIONS: Record<string, Record<string, string[]>> = {
  groundwater: {
    提交审核: ['已采集'],
    确认通过: ['已采集', '待审核', '异常值'],
    标记异常: ['已采集', '待审核'],
    处置异常: ['异常值'],
  },
  inspection: {
    完成巡检: ['待巡检'],
    报告故障: ['待巡检', '已巡检'],
    确认处置: ['发现故障', '已巡检'],
  },
  waterlevel: { 提交审核: ['已采集'], 确认通过: ['已采集', '待审核'], 标记异常: ['已采集', '待审核'] },
  discharge: { 提交审核: ['已采集'], 确认通过: ['已采集', '待审核'], 标记异常: ['已采集', '待审核'] },
  rainfall: { 提交审核: ['已采集'], 确认通过: ['已采集', '待审核'], 标记异常: ['已采集', '待审核'] },
  evaporation: { 提交审核: ['已采集'], 确认通过: ['已采集', '待审核'], 标记异常: ['已采集', '待审核'] },
  sediment: { 提交审核: ['已采集'], 确认通过: ['已采集', '待审核'], 标记异常: ['已采集', '待审核'] },
  waterquality: { 开始检测: ['已采样'], 出具报告: ['检测中'], 发起复核: ['超标', '已出报告'] },
  crosssection: { 提交校核: ['已测量'], 确认校核: ['待校核'], 安排重测: ['已校核', '待校核'] },
  station: { 升级为加强: ['正常运行'], 登记故障: ['正常运行', '汛期加强'], 撤销站点: ['正常运行', '设备故障', '汛期加强'] },
  telemetry: { 报修设备: ['正常运行', '信号异常', '低电量'], 确认修复: ['信号异常', '低电量', '待维修'], 停用设备: ['正常运行', '信号异常', '低电量', '待维修'] },
  compilation: { 开始整编: ['待整编'], 提交审核: ['整编中'], 驳回整编: ['待审核', '整编中'] },
  warning: { 发布生效: ['草稿'], 调整阈值: ['已生效'], 停用配置: ['草稿', '已生效', '已调整'] },
  cableway: { 安排检修: ['正常运行'], 完成检修: ['需检修', '检修中'], 停用缆道: ['正常运行', '需检修', '检修中'] },
  communication: { 登记故障: ['通讯正常', '信号弱'], 确认恢复: ['信号弱', '通讯中断'], 申请更换: ['通讯正常', '信号弱', '通讯中断'] },
  stationhouse: { 安排维护: ['待安排'], 确认完工: ['已安排', '施工中'], 通过验收: ['已完成'] },
  calibration: { 送出检定: ['待送检'], 确认合格: ['送检中'], 标记不合格: ['送检中'] },
  plan: { 提交审批: ['编制中'], 批准方案: ['待审批'], 废止方案: ['编制中', '待审批', '已批准', '已修订'] },
}

// 各模块的终态/异常态语义。权威状态只有一个（row.status），
// pending / abnormal 两个旧标志位在读取时按下表归一化，旧数据也能自动愈合。
const SEMANTICS: Record<string, StatusSemantics> = {
  // 审核流：已通过=关闭，异常值=异常；待审核与已采集都是待办
  groundwater: { closed: ['已通过'], abnormal: ['异常值'] },
  waterlevel: { closed: ['已通过'], abnormal: ['异常值'] },
  discharge: { closed: ['已通过'], abnormal: ['异常值'] },
  rainfall: { closed: ['已通过'], abnormal: ['异常值'] },
  evaporation: { closed: ['已通过'], abnormal: ['异常值'] },
  sediment: { closed: ['已通过'], abnormal: ['异常值'] },
  // 巡检：已处置=关闭，发现故障=异常待处置
  inspection: { closed: ['已处置'], abnormal: ['发现故障'] },
  waterquality: { closed: ['已复核'], abnormal: ['超标'] },
  crosssection: { closed: ['已校核'], abnormal: ['需重测'] },
  station: { closed: ['暂停运行', '已撤销'], abnormal: ['设备故障'] },
  telemetry: { closed: ['已停用'], abnormal: ['信号异常', '低电量', '待维修'] },
  compilation: { closed: ['已刊印'], abnormal: ['已驳回'] },
  warning: { closed: ['已停用'], abnormal: [] },
  cableway: { closed: ['已停用'], abnormal: ['需检修', '检修中'] },
  communication: { closed: ['待更换'], abnormal: ['信号弱', '通讯中断'] },
  stationhouse: { closed: ['已验收'], abnormal: [] },
  calibration: { closed: ['已停用'], abnormal: ['不合格'] },
  plan: { closed: ['已废止'], abnormal: [] },
}

const ABNORMAL_HINTS = ['异常', '超标', '故障', '重测', '驳回', '中断', '停用', '不合格', '撤销', '更换', '检修']

function fallbackSemantics(meta: ModuleMeta): StatusSemantics {
  const abnormal = meta.statuses.filter((status) => ABNORMAL_HINTS.some((hint) => status.includes(hint)))
  // 兜底：最后一位视为终态；异常态即使在最后也不算关闭
  const last = meta.statuses[meta.statuses.length - 1]
  const closed = abnormal.includes(last) ? meta.statuses.slice(-2, -1) : [last]
  return { closed, abnormal }
}

export function statusSemantics(meta: ModuleMeta): StatusSemantics {
  return SEMANTICS[meta.key] ?? fallbackSemantics(meta)
}

export function isClosedStatus(meta: ModuleMeta, status: string): boolean {
  return statusSemantics(meta).closed.includes(status)
}

export function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  return statusSemantics(meta).abnormal.includes(status)
}

// 待办 = 既没关闭、也不是异常终态之外的中间态；异常未处置同样算待办（要有人去核查处置）
export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  const rule = statusSemantics(meta)
  return !rule.closed.includes(status)
}

export function canTransit(key: string, action: string, currentStatus: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[key]?.[action]
  return Array.isArray(allowed) && allowed.includes(currentStatus)
}

// 各模块表格最后一列是与 status 同义的业务状态字段，流转时一并回写，消除一行两状态。
export const MIRROR_STATUS_FIELD: Record<string, string> = {
  groundwater: '记录状态',
  inspection: '巡检状态',
  waterlevel: '记录状态',
  discharge: '记录状态',
  rainfall: '记录状态',
  evaporation: '记录状态',
  sediment: '记录状态',
  waterquality: '报告状态',
  crosssection: '记录状态',
  station: '运行状态',
  telemetry: '设备状态',
  compilation: '整编状态',
  warning: '生效状态',
  cableway: '缆道状态',
  communication: '设备状态',
  stationhouse: '维护状态',
  calibration: '检定状态',
  plan: '方案状态',
}
