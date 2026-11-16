import { listRows } from '@/data/local-store'
import {
  aggregateExecutions,
  executionFromHistoryRow,
  filterRowsByExecutions,
  formatDate,
  formatDateTime,
  inWindow,
  isAggregatableStatus,
  makeDataset,
  mergeIncrementalRows,
  summarizeRows,
  versionSequence,
  type PerfDataset,
  type PerfRowFilters,
  type PerfRunLog,
  type PerfScriptRow,
  type PerfStats,
  type RawExecution,
} from '@/data/perf-core'
import {
  activeDataset,
  getVersion,
  listRuns,
  listVersions,
  publishVersion,
  recordInterruptedRun,
  resetPerfState,
  type PerfState,
} from '@/data/perf-store'

export type PerfSourceInfo = {
  totalHistoryRows: number
  aggregatableRows: number
  skippedRows: number
  skippedRecordNos: string[]
  executions: RawExecution[]
}

/** 聚合链路的起点：从查询历史原始执行行读出可聚合样本，并保留来源记录编号。 */
export function loadPerfSource(): PerfSourceInfo {
  const history = listRows('queryhistory')
  const executions: RawExecution[] = []
  const skippedRecordNos: string[] = []
  for (const row of history) {
    const execution = executionFromHistoryRow(row)
    if (!isAggregatableStatus(execution.status) || !execution.executedAt) {
      skippedRecordNos.push(execution.recordNo)
      continue
    }
    executions.push(execution)
  }
  return {
    totalHistoryRows: history.length,
    aggregatableRows: executions.length,
    skippedRows: skippedRecordNos.length,
    skippedRecordNos,
    executions,
  }
}

export type BuildOptions = {
  mode: 'full' | 'incremental'
  start?: string
  end?: string
  /** 演练中断：在聚合完成前抛出，验证已发布版本不被破坏 */
  simulateInterrupt?: boolean
  now?: Date
}

export type BuildRecordNosResult = {
  dataset: PerfDataset
  coveredRecords: string[]
  missingRecords: string[]
}

/**
 * 按显式记录编号构建一次聚合（验收用）：
 * 只聚合给定编号的执行行，因此必有一条记录缺样本时结果可核对。
 */
export function buildDatasetByRecordNos(
  recordNos: string[],
  options: { simulateInterrupt?: boolean; now?: Date } = {},
): BuildRecordNosResult {
  const now = options.now ?? new Date()
  const source = loadPerfSource()
  const wanted = [...new Set(recordNos.map((item) => item.trim()).filter((item) => item.length > 0))]
  const byRecordNo = new Map(source.executions.map((item) => [item.recordNo, item]))
  const covered = wanted
    .map((recordNo) => byRecordNo.get(recordNo))
    .filter((item): item is RawExecution => Boolean(item))
  const coveredRecords = covered.map((item) => item.recordNo)
  const missingRecords = wanted.filter((recordNo) => !byRecordNo.has(recordNo))
  const version = nextVersion(now)
  if (options.simulateInterrupt) {
    const run: PerfRunLog = {
      runId: `RUN-${version}`,
      at: formatDateTime(now),
      mode: 'full',
      status: 'interrupted',
      version: null,
      preservedVersion: activeDataset()?.version ?? null,
      message: `演练中断：已读取 ${covered.length} 条执行行，未生成 ${version}`,
      missingRecordNos: missingRecords,
      affectedScriptNos: [...new Set(covered.map((item) => item.scriptNo))],
    }
    recordInterruptedRun(run)
    throw new Error(
      `聚合中断：已保留上一份有效聚合样本 ${run.preservedVersion ?? '（暂无）'}，未发布 ${version}`,
    )
  }
  if (covered.length === 0) {
    throw new Error('所选记录编号没有可聚合的执行行，未生成新版本')
  }
  const rows = aggregateExecutions(covered, { version })
  const dataset = makeDataset({
    version,
    publishedAt: formatDateTime(now),
    mode: 'full',
    scope: 'records',
    inheritedFrom: activeDataset()?.version ?? null,
    notes: `核对版本：按 ${coveredRecords.length} 条指定执行记录聚合${missingRecords.length ? `，另有 ${missingRecords.length} 条记录未找到` : ''}`,
    rows,
  })
  const run: PerfRunLog = {
    runId: `RUN-${version}`,
    at: dataset.publishedAt,
    mode: 'full',
    status: 'success',
    version,
    preservedVersion: null,
    message: `已归档核对版本 ${version}：${rows.length} 个脚本 / ${covered.length} 条执行样本（不替换当前基线）`,
    missingRecordNos: missingRecords,
    affectedScriptNos: rows.map((row) => row.scriptNo),
  }
  publishVersion(dataset, run, { activate: false })
  return { dataset, coveredRecords, missingRecords }
}

