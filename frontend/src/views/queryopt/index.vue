<template>
  <section class="page" data-module="queryopt">
    <header class="page-head">
      <div>
        <h2>查询优化管理</h2>
        <p class="page-desc">记录和管理数据查询的优化建议，追踪优化前后的性能对比。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记优化建议</button>
        <button class="btn" type="button" @click="exportRows">导出查询优化清单</button>
        <button class="btn" type="button" :disabled="!dataset" @click="syncSuggestions">同步高耗时标记</button>
        <button class="btn" type="button" :disabled="!dataset" @click="exportCandidates">导出待优化清单</button>
      </div>
    </header>

    <article class="source-banner">
      <div class="source-main">
        <span class="source-tag">同源数据集</span>
        <template v-if="dataset">
          <strong>{{ dataset.version }}</strong>
          <span class="source-muted">
            覆盖 {{ dataset.coverage.windowStart || '—' }} ~ {{ dataset.coverage.windowEnd || '—' }} ·
            {{ dataset.coverage.recordCount }} 条执行记录 · {{ dataset.coverage.scriptCount }} 个脚本
          </span>
          <span v-if="dataset.scope === 'records'" class="source-tag warn">按记录编号核对版本</span>
        </template>
        <template v-else>
          <strong>尚未生成查询性能聚合样本</strong>
          <span class="source-muted">去「查询性能聚合」生成一份全量样本后，这里才能同源同步高耗时标记</span>
        </template>
        <RouterLink class="link" to="/queryperf">查看聚合样本</RouterLink>
      </div>
      <div v-if="dataset" class="source-grid">
        <div><span>高耗时脚本</span><strong>{{ highRows.length }}</strong></div>
        <div><span>有失败的脚本</span><strong>{{ failedRows.length }}</strong></div>
        <div><span>待优化候选</span><strong>{{ candidateRows.length }}</strong></div>
        <div><span>已登记关联建议</span><strong>{{ linkedCount }}</strong></div>
      </div>
      <p v-if="notice" :class="noticeOk ? 'ok-text' : 'error-text'">{{ notice }}</p>
    </article>

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
          <th>关联聚合版本</th>
          <th>高耗时标记</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['关联聚合版本'] || '—' }}</td>
          <td>
            <span v-if="row['高耗时标记'] === '是'" class="badge danger">高耗时</span>
            <span v-else>{{ row['高耗时标记'] || '—' }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无查询优化数据，可先登记优化建议</td>
        </tr>
      </tbody>
    </table>

    <section class="candidate-section">
      <header class="section-head">
        <h3>聚合样本中的待优化脚本</h3>
        <span class="hint">
          与查询性能聚合样本同源；平均耗时、返回行数合计与失败次数均来自同一聚合版本，失败次数不会被返回行数替代。
        </span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>脚本记录编号</th>
            <th>脚本名称</th>
            <th>数据源</th>
            <th>样本查询数</th>
            <th>平均耗时毫秒</th>
            <th>返回行数合计</th>
            <th>失败次数</th>
            <th>主要错误摘要</th>
            <th>高耗时标记</th>
            <th>已登记建议</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="candidate in candidateRows" :key="candidate.scriptNo">
            <td>{{ candidate.scriptNo }}</td>
            <td>{{ candidate.scriptName }}</td>
            <td>{{ candidate.sources.join('、') }}</td>
            <td>{{ candidate.sampleCount }}</td>
            <td>{{ candidate.avgDurationMs }}</td>
            <td>{{ candidate.returnedRowsTotal }}</td>
            <td>{{ candidate.failureCount }}</td>
            <td class="cell-error">{{ candidate.errorSummaries[0]?.summary || '—' }}</td>
            <td>
              <span v-if="candidate.highDuration" class="badge danger">
                高耗时 · 自 {{ candidate.highSinceVersion }}
              </span>
              <span v-else class="badge">正常</span>
            </td>
            <td>{{ suggestionOf(candidate.scriptNo) ? '已关联' : '未登记' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="createFromCandidate(candidate.scriptNo)">
                生成建议
              </button>
            </td>
          </tr>
          <tr v-if="!candidateRows.length">
            <td colspan="11" class="empty-state">
              {{ dataset ? '当前聚合样本中没有高耗时或有失败的脚本' : '先到查询性能聚合生成样本' }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条查询优化记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadFile,
  exportOptimizationCandidates,
  loadPerfPage,
  type PerfPageData,
} from '@/api/perf-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('queryopt')
const columns = ["建议编号", "原始查询", "优化后查询", "优化类型", "预估提升", "涉及索引", "涉及分区", "建议状态"]
const actions = ["生成建议", "采纳建议", "忽略建议"]
const statuses = ["草稿", "优化建议中", "已采纳", "已忽略"]
const allRows = ref<EntryRow[]>([])
const stats = computed(() => [
  { label: '优化建议总数', value: allRows.value.length },
  { label: '已采纳建议', value: allRows.value.filter((row) => String(row.status) === '已采纳').length },
  { label: '建议中数量', value: allRows.value.filter((row) => String(row.status) === '优化建议中').length },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const noticeOk = ref(true)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const perf = ref<PerfPageData | null>(null)

const dataset = computed(() => perf.value?.dataset ?? null)
const highRows = computed(() => (perf.value?.dataset?.rows ?? []).filter((row) => row.highDuration))
const failedRows = computed(() => (perf.value?.dataset?.rows ?? []).filter((row) => row.failureCount > 0))
const candidateRows = computed(() =>
  (perf.value?.dataset?.rows ?? []).filter(
    (row) => row.highDuration || row.failureCount > 0 || row.trend === '变慢',
  ),
)

const linkedSuggestions = computed(() => {
  const map = new Map<string, EntryRow>()
  for (const row of allRows.value) {
    const scriptNo = String(row['关联脚本记录编号'] ?? '')
    if (scriptNo) {
      map.set(scriptNo, row)
    }
  }
  return map
})
const linkedCount = computed(() => linkedSuggestions.value.size)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function suggestionOf(scriptNo: string): EntryRow | undefined {
  return linkedSuggestions.value.get(scriptNo)
}


function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '优化建议登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    allRows.value = listEntries(meta.key).items
    perf.value = loadPerfPage()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '查询优化列表读取失败'
  }
}

function nextSuggestionNo(): string {
  const existing = listRows('queryopt').map((row) => String(row['建议编号'] ?? ''))
  let index = existing.length + 1
  let candidate = `QOPT-${String(index).padStart(4, '0')}`
  const taken = new Set(existing)
  while (taken.has(candidate)) {
    index += 1
    candidate = `QOPT-${String(index).padStart(4, '0')}`
  }
  return candidate
}

/** 从聚合样本的脚本行生成建议：带上聚合版本与来源执行记录编号，避免脱离来源单独维护指标。 */
function createFromCandidate(scriptNo: string) {
  notice.value = ''
  const active = perf.value?.dataset
  if (!active) {
    noticeOk.value = false
    notice.value = '没有已发布的聚合样本，无法同源生成建议'
    return
  }
  const candidate = active.rows.find((row) => row.scriptNo === scriptNo)
  if (!candidate) {
    noticeOk.value = false
    notice.value = `聚合版本 ${active.version} 中没有脚本 ${scriptNo}`
    return
  }
  if (suggestionOf(scriptNo)) {
    noticeOk.value = false
    notice.value = `${scriptNo} 已有登记的建议 ${suggestionOf(scriptNo)?.建议编号}，不重复生成`
    return
  }
  const suggestions = listRows('queryopt')
  const record: EntryRow = {
    id: suggestions.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1,
    status: '优化建议中',
    pending: true,
    abnormal: false,
    建议编号: nextSuggestionNo(),
    原始查询: `${candidate.scriptName}（${candidate.scriptNo}）`,
    优化后查询: '待优化人员补充',
    优化类型: candidate.failureCount > 0 ? '错误修复 + 耗时优化' : '耗时优化',
    预估提升: `平均 ${candidate.avgDurationMs}ms / 单次最长 ${candidate.maxDurationMs}ms`,
    涉及索引: '待评估',
    涉及分区: candidate.windowStart ? `按 ${candidate.windowStart} 起的日期分区` : '待评估',
    建议状态: '优化建议中',
    关联聚合版本: active.version,
    关联脚本记录编号: candidate.scriptNo,
    来源执行记录编号: candidate.sourceRecordNos.join('|'),
    高耗时标记: candidate.highDuration ? '是' : '否',
  }
  saveRows('queryopt', [...suggestions, record])
  noticeOk.value = true
  notice.value = `已按 ${active.version} 生成建议 ${record.建议编号}（来源 ${candidate.sourceRecordNos.length} 条执行记录）`
  reload()
}

/** 高耗时标记同步：只更新来源记录编号与本聚合版本一致的建议，不动其他建议。 */
function syncSuggestions() {
  const active = perf.value?.dataset
  if (!active) {
    noticeOk.value = false
    notice.value = '没有已发布的聚合样本，无法同步高耗时标记'
    return
  }
  const byScript = new Map(active.rows.map((row) => [row.scriptNo, row]))
  const suggestions = listRows('queryopt')
  let updated = 0
  const next = suggestions.map((row) => {
    const scriptNo = String(row['关联脚本记录编号'] ?? '')
    const aggregate = scriptNo ? byScript.get(scriptNo) : undefined
    if (!aggregate) {
      return row
    }
    const flag = aggregate.highDuration ? '是' : '否'
    if (String(row['高耗时标记'] ?? '') === flag && String(row['关联聚合版本'] ?? '') === active.version) {
      return row
    }
    updated += 1
    return {
      ...row,
      '关联聚合版本': active.version,
      '来源执行记录编号': aggregate.sourceRecordNos.join('|'),
      '高耗时标记': flag,
    }
  })
  saveRows('queryopt', next)
  noticeOk.value = true
  notice.value = `已按 ${active.version} 同步 ${updated} 条建议的高耗时标记（其余建议保持原样）`
  reload()
}

function exportCandidates() {
  if (!dataset.value) {
    noticeOk.value = false
    notice.value = '没有已发布的聚合样本，无法导出待优化清单'
    return
  }
  downloadFile(
    exportOptimizationCandidates({
      dataset: dataset.value,
      rows: dataset.value.rows,
    }),
  )
}

onMounted(reload)
</script>

<style scoped>
.source-banner {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.source-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.source-tag {
  background: #e8f0fe;
  color: var(--brand);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.source-tag.warn {
  background: #fff4e5;
  color: #b54708;
}
.source-muted {
  color: var(--muted);
  font-size: 12px;
}
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 14px;
  margin-top: 10px;
}
.source-grid div {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
}
.source-grid strong {
  font-size: 14px;
  color: #1f2937;
}
.ok-text {
  color: #067647;
  font-size: 13px;
  margin: 8px 0 0;
}
.hint {
  color: var(--muted);
  font-size: 12px;
}
.candidate-section {
  margin-top: 18px;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.section-head h3 {
  margin: 0 0 6px;
  font-size: 15px;
}
.badge {
  display: inline-block;
  background: #eef2f7;
  color: #344054;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
}
.badge.danger {
  background: #fee4e2;
  color: #b42318;
}
.cell-error {
  max-width: 240px;
  color: var(--muted);
}
</style>
