<template>
  <section class="page" data-module="groundwater">
    <header class="page-head">
      <div>
        <h2>地下水观测管理</h2>
        <p class="page-desc">维护地下水观测记录，围绕记录编号、井点编号、观测日期、埋深值做登记、异常识别、处置与审核流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记地下水观测记录</button>
        <button class="btn" type="button" :disabled="identifying" @click="runIdentify">异常识别（埋深/标高/异常井点）</button>
        <button class="btn" type="button" @click="exportRows">导出地下水观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>异常来源</th>
          <th>处置结论</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row['异常来源'] ?? '—' }}</td>
          <td>{{ row['处置结论'] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action.label"
              class="link"
              type="button"
              :disabled="busyIds.has(Number(row.id))"
              @click="runRowAction(action, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无地下水观测数据，可先登记地下水观测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地下水观测记录</span>
      <span v-if="noticeMessage" :class="noticeOk ? 'ok-text' : 'error-text'">{{ noticeMessage }}</span>
    </footer>

    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记地下水观测记录</h3>
        <label class="modal-field">
          <span>井点编号 *</span>
          <input v-model="draft.wellNo" placeholder="如 GW-007" />
        </label>
        <label class="modal-field">
          <span>观测日期</span>
          <input v-model="draft.observedAt" type="date" />
        </label>
        <label class="modal-field">
          <span>埋深值（原始读数，支持 12.5 / 12.5m）</span>
          <input v-model="draft.depth" placeholder="原始读数照录，异常由识别环节判定" />
        </label>
        <label class="modal-field">
          <span>水位标高（原始读数）</span>
          <input v-model="draft.elevation" placeholder="原始读数照录" />
        </label>
        <label class="modal-field">
          <span>水温</span>
          <input v-model="draft.temperature" />
        </label>
        <label class="modal-field">
          <span>观测人（旧记录缺失可留空）</span>
          <input v-model="draft.observer" placeholder="留空即保持缺观测人，不补造" />
        </label>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>
    </div>

    <div v-if="disposeTarget" class="modal-mask" @click.self="closeDispose">
      <form class="modal" @submit.prevent="submitDispose">
        <h3>异常处置：{{ disposeTarget['记录编号'] }}</h3>
        <p class="modal-tip">异常来源：{{ disposeTarget['异常来源'] || '人工标记' }}</p>
        <label class="modal-field">
          <span>处置结论 *</span>
          <textarea v-model="disposeConclusion" rows="3" placeholder="如：复测读数正常，原因为测绳卡滞，已更换测具并复测"></textarea>
        </label>
        <label class="modal-field">
          <span>处置人</span>
          <input v-model="disposeOperator" />
        </label>
        <p class="modal-tip">提交后同步写入一条「已处置」巡检核查记录，三处写入失败将一起回退。</p>
        <p v-if="disposeError" class="error-text">{{ disposeError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDispose">取消</button>
          <button class="btn primary" type="submit" :disabled="disposing">提交处置（并发仅记一次）</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  approve,
  createEntry,
  disposeAbnormal,
  identifyAbnormalWells,
  markAbnormal,
  submitForReview,
} from '@/api/groundwater-service'
import {
  computeStats,
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('groundwater')
const columns = ["记录编号", "井点编号", "观测日期", "埋深值", "水位标高", "水温", "观测人", "记录状态"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const noticeMessage = ref('')
const noticeOk = ref(true)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = ref<{ label: string; value: number }[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const identifying = ref(false)
const busyIds = ref<Set<number>>(new Set())

function notify(message: string, ok = true) {
  noticeMessage.value = message
  noticeOk.value = ok
}

function displayValue(row: EntryRow, column: string): string {
  if (column === '记录状态') {
    return String(row.status ?? '—')
  }
  const value = row[column]
  return value === undefined || value === null || String(value) === '' ? '—' : String(value)
}

type RowAction = { label: string; kind: 'submit' | 'approve' | 'mark' | 'dispose' }

// 按状态给出动作，办结（已通过）记录没有任何可执行动作，确认通过后待办立即消失。
function rowActions(row: EntryRow): RowAction[] {
  switch (String(row.status)) {
    case '已采集':
      return [
        { label: '提交审核', kind: 'submit' },
        { label: '标记异常', kind: 'mark' },
      ]
    case '待审核':
      return [{ label: '确认通过', kind: 'approve' }]
    case '异常值':
      return [
        { label: '处置异常', kind: 'dispose' },
        { label: '提交审核', kind: 'submit' },
      ]
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runIdentify() {
  identifying.value = true
  try {
    const result = identifyAbnormalWells()
    notify(result.message, result.ok)
    reload()
  } finally {
    identifying.value = false
  }
}

function runRowAction(action: RowAction, row: EntryRow) {
  const id = Number(row.id)
  if (action.kind === 'dispose') {
    openDispose(row)
    return
  }
  busyIds.value = new Set(busyIds.value).add(id)
  try {
    let result
    if (action.kind === 'submit') {
      result = submitForReview(id)
    } else if (action.kind === 'approve') {
      result = approve(id)
    } else {
      result = markAbnormal(id)
    }
    notify(result.message, result.ok)
    reload()
  } finally {
    const next = new Set(busyIds.value)
    next.delete(id)
    busyIds.value = next
  }
}

const createOpen = ref(false)
const createError = ref('')
const emptyDraft = () => ({
  wellNo: '',
  observedAt: new Date().toISOString().slice(0, 10),
  depth: '',
  elevation: '',
  temperature: '',
  observer: '',
})
const draft = reactive(emptyDraft())

function openCreate() {
  createError.value = ''
  Object.assign(draft, emptyDraft())
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function submitCreate() {
  const result = createEntry(draft)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  notify(result.message, true)
  reload()
}

const disposeTarget = ref<EntryRow | null>(null)
const disposeConclusion = ref('')
const disposeOperator = ref(session.operator)
const disposeError = ref('')
const disposing = ref(false)

function openDispose(row: EntryRow) {
  disposeTarget.value = row
  disposeConclusion.value = ''
  disposeOperator.value = session.operator
  disposeError.value = ''
}

function closeDispose() {
  if (disposing.value) {
    return
  }
  disposeTarget.value = null
}

async function submitDispose() {
  if (!disposeTarget.value) {
    return
  }
  const id = Number(disposeTarget.value.id)
  disposing.value = true
  try {
    // 并发处置只保留一条结论：服务层按记录加锁，重复提交合并为同一结果。
    const result = await disposeAbnormal(id, {
      conclusion: disposeConclusion.value,
      operator: disposeOperator.value || session.operator,
    })
    if (!result.ok) {
      disposeError.value = result.message
      return
    }
    disposeTarget.value = null
    notify(result.message, true)
    reload()
  } finally {
    disposing.value = false
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = computeStats(meta.key)
  } catch (error) {
    notify(error instanceof Error ? error.message : '地下水观测列表读取失败', false)
  }
}

onMounted(reload)
</script>