function nextVersion(now: Date): string {
  const day = formatDate(now)
  return `PERF-${day.replace(/-/g, '')}-${String(versionSequence(listVersions(), day)).padStart(2, '0')}`
}

function validateWindow(start: string, end: string): void {
  if (start && end && start > end) {
    throw new Error('开始日期不能晚于结束日期')
  }
}

/**
 * 生成聚合样本版本。
 *
 * - full：按当前查询历史在时间窗口内整体重算；旧版本不会被覆盖，只追加新版本。
 * - incremental：只重算窗口内出现的脚本；其他脚本整行沿用上一份有效版本的基线，
 *   已发布的高耗时标记由聚合层继续携带。
 */
export function buildDataset(options: BuildOptions): PerfDataset {
  const now = options.now ?? new Date()
  const start = (options.start ?? '').trim()
  const end = (options.end ?? '').trim()
  validateWindow(start, end)
  const source = loadPerfSource()
  const inScope = source.executions.filter((item) => inWindow(item, start, end))
  const version = nextVersion(now)
  const base = activeDataset()

  if (inScope.length === 0) {
    throw new Error('当前时间窗口内没有可聚合的执行记录，未生成新版本')
  }

  const affectedScriptNos = [...new Set(inScope.map((item) => item.scriptNo))].sort()

  if (options.simulateInterrupt) {
    const run: PerfRunLog = {
      runId: `RUN-${version}`,
      at: formatDateTime(now),
      mode: options.mode,
      status: 'interrupted',
      version: null,
      preservedVersion: base?.version ?? null,
      message: `演练中断：已读取 ${inScope.length} 条执行行、${affectedScriptNos.length} 个受影响脚本，未生成 ${version}`,
      missingRecordNos: [],
      affectedScriptNos,
    }
    recordInterruptedRun(run)
    throw new Error(
      `聚合中断：已保留上一份有效聚合样本 ${run.preservedVersion ?? '（暂无）'}，未发布 ${version}`,
    )
  }

  if (options.mode === 'incremental' && !base) {
    throw new Error('还没有已发布的聚合样本，增量计算需要先完成一次全量聚合')
  }

  const rows =
    options.mode === 'incremental' && base
      ? (() => {
          // 窗口只用来识别受影响脚本；受影响脚本按完整历史重算，
          // 否则新增一次执行会把该脚本的样本数和累计返回行数重置成单次值。
          const affectedSet = new Set(affectedScriptNos)
          const affectedExecutions = source.executions.filter((item) =>
            affectedSet.has(item.scriptNo),
          )
          const recomputed = aggregateExecutions(affectedExecutions, {
            version,
            previousRows: base.rows,
          })
          return mergeIncrementalRows(base.rows, recomputed, affectedScriptNos)
        })()
      : aggregateExecutions(inScope, {
          version,
          previousRows: base?.rows,
        })

  const dataset = makeDataset({
    version,
    publishedAt: formatDateTime(now),
    mode: options.mode,
    inheritedFrom: base?.version ?? null,
    notes:
      options.mode === 'incremental' && base
        ? `增量计算：窗口 ${start || '最早'} ~ ${end || '最新'} 识别出 ${affectedScriptNos.length} 个受影响脚本（按完整历史重算），其余 ${base.rows.length - affectedScriptNos.length} 个脚本沿用 ${base.version} 基线`
        : `全量计算：窗口 ${start || '最早'} ~ ${end || '最新'}，共 ${inScope.length} 条执行样本`,
    rows,
  })

  const run: PerfRunLog = {
    runId: `RUN-${version}`,
    at: dataset.publishedAt,
    mode: options.mode,
    status: 'success',
    version,
    preservedVersion: null,
    message:
      options.mode === 'incremental'
        ? `已发布增量版本 ${version}：窗口识别出 ${affectedScriptNos.length} 个受影响脚本，其余脚本沿用 ${base?.version ?? '上一版本'} 基线`
        : `已发布全量版本 ${version}：覆盖 ${inScope.length} 条执行样本（${affectedScriptNos.length} 个脚本）`,
    missingRecordNos: [],
    affectedScriptNos,
  }
  publishVersion(dataset, run)
  return dataset
}

