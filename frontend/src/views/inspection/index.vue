<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检记录管理</h2>
        <p class="page-desc">维护巡检记录，围绕记录编号、站点编号、巡检日期、巡检人员做登记、筛选与状态流转；地下水异常核查事项在此一并处置闭环。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡检记录清单</button>
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
          <th>来源</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>
            <span v-if="row.source" class="tag-warn">{{ row.source }}</span>
            <span v-else>日常巡检</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(meta, String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(meta, String(row.status)).length" class="tag-warn">已闭环</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无巡检记录数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <div v-if="disposingRow" class="modal-mask" @click.self="closeDispose">
      <div class="modal-card">
        <h3 class="modal-title">{{ isLinkedTask ? '地下水异常核查处置' : '巡检故障处置' }}</h3>
        <p class="modal-desc">
          站点 {{ disposingRow.站点编号 }}（{{ disposingRow.记录编号 }}）。
          <template v-if="isLinkedTask">该事项由地下水异常联动生成，提交后地下水记录与巡检事项同步闭环，只记首次结论。</template>
          <template v-else>结论将写入处理措施并关闭本次故障事项。</template>
        </p>
        <div class="form-grid">
          <label class="form-field full">
            <span>处置结论 *</span>
            <textarea v-model="disposeText" placeholder="请填写现场核查与处理情况"></textarea>
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDispose">取消</button>
          <button class="btn primary" type="button" @click="submitDispose">提交处置结论</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  handleInspection,
  inspectionStats,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { ABNORMAL_SOURCE } from '@/data/linkage'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('inspection')
// 业务字段不再含「巡检状态」：当前状态只认权威列，避免一行两个状态。
const columns = ["记录编号", "站点编号", "巡检日期", "巡检人员", "检查项目", "发现问题", "处理措施"]
const statuses = ["待巡检", "已巡检", "发现故障", "已处置"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref(inspectionStats())
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "站点编号", "巡检日期"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function flashSuccess(message: string) {
  successMessage.value = message
  errorMessage.value = ''
}

function flashError(message: string) {
  errorMessage.value = message
  successMessage.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  flashError('巡检记录登记入口尚未接入审批流')
}

const disposingRow = ref<EntryRow | null>(null)
const disposeText = ref('')
const formError = ref('')

const isLinkedTask = computed(
  () =>
    disposingRow.value !== null &&
    (String(disposingRow.value.source) === ABNORMAL_SOURCE ||
      /^INSP-GW-\d+$/.test(String(disposingRow.value.记录编号 ?? ''))),
)

function closeDispose() {
  disposingRow.value = null
  disposeText.value = ''
  formError.value = ''
}

function runAction(action: string, row: EntryRow) {
  if (action === '确认处置') {
    disposingRow.value = row
    disposeText.value = String(row.conclusion ?? '')
    formError.value = ''
    return
  }
  const result = applyAction(meta.key, Number(row.id), action, { expectedVersion: row.version })
  finishAction(result)
}

function submitDispose() {
  if (!disposingRow.value) {
    return
  }
  const result = handleInspection(
    Number(disposingRow.value.id),
    disposeText.value,
    undefined,
    disposingRow.value.version,
  )
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeDispose()
  reload()
  flashSuccess(result.message)
}

function finishAction(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    flashError(result.message)
    return
  }
  reload()
  flashSuccess(result.message)
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = inspectionStats()
  } catch (error) {
    flashError(error instanceof Error ? error.message : '巡检记录列表读取失败')
  }
}

onMounted(reload)
</script>
