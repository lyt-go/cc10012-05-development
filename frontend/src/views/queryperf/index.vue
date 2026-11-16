<template>
  <section class="page perf-page" data-module="queryperf">
    <header class="page-head">
      <div>
        <h2>查询性能聚合样本</h2>
        <p class="page-desc">
          从查询历史的原始执行行出发，统一耗时单位为毫秒，按脚本记录编号聚合平均耗时、返回行数与失败次数。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleBuilder">
          {{ builderOpen ? '收起聚合配置' : '生成聚合样本' }}
        </button>
        <button class="btn" type="button" :disabled="!dataset" @click="exportDataset">
          导出聚合样本
        </button>
        <RouterLink class="btn" to="/queryopt">前往查询优化</RouterLink>
      </div>
    </header>

    <form v-if="builderOpen" class="build-panel" @submit.prevent="generate">
      <div class="build-grid">
        <label class="filter-item">
          <span>聚合方式</span>
          <select v-model="form.mode">
            <option value="full">全量重算（新版本，不覆盖旧版本）</option>
            <option value="incremental">增量计算（只更新受影响脚本）</option>
          </select>
        </label>
        <label class="filter-item">
          <span>窗口开始日期</span>
          <input v-model="form.start" type="date" />
        </label>
        <label class="filter-item">
          <span>窗口结束日期</span>
          <input v-model="form.end" type="date" />
        </label>
        <label class="filter-item">
          <span>按记录编号核对（逗号分隔，走核对版本）</span>
          <input v-model="form.recordNos" placeholder="HIST-2001,HIST-2002,HIST-9001" />
        </label>
      </div>
      <div class="build-foot">
        <label class="inline-check">
          <input v-model="form.simulateInterrupt" type="checkbox" />
          <span>演练中断（验证已发布版本不被破坏）</span>
        </label>
        <div class="build-buttons">
          <button class="btn ghost" type="button" @click="fillLatestWindow">填最新采集日</button>
          <button class="btn ghost" type="button" @click="clearWindow">清空窗口</button>
          <button class="btn" type="button" @click="verifyByRecordNos">按记录编号核对</button>
          <button class="btn primary" type="submit" :disabled="busy">{{ busy ? '聚合中…' : '生成聚合样本' }}</button>
        </div>
      </div>
      <p class="hint">
        增量计算按窗口识别受影响脚本，受影响脚本按完整历史重算，其余脚本整行沿用当前生效基线；
        已发布的高耗时标记不会因下一次增量计算消失。按记录编号核对只归档核对版本，不替换当前基线。
      </p>
      <p v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>
    </form>

    <article v-if="dataset" class="coverage-banner">
      <div class="coverage-main">
        <span class="coverage-tag">{{ dataset.mode === 'incremental' ? '增量版本' : '全量版本' }}</span>
        <strong>{{ dataset.version }}</strong>
        <span class="coverage-muted">发布于 {{ dataset.publishedAt }}</span>
        <span v-if="dataset.scope === 'records'" class="coverage-tag warn">按记录编号核对</span>
        <span v-if="previewVersion" class="coverage-tag warn">历史版本只读预览 · 当前生效 {{ page?.dataset?.version }}</span>
      </div>
      <div class="coverage-grid">
        <div><span>覆盖窗口</span><strong>{{ dataset.coverage.windowStart || '—' }} ~ {{ dataset.coverage.windowEnd || '—' }}</strong></div>
        <div><span>执行批次</span><strong>{{ dataset.coverage.batchIds.length }} 个</strong></div>
        <div><span>来源执行记录</span><strong>{{ dataset.coverage.recordCount }} 条</strong></div>
        <div><span>查询历史可聚合行</span><strong>{{ source.aggregatableRows }} / {{ source.totalHistoryRows }}</strong></div>
        <div><span>纳入脚本</span><strong>{{ dataset.coverage.scriptCount }} 个</strong></div>
        <div><span>沿用的上一版本</span><strong>{{ dataset.inheritedFrom || '—' }}</strong></div>
      </div>
      <p class="coverage-note">{{ dataset.notes }}</p>
      <p v-if="previewVersion" class="coverage-note">
        正在只读预览 {{ dataset.version }}，它只覆盖 {{ dataset.coverage.windowStart || '—' }} ~
        {{ dataset.coverage.windowEnd || '—' }}；预览不会替换当前生效版本。
        <button class="link" type="button" @click="closePreview">回到当前生效版本</button>
      </p>
      <p class="coverage-note">
        覆盖范围只统计已采集进查询历史的执行记录；尚未采集的执行不计入本版本，需要等下一版本重算。
        <span v-if="dataset.coverage.batchIds.length" class="batch-list">批次：{{ dataset.coverage.batchIds.join('、') }}</span>
      </p>
    </article>
    <article v-else class="coverage-banner empty">
      <strong>还没有已发布的聚合样本</strong>
      <span>先点「生成聚合样本」做一次全量聚合；聚合中断时会自动保留上一份有效版本。</span>
    </article>

    <p v-if="message && !builderOpen" :class="messageOk ? 'ok-text banner-text' : 'error-text banner-text'">
      {{ message }}
    </p>

    <div class="stat-row perf-stats">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
        <span class="stat-sub">{{ item.sub }}</span>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="refresh">
      <label class="filter-item">
        <span>脚本名称 / 编号</span>
        <input v-model="filters.keyword" placeholder="如 订单明细聚合 或 QRY-1002" />
      </label>
      <label class="filter-item">
        <span>数据源</span>
        <input v-model="filters.source" list="perf-source-options" placeholder="如 DS-WAREHOUSE-DWD" />
        <datalist id="perf-source-options">
          <option v-for="item in sourceOptions" :key="item" :value="item"></option>
        </datalist>
      </label>
      <label class="filter-item">
        <span>开始日期</span>
        <input v-model="filters.start" type="date" />
      </label>
      <label class="filter-item">
        <span>结束日期</span>
        <input v-model="filters.end" type="date" />
      </label>
      <label class="inline-check">
        <input v-model="filters.highOnly" type="checkbox" />
        <span>只看高耗时</span>
      </label>
      <label class="inline-check">
        <input v-model="filters.failedOnly" type="checkbox" />
        <span>只看有失败</span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p class="hint" v-if="dataset && previewVersion">
      注意：当前是 {{ dataset.version }} 的只读预览，不是最新生效版本。
    </p>
    <p class="hint" v-if="dataset">
      当前筛选命中 {{ stats.scriptCount }} 个脚本 / {{ stats.sampleCount }} 条执行样本；
      脚本指标按各自完整覆盖窗口计算，不会因筛选窗口被截断。
    </p>

    <table class="data-table perf-table">
      <thead>
        <tr>
          <th>脚本记录编号</th>
          <th>脚本名称</th>
          <th>数据源</th>
          <th>样本查询数</th>
          <th>平均耗时毫秒</th>
          <th>成功平均毫秒</th>
          <th>单次最长毫秒</th>
          <th>返回行数合计</th>
          <th>失败次数</th>
          <th>超时次数</th>
          <th>高耗时标记</th>
          <th>趋势</th>
          <th>覆盖窗口</th>
          <th>来源执行行</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.scriptNo" :class="{ 'row-selected': selected?.scriptNo === row.scriptNo }">
          <td>{{ row.scriptNo }}</td>
          <td>
            <button class="link strong" type="button" @click="selectScript(row)">{{ row.scriptName }}</button>
          </td>
          <td>{{ row.sources.join('、') }}</td>
          <td>{{ row.sampleCount }}</td>
          <td>{{ row.avgDurationMs }}</td>
          <td>{{ row.successCount ? row.successAvgDurationMs : '—' }}</td>
          <td>{{ row.maxDurationMs }}</td>
          <td>{{ row.returnedRowsTotal }}</td>
          <td>
            <button
              class="link"
              :class="{ 'link-danger': row.failureCount > 0 }"
              type="button"
              @click="selectFailures(row)"
            >
              {{ row.failureCount }}
            </button>
          </td>
          <td>{{ row.timeoutCount }}</td>
          <td>
            <span v-if="row.highDuration" class="badge danger" :title="row.highDurationReason">
              高耗时 · 自 {{ row.highSinceVersion }}
            </span>
            <span v-else class="badge">正常</span>
          </td>
          <td>{{ row.trend }}</td>
          <td class="cell-window">{{ row.windowStart }} ~ {{ row.windowEnd }}</td>
          <td>
            <button class="link" type="button" @click="selectScript(row)">
              {{ row.sourceRecordNos.length }} 条
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="14" class="empty-state">
            {{ dataset ? '当前条件下没有脚本命中，可放宽脚本名称、数据源或日期窗口' : '生成聚合样本后可在此按脚本查看指标' }}
          </td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel" data-panel="script-detail">
      <header class="detail-head">
        <div>
          <h3>{{ selected.scriptName }} <span class="muted">（{{ selected.scriptNo }}）</span></h3>
          <p class="hint">
            来源链路：查询历史原始执行行 {{ selected.sourceRecordNos.length }} 条 → 错误归类 / 耗时归一 →
            本聚合行（版本 {{ selected.updatedInVersion }}）
          </p>
        </div>
        <div class="detail-actions">
          <button class="btn" type="button" @click="exportSelectedExecutions">导出执行行明细</button>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </div>
      </header>

      <div class="detail-metrics">
        <div><span>样本查询数</span><strong>{{ selected.sampleCount }}</strong></div>
        <div><span>平均耗时毫秒</span><strong>{{ selected.avgDurationMs }}</strong></div>
        <div><span>返回行数合计</span><strong>{{ selected.returnedRowsTotal }}</strong></div>
        <div><span>失败次数</span><strong>{{ selected.failureCount }}</strong></div>
        <div><span>超时次数</span><strong>{{ selected.timeoutCount }}</strong></div>
        <div><span>覆盖窗口</span><strong>{{ selected.windowStart }} ~ {{ selected.windowEnd }}</strong></div>
      </div>

      <div class="error-block">
        <div class="error-head">
          <strong>错误分布</strong>
          <span class="hint">同一执行下的多条错误摘要只计 1 次失败，主摘要按可解释优先级保留</span>
        </div>
        <div v-if="selected.errorDistribution.length" class="chip-row">
          <button
            v-for="item in selected.errorDistribution"
            :key="item.kind"
            class="chip"
            :class="{ 'chip-active': errorKindFilter === item.kind }"
            type="button"
            @click="toggleErrorKind(item.kind)"
          >
            {{ item.kind }}：{{ item.count }}
          </button>
          <button v-if="errorKindFilter" class="link" type="button" @click="errorKindFilter = ''">清除错误筛选</button>
        </div>
        <p v-else class="hint">该脚本在当前样本窗口内没有失败执行，失败次数为 0。</p>
        <ul v-if="selected.errorSummaries.length" class="summary-list">
          <li v-for="item in selected.errorSummaries" :key="item.kind + item.summary">
            <span class="badge">{{ item.kind }}</span>
            <span class="summary-text">{{ item.summary }}</span>
            <span class="hint">{{ item.count }} 次 · {{ item.recordNos.join('、') }}</span>
          </li>
        </ul>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>执行时间</th>
            <th>执行批次</th>
            <th>数据源</th>
            <th>返回行数</th>
            <th>执行耗时毫秒</th>
            <th>原始耗时值</th>
            <th>执行人</th>
            <th>状态</th>
            <th>错误摘要（主）</th>
            <th>同次其他错误</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="execution in visibleExecutions" :key="execution.recordNo" :class="{ 'row-failed': execution.error }">
            <td>{{ execution.recordNo }}</td>
            <td>{{ execution.executedAt }}</td>
            <td>{{ execution.batch }}</td>
            <td>{{ execution.source }}</td>
            <td>{{ execution.returnedRows }}</td>
            <td>{{ execution.durationMs }}</td>
            <td>{{ execution.durationRaw }}</td>
            <td>{{ execution.operator }}</td>
            <td>{{ execution.status }}</td>
            <td>
              <template v-if="execution.error">
                <span class="badge danger">{{ execution.error.kind }}</span>
                {{ execution.error.summary }}
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="cell-extra">
              {{ execution.error && execution.error.parts.length > 1 ? execution.error.parts.slice(1).join('；') : '—' }}
            </td>
          </tr>
          <tr v-if="!visibleExecutions.length">
            <td colspan="11" class="empty-state">当前错误筛选下没有执行行</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="version-section">
      <header class="section-head">
        <h3>聚合样本版本与覆盖范围</h3>
        <span class="hint">已发布版本只追加不覆盖，旧版本仍能说明当时的覆盖范围</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>发布时间</th>
            <th>计算方式</th>
            <th>覆盖窗口</th>
            <th>来源执行记录</th>
            <th>脚本数</th>
            <th>沿用版本</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="version in versions"
            :key="version.version"
            :class="{ 'row-selected': version.version === dataset?.version, 'row-preview': version.version === previewVersion }"
          >
            <td>
              {{ version.version }}
              <span v-if="version.version === activeVersion" class="badge">当前生效</span>
              <span v-if="previewVersion && version.version === previewVersion" class="badge warn">预览中</span>
            </td>
            <td>{{ version.publishedAt }}</td>
            <td>{{ version.mode === 'incremental' ? '增量' : '全量' }}{{ version.scope === 'records' ? ' / 记录核对' : '' }}</td>
            <td class="cell-window">{{ version.coverage.windowStart || '—' }} ~ {{ version.coverage.windowEnd || '—' }}</td>
            <td>{{ version.coverage.recordCount }}</td>
            <td>{{ version.coverage.scriptCount }}</td>
            <td>{{ version.inheritedFrom || '—' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openVersion(version.version)">
                {{ previewVersion && version.version === previewVersion ? '预览中' : '查看' }}
              </button>
              <button class="link" type="button" @click="exportVersion(version)">导出</button>
            </td>
          </tr>
          <tr v-if="!versions.length">
            <td colspan="8" class="empty-state">暂无已发布版本</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="version-section">
      <header class="section-head">
        <h3>聚合运行记录</h3>
        <span class="hint">中断只记录运行，不产出版本；已发布指标保持原样</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>运行时间</th>
            <th>计算方式</th>
            <th>结果</th>
            <th>说明</th>
            <th>保留版本</th>
            <th>受影响脚本</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.runId + run.at">
            <td>{{ run.at }}</td>
            <td>{{ run.mode === 'incremental' ? '增量' : '全量' }}</td>
            <td>
              <span class="badge" :class="{ danger: run.status === 'interrupted' }">
                {{ run.status === 'interrupted' ? '中断' : '成功' }}
              </span>
            </td>
            <td>{{ run.message }}</td>
            <td>{{ run.preservedVersion || run.version || '—' }}</td>
            <td>{{ run.affectedScriptNos.join('、') || '—' }}</td>
          </tr>
          <tr v-if="!runs.length">
            <td colspan="6" class="empty-state">还没有聚合运行记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>
        查询历史共 {{ source.totalHistoryRows }} 条原始执行行，其中 {{ source.aggregatableRows }} 条进入聚合；
        草稿/已删除记录不计入（{{ source.skippedRows }} 条）。
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  buildDataset,
  buildDatasetByRecordNos,
  downloadFile,
  executionDetails,
  exportExecutionRows,
  exportPerfDataset,
  loadPerfPage,
  loadPerfVersion,
  type PerfPageData,
} from '@/api/perf-service'
import type { ErrorKind, PerfDataset, PerfRowFilters, PerfScriptRow } from '@/data/perf-core'

const builderOpen = ref(false)
const busy = ref(false)
const message = ref('')
const messageOk = ref(true)
const errorMessage = ref('')
const page = ref<PerfPageData | null>(null)

const form = reactive({
  mode: 'full' as 'full' | 'incremental',
  start: '',
  end: '',
  recordNos: '',
  simulateInterrupt: false,
})

const filters = reactive<Required<Pick<PerfRowFilters, 'keyword' | 'source' | 'start' | 'end'>> & {
  highOnly: boolean
  failedOnly: boolean
}>({
  keyword: '',
  source: '',
  start: '',
  end: '',
  highOnly: false,
  failedOnly: false,
})

const selected = ref<PerfScriptRow | null>(null)
const errorKindFilter = ref<ErrorKind | ''>('')
/** 历史版本只读预览；预览时不会改变当前生效版本，避免已发布指标被旧版本顶掉 */
const previewVersion = ref('')
const previewPage = ref<PerfPageData | null>(null)

const shown = computed<PerfPageData | null>(() =>
  previewVersion.value ? previewPage.value : page.value,
)
const dataset = computed<PerfDataset | null>(() => shown.value?.dataset ?? null)
const activeVersion = computed(() => page.value?.dataset?.version ?? '')
const versions = computed(() => page.value?.versions ?? [])
const runs = computed(() => page.value?.runs ?? [])
const rows = computed(() => shown.value?.rows ?? [])
const stats = computed(
  () =>
    shown.value?.stats ?? {
      scriptCount: 0,
      sampleCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      highCount: 0,
      avgDurationMs: 0,
      returnedRowsTotal: 0,
    },
)
const source = computed(
  () =>
    shown.value?.source ?? {
      totalHistoryRows: 0,
      aggregatableRows: 0,
      skippedRows: 0,
      skippedRecordNos: [],
      executions: [],
    },
)

const sourceOptions = computed(() => {
  const values = new Set<string>()
  for (const execution of source.value.executions) {
    values.add(execution.source)
  }
  return [...values].sort()
})

const statCards = computed(() => [
  { label: '纳入脚本数', value: stats.value.scriptCount, sub: '当前筛选范围' },
  { label: '样本查询数', value: stats.value.sampleCount, sub: '纳入的执行行数' },
  { label: '失败次数', value: stats.value.failureCount, sub: '每次执行最多计 1 次' },
  { label: '超时次数', value: stats.value.timeoutCount, sub: '失败中的超时子集' },
  { label: '高耗时脚本', value: stats.value.highCount, sub: '含历史已发布标记' },
  { label: '平均耗时毫秒', value: stats.value.avgDurationMs, sub: '按样本数加权' },
  { label: '返回行数合计', value: stats.value.returnedRowsTotal, sub: '按脚本累计' },
])

const detailExecutions = computed(() => {
  if (!selected.value) {
    return []
  }
  return executionDetails(selected.value.sourceRecordNos)
})

const visibleExecutions = computed(() => {
  if (!errorKindFilter.value) {
    return detailExecutions.value
  }
  return detailExecutions.value.filter((item) => item.error?.kind === errorKindFilter.value)
})

function currentFilters(): PerfRowFilters {
  return {
    keyword: filters.keyword,
    source: filters.source,
    start: filters.start,
    end: filters.end,
    highOnly: filters.highOnly,
    failedOnly: filters.failedOnly,
  }
}

function refresh() {
  errorMessage.value = ''
  try {
    page.value = loadPerfPage(currentFilters())
    if (previewVersion.value) {
      const preview = loadPerfVersion(previewVersion.value, currentFilters())
      previewPage.value = preview
      if (!preview) {
        previewVersion.value = ''
      }
    }
    if (selected.value) {
      const next = rows.value.find((row) => row.scriptNo === selected.value?.scriptNo)
      selected.value = next ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '聚合样本读取失败'
  }
}

function reloadAll() {
  refresh()
}

function toggleBuilder() {
  builderOpen.value = !builderOpen.value
  message.value = ''
}

function fillLatestWindow() {
  const dates = source.value.executions.map((item) => item.date).filter(Boolean).sort()
  const latest = dates[dates.length - 1] ?? ''
  form.start = latest
  form.end = latest
}

function clearWindow() {
  form.start = ''
  form.end = ''
}

function report(error: unknown) {
  message.value = error instanceof Error ? error.message : '聚合生成失败'
  messageOk.value = false
}

function generate() {
  busy.value = true
  message.value = ''
  try {
    const produced = buildDataset({
      mode: form.mode,
      start: form.start,
      end: form.end,
      simulateInterrupt: form.simulateInterrupt,
    })
    messageOk.value = true
    message.value = `已发布 ${produced.version}：覆盖 ${produced.coverage.recordCount} 条执行记录 / ${produced.coverage.scriptCount} 个脚本`
    selected.value = null
    reloadAll()
  } catch (error) {
    report(error)
    reloadAll()
  } finally {
    busy.value = false
  }
}

function verifyByRecordNos() {
  const recordNos = form.recordNos
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (recordNos.length === 0) {
    messageOk.value = false
    message.value = '请先填写要核对的记录编号，例如 HIST-2001,HIST-2002'
    return
  }
  busy.value = true
  message.value = ''
  try {
    const result = buildDatasetByRecordNos(recordNos, {
      simulateInterrupt: form.simulateInterrupt,
    })
    messageOk.value = true
    const missing = result.missingRecords.length
      ? `，未找到 ${result.missingRecords.join('、')}`
      : ''
    message.value = `已归档核对版本 ${result.dataset.version}：覆盖 ${result.coveredRecords.length} 条记录${missing}；当前基线未被替换`
    reloadAll()
  } catch (error) {
    report(error)
  } finally {
    busy.value = false
  }
}

function selectScript(row: PerfScriptRow) {
  selected.value = row
  errorKindFilter.value = ''
}

function selectFailures(row: PerfScriptRow) {
  selected.value = row
  errorKindFilter.value = row.errorDistribution[0]?.kind ?? ''
}

function toggleErrorKind(kind: ErrorKind) {
  errorKindFilter.value = errorKindFilter.value === kind ? '' : kind
}

function closeDetail() {
  selected.value = null
  errorKindFilter.value = ''
}

function resetFilters() {
  filters.keyword = ''
  filters.source = ''
  filters.start = ''
  filters.end = ''
  filters.highOnly = false
  filters.failedOnly = false
  refresh()
}

function exportDataset() {
  if (!dataset.value) {
    return
  }
  downloadFile(
    exportPerfDataset({
      dataset: dataset.value,
      rows: dataset.value.rows,
    }),
  )
}

function exportVersion(version: PerfDataset) {
  downloadFile(
    exportPerfDataset({
      dataset: version,
      rows: version.rows,
    }),
  )
}

function exportSelectedExecutions() {
  if (!dataset.value || !selected.value) {
    return
  }
  downloadFile(exportExecutionRows(detailExecutions.value, dataset.value.version))
}

function openVersion(version: string) {
  const current = activeVersion.value
  errorMessage.value = ''
  if (!current || version === current) {
    closePreview()
    return
  }
  const preview = loadPerfVersion(version, currentFilters())
  if (!preview) {
    errorMessage.value = `没有版本号为 ${version} 的聚合样本`
    return
  }
  previewVersion.value = version
  previewPage.value = preview
  selected.value = null
  errorKindFilter.value = ''
}

function closePreview() {
  previewVersion.value = ''
  previewPage.value = null
}

const route = useRoute()

onMounted(() => {
  // 从查询历史「看聚合」跳进来时带上脚本记录编号，直接定位到该脚本
  const script = typeof route.query.script === 'string' ? route.query.script : ''
  if (script) {
    filters.keyword = script
  }
  refresh()
})
</script>

<style scoped>
.banner-text {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin: 0 0 12px;
}
.build-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.build-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 14px;
}
.build-grid select,
.build-grid input,
.filter-bar input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  background: #fff;
}
.build-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.build-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.hint {
  color: var(--muted);
  font-size: 12px;
  margin: 8px 0 0;
}
.ok-text {
  color: #067647;
  font-size: 13px;
  margin: 8px 0 0;
}
.coverage-banner {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.coverage-banner.empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left-color: #b42318;
  color: var(--muted);
  font-size: 13px;
}
.coverage-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.coverage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 8px 14px;
  margin-top: 10px;
}
.coverage-grid div {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
}
.coverage-grid strong {
  font-size: 13px;
  color: #1f2937;
}
.coverage-tag {
  background: #e8f0fe;
  color: var(--brand);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.coverage-tag.warn {
  background: #fff4e5;
  color: #b54708;
}
.coverage-muted {
  color: var(--muted);
  font-size: 12px;
}
.coverage-note {
  color: var(--muted);
  font-size: 12px;
  margin: 8px 0 0;
}
.batch-list {
  margin-left: 6px;
}
.stat-sub {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.perf-stats .stat-card {
  min-width: 120px;
}
.perf-table .cell-window {
  white-space: nowrap;
}
.link.strong {
  font-weight: 600;
}
.link-danger {
  color: #b42318;
}
.badge {
  display: inline-block;
  background: #eef2f7;
  color: #344054;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
}
.badge.warn {
  background: #fff4e5;
  color: #b54708;
}
.badge.danger {
  background: #fee4e2;
  color: #b42318;
}
.row-selected td {
  background: #eff6ff;
}
.row-preview td {
  background: #fffaeb;
}
.row-failed td {
  background: #fffbfa;
}
.detail-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  margin: 14px 0;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.detail-head h3 {
  margin: 0;
  font-size: 15px;
}
.detail-actions {
  display: flex;
  gap: 8px;
}
.detail-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px 14px;
  margin: 10px 0;
  padding: 10px;
  background: #f8fafc;
  border-radius: 6px;
}
.detail-metrics div {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
}
.detail-metrics strong {
  font-size: 14px;
  color: #1f2937;
}
.error-block {
  margin: 10px 0;
}
.error-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
  align-items: center;
}
.chip {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.chip-active {
  background: #fee4e2;
  border-color: #fda29b;
  color: #b42318;
}
.summary-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.summary-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.summary-text {
  color: #1f2937;
}
.cell-extra {
  color: var(--muted);
  max-width: 260px;
}
.muted {
  color: var(--muted);
  font-weight: 400;
}
.version-section {
  margin-top: 18px;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
}
.section-head h3 {
  margin: 0 0 6px;
  font-size: 15px;
}
</style>