export type PerfPageData = {
  dataset: PerfDataset | null
  versions: PerfDataset[]
  runs: PerfRunLog[]
  source: PerfSourceInfo
  rows: PerfScriptRow[]
  stats: PerfStats
}

/**
 * 首次打开：用全部可聚合历史生成一份基线，保证任何入口先看到的是有覆盖范围说明的样本，
 * 而不是一张空表。已存在已发布版本时不会自动重算。
 */
export function ensurePerfBaseline(): PerfDataset | null {
  if (activeDataset()) {
    return activeDataset()
  }
  const source = loadPerfSource()
  if (source.executions.length === 0) {
    return null
  }
  return buildDataset({ mode: 'full' })
}

/** 页面读取：当前生效版本 + 覆盖范围 + 按筛选条件过滤的脚本行。 */
export function loadPerfPage(filters: PerfRowFilters = {}): PerfPageData {
  try {
    ensurePerfBaseline()
  } catch {
    // 基线生成失败不该挡住页面：下面仍然展示当前生效版本（可能为空）和运行记录
  }
  const dataset = activeDataset()
  const source = loadPerfSource()
  const rows = dataset
    ? filterRowsByExecutions(dataset.rows, source.executions, filters)
    : []
  return {
    dataset,
    versions: listVersions(),
    runs: listRuns(),
    source,
    rows,
    stats: summarizeRows(rows),
  }
}

/** 只读预览历史版本：只读这个版本的指标和覆盖范围，不改变当前生效版本。 */
export function loadPerfVersion(
  version: string,
  filters: PerfRowFilters = {},
): PerfPageData | null {
  const target = getVersion(version)
  if (!target) {
    return null
  }
  const source = loadPerfSource()
  const rows = filterRowsByExecutions(target.rows, source.executions, filters)
  return {
    dataset: target,
    versions: listVersions(),
    runs: listRuns(),
    source,
    rows,
    stats: summarizeRows(rows),
  }
}

export function executionDetails(recordNos: string[]): RawExecution[] {
  const wanted = new Set(recordNos)
  const source = loadPerfSource()
  return source.executions
    .filter((item) => wanted.has(item.recordNo))
    .sort(
      (a, b) =>
        b.executedAt.localeCompare(a.executedAt) ||
        Number(b.error !== null) - Number(a.error !== null),
    )
}

export function executionsOfScript(scriptNo: string): RawExecution[] {
  return loadPerfSource().executions.filter((item) => item.scriptNo === scriptNo)
}

export function resetPerf(): void {
  resetPerfState()
}

export type PerfExport = { filename: string; content: string }

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function csv(header: string[], body: (string | number | boolean)[][]): string {
  const lines = [header.join(',')]
  for (const row of body) {
    lines.push(row.map(csvCell).join(','))
  }
  return `﻿${lines.join('\n')}`
}

export type ExportScope = {
  dataset: PerfDataset
  rows: PerfScriptRow[]
}

