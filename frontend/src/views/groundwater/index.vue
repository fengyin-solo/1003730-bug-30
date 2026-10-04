<template>
  <section class="page" data-module="groundwater">
    <header class="page-head">
      <div>
        <h2>地下水观测管理</h2>
        <p class="page-desc">维护地下水观测记录，围绕记录编号、井点编号、观测日期、埋深值做登记、筛选与状态流转；异常井统一联动巡检核查。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记地下水观测记录</button>
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
          <th>当前状态</th>
          <th>巡检核查</th>
          <th>处置结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span v-if="row.inspectionRef" class="tag-link">{{ row.inspectionRef }}</span>
            <span v-else>—</span>
          </td>
          <td>{{ row.conclusion || '—' }}</td>
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
          <td :colspan="columns.length + 4" class="empty-state">暂无地下水观测数据，可先登记地下水观测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地下水观测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <div class="modal-card">
        <h3 class="modal-title">登记地下水观测记录</h3>
        <p class="modal-desc">保存原始读数（埋深值、水位标高）；埋深超出 {{ depthRangeText }} 将自动识别为异常井并联动巡检核查。</p>
        <div class="form-grid">
          <label class="form-field">
            <span>井点编号 *</span>
            <input v-model="form.井点编号" placeholder="如 GW-1024" />
          </label>
          <label class="form-field">
            <span>观测日期 *</span>
            <input v-model="form.观测日期" type="date" />
          </label>
          <label class="form-field">
            <span>埋深值（m）*</span>
            <input v-model="form.埋深值" placeholder="原始读数，如 32.6" />
          </label>
          <label class="form-field">
            <span>水位标高（m）</span>
            <input v-model="form.水位标高" placeholder="原始读数，可留空" />
          </label>
          <label class="form-field">
            <span>水温（℃）</span>
            <input v-model="form.水温" />
          </label>
          <label class="form-field">
            <span>观测人</span>
            <input v-model="form.观测人" placeholder="可留空" />
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">保存登记</button>
        </div>
      </div>
    </div>

    <div v-if="disposingRow" class="modal-mask" @click.self="closeDispose">
      <div class="modal-card">
        <h3 class="modal-title">异常井点核查处置</h3>
        <p class="modal-desc">
          井点 {{ disposingRow.井点编号 }}（{{ disposingRow.记录编号 }}）已联动巡检 {{ disposingRow.inspectionRef }}，
          结论提交后地下水与巡检两处同步闭环，并发提交只记首次结论。
        </p>
        <div class="form-grid">
          <label class="form-field full">
            <span>核查处置结论 *</span>
            <textarea v-model="disposeText" placeholder="如：复测埋深 12.4m，原读数为仪器气泡误差，已重测合格"></textarea>
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
import { computed, onMounted, reactive, ref } from 'vue'

import {
  availableActions,
  createGroundwaterEntry,
  downloadEntries,
  disposeGroundwaterAbnormal,
  groundwaterStats,
  identifyGroundwaterAbnormal,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { DEPTH_MAX, DEPTH_MIN } from '@/data/linkage'

const meta = moduleMeta('groundwater')
// 业务字段不再含「记录状态」：当前状态只认权威列，杜绝一行回显两个状态。
const columns = ["记录编号", "井点编号", "观测日期", "埋深值", "水位标高", "水温", "观测人"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const depthRangeText = `${DEPTH_MIN}~${DEPTH_MAX}m`

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref(groundwaterStats())
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "井点编号", "观测日期"]
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

const showCreate = ref(false)
const formError = ref('')
const emptyForm = () => ({
  井点编号: '',
  观测日期: new Date().toISOString().slice(0, 10),
  埋深值: '',
  水位标高: '',
  水温: '',
  观测人: '',
})
const form = reactive(emptyForm())

function openCreate() {
  Object.assign(form, emptyForm())
  formError.value = ''
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
  formError.value = ''
}

function submitCreate() {
  formError.value = ''
  const result = createGroundwaterEntry(form)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  showCreate.value = false
  reload()
  flashSuccess(result.message)
}

const disposingRow = ref<EntryRow | null>(null)
const disposeText = ref('')

function closeDispose() {
  disposingRow.value = null
  disposeText.value = ''
  formError.value = ''
}

function runAction(action: string, row: EntryRow) {
  if (action === '标记异常') {
    // 多入口里的人工异常识别，统一走联动写入，避免重复生成巡检核查
    const result = identifyGroundwaterAbnormal(Number(row.id), '')
    finishAction(result)
    return
  }
  if (action === '处置异常') {
    disposingRow.value = row
    disposeText.value = ''
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
  const result = disposeGroundwaterAbnormal(
    'groundwater',
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
    stats.value = groundwaterStats()
  } catch (error) {
    flashError(error instanceof Error ? error.message : '地下水观测列表读取失败')
  }
}

onMounted(reload)
</script>
