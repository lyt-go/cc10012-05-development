<template>
  <section class="page" data-module="queryhistory">
    <header class="page-head">
      <div>
        <h2>查询历史管理</h2>
        <p class="page-desc">记录和回溯所有数据查询历史，分析查询模式和性能瓶颈。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记历史记录</button>
        <button class="btn" type="button" @click="exportRows">导出查询历史清单</button>
        <RouterLink class="btn" to="/queryperf">查询性能聚合样本</RouterLink>
      </div>
    </header>

    <p class="trace-hint">
      本页是聚合链路的起点：每条执行行都带有脚本记录编号、统一为毫秒的执行耗时、返回行数和错误信息；
      聚合后的平均耗时、返回行数和失败次数可在「查询性能聚合」按脚本核对。
    </p>

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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
            <RouterLink
              class="link"
              :to="{ path: '/queryperf', query: { script: String(row['脚本记录编号'] ?? '') } }"
            >
              看聚合
            </RouterLink>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无查询历史数据，可先登记历史记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条查询历史记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { formatDate, parseDurationMs } from '@/data/perf-core'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('queryhistory')
const columns = ["记录编号", "脚本记录编号", "脚本名称", "查询语句摘要", "执行时间", "返回行数", "执行耗时毫秒", "数据源", "执行人", "执行批次", "错误信息"]
const actions = ["确认记录", "收藏记录", "删除记录"]
const statuses = ["草稿", "已执行", "已收藏", "已删除"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = computed(() => {
  const list = rows.value
  const today = formatDate(new Date())
  const durations = list.map((row) => parseDurationMs(row['执行耗时毫秒']))
  const sum = durations.reduce((acc, value) => acc + value, 0)
  return [
    { label: '历史记录总数', value: total.value },
    { label: '今日查询量', value: list.filter((row) => String(row['执行时间'] ?? '').startsWith(today)).length },
    { label: '平均耗时毫秒', value: list.length ? Math.round(sum / list.length) : 0 },
  ]
})
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "脚本记录编号", "脚本名称"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '历史记录登记入口尚未接入审批流'
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '查询历史列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.trace-hint {
  color: var(--muted);
  font-size: 12px;
  background: #eef2f7;
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0 0 10px;
}
</style>