/** 查询性能聚合样本数据集的独立导出文件。 */
export function exportPerfDataset(scope: ExportScope): PerfExport {
  const { dataset, rows } = scope
  const header = [
    '聚合版本',
    '计算方式',
    '覆盖窗口开始',
    '覆盖窗口结束',
    '覆盖批次',
    '脚本记录编号',
    '脚本名称',
    '数据源',
    '样本查询数',
    '成功次数',
    '失败次数',
    '超时次数',
    '平均耗时毫秒',
    '成功平均耗时毫秒',
    '单次最长耗时毫秒',
    '返回行数合计',
    '错误分布',
    '高耗时标记',
    '高耗时起始版本',
    '趋势',
    '来源执行记录编号',
  ]
  const body = rows.map((row) => [
    dataset.version,
    dataset.mode === 'incremental' ? '增量' : '全量',
    dataset.coverage.windowStart,
    dataset.coverage.windowEnd,
    row.batchIds.join('|'),
    row.scriptNo,
    row.scriptName,
    row.sources.join('|'),
    row.sampleCount,
    row.successCount,
    row.failureCount,
    row.timeoutCount,
    row.avgDurationMs,
    row.successAvgDurationMs,
    row.maxDurationMs,
    row.returnedRowsTotal,
    row.errorDistribution.map((item) => `${item.kind}:${item.count}`).join('|'),
    row.highDuration ? '是' : '否',
    row.highSinceVersion || '—',
    row.trend,
    row.sourceRecordNos.join('|'),
  ])
  return { filename: `${dataset.version}-查询性能聚合样本.csv`, content: csv(header, body) }
}

/**
 * 查询优化页面的独立待优化导出：只挑出高耗时或有失败的脚本，
 * 并附上查询历史里对应的执行明细，便于优化人员按脚本追到执行行。
 */
export function exportOptimizationCandidates(scope: ExportScope): PerfExport {
  const candidates = scope.rows.filter(
    (row) => row.highDuration || row.failureCount > 0 || row.trend === '变慢',
  )
  const header = [
    '来源聚合版本',
    '覆盖窗口开始',
    '覆盖窗口结束',
    '脚本记录编号',
    '脚本名称',
    '数据源',
    '样本查询数',
    '平均耗时毫秒',
    '最慢耗时毫秒',
    '返回行数合计',
    '失败次数',
    '超时次数',
    '主要错误摘要',
    '高耗时标记',
    '高耗时起始版本',
    '趋势',
    '待优化原因',
    '来源执行记录编号',
  ]
  const body = candidates.map((row) => {
    const reasons: string[] = []
    if (row.highDuration) {
      reasons.push(row.highDurationReason || '已发布高耗时标记')
    }
    if (row.failureCount > 0) {
      reasons.push(`失败 ${row.failureCount} 次`)
    }
    if (row.trend === '变慢') {
      reasons.push('平均耗时较上一版本变慢')
    }
    const primaryError = row.errorSummaries[0]
    return [
      scope.dataset.version,
      row.windowStart,
      row.windowEnd,
      row.scriptNo,
      row.scriptName,
      row.sources.join('|'),
      row.sampleCount,
      row.avgDurationMs,
      row.maxDurationMs,
      row.returnedRowsTotal,
      row.failureCount,
      row.timeoutCount,
      primaryError ? `${primaryError.kind}：${primaryError.summary}（${primaryError.count} 次）` : '—',
      row.highDuration ? '是' : '否',
      row.highSinceVersion || '—',
      row.trend,
      reasons.join('；'),
      row.sourceRecordNos.join('|'),
    ]
  })
  return {
    filename: `${scope.dataset.version}-查询优化待优化清单.csv`,
    content: csv(header, body),
  }
}

/** 执行行明细导出，供从脚本追到具体执行行后带走核对。 */
export function exportExecutionRows(executions: RawExecution[], version: string): PerfExport {
  const header = [
    '聚合版本',
    '记录编号',
    '脚本记录编号',
    '脚本名称',
    '执行时间',
    '执行批次',
    '数据源',
    '返回行数',
    '执行耗时毫秒',
    '原始耗时值',
    '执行人',
    '状态',
    '错误归类',
    '错误摘要',
    '同次执行的其他错误摘要',
  ]
  const body = executions.map((item) => [
    version,
    item.recordNo,
    item.scriptNo,
    item.scriptName,
    item.executedAt,
    item.batch,
    item.source,
    item.returnedRows,
    item.durationMs,
    item.durationRaw,
    item.operator,
    item.status,
    item.error?.kind ?? '—',
    item.error?.summary ?? '—',
    item.error ? item.error.parts.slice(1).join(' | ') : '—',
  ])
  return { filename: `${version}-执行行明细.csv`, content: csv(header, body) }
}

export function downloadFile(file: PerfExport): void {
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export { getVersion }
export type { PerfState }
