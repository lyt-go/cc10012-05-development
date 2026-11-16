/**
 * 查询性能聚合的纯计算层：不依赖 Vue、localStorage 或浏览器。
 *
 * 数据链路固定为：
 *   查询历史执行行 -> 错误归类 / 耗时归一 -> 按脚本记录编号聚合 -> 带覆盖范围的聚合样本版本
 *
 * 这里只做计算，版本持久化和页面动作分别放在 perf-store.ts / perf-service.ts。
 */

export type EntryLike = Record<string, unknown>

export type ErrorKind =
  | '超时'
  | '资源/锁冲突'
  | '连接失败'
  | '权限不足'
  | '对象不存在'
  | '语法错误'
  | '其他错误'

export type NormalizedError = {
  kind: ErrorKind
  /** 同一执行下多个错误摘要只保留这一条可解释的主摘要 */
  summary: string
  /** 原始拆分出来的摘要，用于追溯被合并掉的噪声行 */
  parts: string[]
}

export type RawExecution = {
  id: number
  recordNo: string
  scriptNo: string
  scriptName: string
  summary: string
  executedAt: string
  date: string
  durationMs: number
  durationRaw: string
  returnedRows: number
  source: string
  operator: string
  status: string
  batch: string
  error: NormalizedError | null
}

export type ErrorBucket = {
  kind: ErrorKind
  count: number
}

export type ErrorSummaryBucket = {
  kind: ErrorKind
  summary: string
  count: number
  recordNos: string[]
}

export type PerfScriptRow = {
  scriptNo: string
  scriptName: string
  sources: string[]
  windowStart: string
  windowEnd: string
  batchIds: string[]
  /** 样本查询数：纳入聚合的执行行数 */
  sampleCount: number
  successCount: number
  /** 失败次数：有错误的执行行数，一次执行最多计 1 次 */
  failureCount: number
  /** 超时次数，是 failureCount 的子集 */
  timeoutCount: number
  /** 平均耗时毫秒 = Σ每次执行耗时 / sampleCount */
  avgDurationMs: number
  /** 成功执行的平均耗时毫秒 */
  successAvgDurationMs: number
  maxDurationMs: number
  /** 返回行数按脚本记录累计 */
  returnedRowsTotal: number
  errorDistribution: ErrorBucket[]
  errorSummaries: ErrorSummaryBucket[]
  /** 已发布的高耗时标记：一旦打上，后续增量不消失 */
  highDuration: boolean
  highSinceVersion: string
  highDurationReason: string
  trend: '新增' | '变慢' | '改善' | '持平'
  firstSeenVersion: string
  /** 最近一次重算该脚本指标的版本；其他脚本沿用旧值 */
  updatedInVersion: string
  /** 来源执行记录编号，聚合结果可回溯到原始执行行 */
  sourceRecordNos: string[]
  sourceRecordIds: number[]
}

export type PerfCoverage = {
  windowStart: string
  windowEnd: string
  batchIds: string[]
  /** 覆盖的执行行数（去重后的来源记录编号数） */
  recordCount: number
  scriptCount: number
}

export type PerfDataset = {
  version: string
  publishedAt: string
  mode: 'full' | 'incremental'
  /** window = 按时间窗口采集；records = 按指定记录编号做的核对版本 */
  scope: 'window' | 'records'
  status: 'published'
  /** 增量版本沿用的上一份有效数据集 */
  inheritedFrom: string | null
  notes: string
  coverage: PerfCoverage
  rows: PerfScriptRow[]
}

export type PerfRunLog = {
  runId: string
  at: string
  mode: 'full' | 'incremental'
  status: 'success' | 'interrupted'
  version: string | null
  preservedVersion: string | null
  message: string
  missingRecordNos: string[]
  affectedScriptNos: string[]
}

export const HIGH_DURATION_AVG_MS = 1000
export const HIGH_DURATION_MAX_MS = 5000

const ERROR_PRIORITY: Record<ErrorKind, number> = {
  超时: 0,
  '资源/锁冲突': 1,
  连接失败: 2,
  权限不足: 3,
  对象不存在: 4,
  语法错误: 5,
  其他错误: 6,
}

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  return String(value).trim()
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }
  const digits = text(value).replace(/[,_\s]/g, '')
  const parsed = Number.parseInt(digits, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 把历史行里可能混用的耗时写法统一成毫秒。 */
export function parseDurationMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }
  const raw = text(value).replace(/[,_\s]/g, '').toLowerCase()
  if (!raw) {
    return 0
  }
  const matched = raw.match(/^(\d+(?:\.\d+)?)(ms|毫秒|s|秒)?$/)
  if (!matched) {
    const numeric = raw.replace(/[^\d.]/g, '')
    const fallback = Number.parseFloat(numeric)
    return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : 0
  }
  const amount = Number.parseFloat(matched[1])
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0
  }
  const unit = matched[2] ?? 'ms'
  const factor = unit === 's' || unit === '秒' ? 1000 : 1
  return Math.max(0, Math.round(amount * factor))
}

export function classifyError(message: string): ErrorKind {
  const value = message.toLowerCase()
  if (/超时|timeout|timed out|deadline exceeded|超过\s*\d+\s*(s|秒)/.test(value)) {
    return '超时'
  }
  if (/死锁|deadlock|\block\b|锁等待|锁超时|内存|out of memory|资源不足|too many connections|连接池.*满/.test(value)) {
    return '资源/锁冲突'
  }
  if (/连接|connection|refused|network|网络|socket/.test(value)) {
    return '连接失败'
  }
  if (/权限|permission|denied|forbidden|无权|未授权/.test(value)) {
    return '权限不足'
  }
  if (/不存在|not\s*found|unknown column|unknown table|已下线|no such/.test(value)) {
    return '对象不存在'
  }
  if (/语法|syntax|parse|解析|invalid sql/.test(value)) {
    return '语法错误'
  }
  return '其他错误'
}

/**
 * 一次执行可能带多行错误摘要。这里按优先级挑一条可解释的主摘要，
 * 其余只留在 parts 里供追溯，不参与失败次数统计。
 */
export function normalizeError(value: unknown): NormalizedError | null {
  const raw = text(value)
  if (!raw) {
    return null
  }
  const parts = raw
    .split(/[\n\r;；|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const unique = [...new Set(parts)]
  if (unique.length === 0) {
    return null
  }
  const ranked = [...unique].sort((a, b) => ERROR_PRIORITY[classifyError(a)] - ERROR_PRIORITY[classifyError(b)])
  const primary = ranked[0]
  const summary = primary.length > 80 ? `${primary.slice(0, 80)}…` : primary
  return { kind: classifyError(primary), summary, parts: unique }
}

/** 稳定短哈希：给缺脚本编号的历史行生成可重复的归组键。 */
function shortHash(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36).toUpperCase().slice(0, 6).padStart(6, '0')
}

export function dateOf(executedAt: string): string {
  return executedAt.slice(0, 10)
}

/** 单条历史记录行 -> 可聚合的执行行。字段缺失时做保守兜底，不丢记录编号。 */
export function executionFromHistoryRow(row: EntryLike): RawExecution {
  const id = Number(row.id ?? 0)
  const recordNo = text(row['记录编号']) || `HIST-${id}`
  const summary = text(row['查询语句摘要'])
  // 老历史行可能没有脚本记录编号：按查询语句摘要归组，既不丢记录也不把不同查询混成一个脚本。
  const explicitScriptNo = text(row['脚本记录编号']) || text(row['脚本编号'])
  const scriptNo = explicitScriptNo || `未关联脚本-${shortHash(summary || recordNo)}`
  const scriptName =
    text(row['脚本名称']) || (explicitScriptNo ? scriptNo : `未关联脚本（${summary.slice(0, 16) || recordNo}）`)
  const executedAt = text(row['执行时间'])
  const durationRaw = text(row['执行耗时毫秒'])
  const error = normalizeError(row['错误信息'])
  const batch = text(row['执行批次']) || `BATCH-${dateOf(executedAt).replace(/-/g, '')}`
  return {
    id,
    recordNo,
    scriptNo,
    scriptName,
    summary,
    executedAt,
    date: dateOf(executedAt),
    durationMs: parseDurationMs(row['执行耗时毫秒']),
    durationRaw,
    returnedRows: integer(row['返回行数']),
    source: text(row['数据源']) || '未标注数据源',
    operator: text(row['执行人']),
    status: text(row.status),
    batch,
    error,
  }
}

/** 草稿和已删除的历史不进入性能聚合，避免把未执行/撤回的记录算成样本。 */
export function isAggregatableStatus(status: string): boolean {
  return status !== '已删除' && status !== '草稿'
}

export function inWindow(execution: RawExecution, start?: string, end?: string): boolean {
  if (!execution.date) {
    return false
  }
  if (start && execution.date < start) {
    return false
  }
  if (end && execution.date > end) {
    return false
  }
  return true
}

type AggregateOptions = {
  version: string
  previousRows?: PerfScriptRow[]
}

function highReason(row: {
  avgDurationMs: number
  maxDurationMs: number
  timeoutCount: number
  highFromPrevious: boolean
  previousVersion: string
}): string {
  const reasons: string[] = []
  if (row.avgDurationMs >= HIGH_DURATION_AVG_MS) {
    reasons.push(`平均耗时 ${row.avgDurationMs}ms ≥ ${HIGH_DURATION_AVG_MS}ms`)
  }
  if (row.maxDurationMs >= HIGH_DURATION_MAX_MS) {
    reasons.push(`单次最长 ${row.maxDurationMs}ms ≥ ${HIGH_DURATION_MAX_MS}ms`)
  }
  if (row.timeoutCount > 0) {
    reasons.push(`存在 ${row.timeoutCount} 次超时`)
  }
  if (reasons.length > 0) {
    return reasons.join('；')
  }
  if (row.highFromPrevious) {
    return `沿用 ${row.previousVersion} 已发布的高耗时标记`
  }
  return ''
}

function trendOf(avg: number, previous?: PerfScriptRow): PerfScriptRow['trend'] {
  if (!previous) {
    return '新增'
  }
  if (avg > previous.avgDurationMs * 1.15) {
    return '变慢'
  }
  if (avg < previous.avgDurationMs * 0.85) {
    return '改善'
  }
  return '持平'
}

/** 按脚本记录编号聚合执行行。previousRows 用于延续高耗时标记和趋势比较。 */
export function aggregateExecutions(
  executions: RawExecution[],
  options: AggregateOptions,
): PerfScriptRow[] {
  const previous = new Map<string, PerfScriptRow>()
  for (const row of options.previousRows ?? []) {
    previous.set(row.scriptNo, row)
  }

  const grouped = new Map<string, RawExecution[]>()
  for (const execution of executions) {
    if (!execution.scriptNo || !execution.executedAt) {
      continue
    }
    const list = grouped.get(execution.scriptNo) ?? []
    list.push(execution)
    grouped.set(execution.scriptNo, list)
  }

  const rows: PerfScriptRow[] = []
  for (const [scriptNo, list] of grouped) {
    const sorted = [...list].sort(
      (a, b) => a.executedAt.localeCompare(b.executedAt) || a.id - b.id,
    )
    const prev = previous.get(scriptNo)
    const sampleCount = sorted.length
    const failures = sorted.filter((item) => item.error !== null)
    const failureCount = failures.length
    const timeoutCount = failures.filter((item) => item.error?.kind === '超时').length
    const successCount = sampleCount - failureCount
    const durations = sorted.map((item) => item.durationMs)
    const sumDuration = durations.reduce((sum, value) => sum + value, 0)
    const successDuration = sorted
      .filter((item) => item.error === null)
      .reduce((sum, item) => sum + item.durationMs, 0)
    const avgDurationMs = sampleCount > 0 ? Math.round(sumDuration / sampleCount) : 0
    const successAvgDurationMs =
      successCount > 0 ? Math.round(successDuration / successCount) : 0
    const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0
    const returnedRowsTotal = sorted.reduce((sum, item) => sum + item.returnedRows, 0)

    const kindCounts = new Map<ErrorKind, number>()
    const summaryMap = new Map<string, ErrorSummaryBucket>()
    for (const failure of failures) {
      const error = failure.error as NormalizedError
      kindCounts.set(error.kind, (kindCounts.get(error.kind) ?? 0) + 1)
      const key = `${error.kind}::${error.summary}`
      const bucket = summaryMap.get(key) ?? {
        kind: error.kind,
        summary: error.summary,
        count: 0,
        recordNos: [],
      }
      bucket.count += 1
      bucket.recordNos.push(failure.recordNo)
      summaryMap.set(key, bucket)
    }

    const computedHigh =
      avgDurationMs >= HIGH_DURATION_AVG_MS ||
      maxDurationMs >= HIGH_DURATION_MAX_MS ||
      timeoutCount > 0
    const carriedHigh = prev?.highDuration === true
    const highDuration = computedHigh || carriedHigh
    const highSinceVersion = highDuration
      ? prev?.highDuration
        ? prev.highSinceVersion
        : options.version
      : ''
    const previousVersion = prev?.updatedInVersion ?? prev?.firstSeenVersion ?? '上一版本'

    const scriptName =
      sorted.find((item) => item.scriptName && item.scriptName !== scriptNo)?.scriptName ??
      prev?.scriptName ??
      scriptNo
    const sources = [...new Set(sorted.map((item) => item.source))].sort()
    const batchIds = [...new Set(sorted.map((item) => item.batch))].sort()
    const windowStart = sorted[0].date
    const windowEnd = sorted[sorted.length - 1].date
    const sourceRecordNos = [...new Set(sorted.map((item) => item.recordNo))].sort()
    const sourceRecordIds = sorted.map((item) => item.id)

    rows.push({
      scriptNo,
      scriptName,
      sources,
      windowStart,
      windowEnd,
      batchIds,
      sampleCount,
      successCount,
      failureCount,
      timeoutCount,
      avgDurationMs,
      successAvgDurationMs,
      maxDurationMs,
      returnedRowsTotal,
      errorDistribution: [...kindCounts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      errorSummaries: [...summaryMap.values()].sort((a, b) => b.count - a.count),
      highDuration,
      highSinceVersion,
      highDurationReason: highReason({
        avgDurationMs,
        maxDurationMs,
        timeoutCount,
        highFromPrevious: carriedHigh && !computedHigh,
        previousVersion,
      }),
      trend: trendOf(avgDurationMs, prev),
      firstSeenVersion: prev?.firstSeenVersion ?? options.version,
      updatedInVersion: options.version,
      sourceRecordNos,
      sourceRecordIds,
    })
  }

  return rows.sort((a, b) => a.scriptNo.localeCompare(b.scriptNo))
}

export function makeDataset(input: {
  version: string
  publishedAt: string
  mode: 'full' | 'incremental'
  scope?: 'window' | 'records'
  inheritedFrom: string | null
  notes: string
  rows: PerfScriptRow[]
}): PerfDataset {
  const rows = [...input.rows].sort((a, b) => a.scriptNo.localeCompare(b.scriptNo))
  const recordNos = new Set<string>()
  const batches = new Set<string>()
  let windowStart = ''
  let windowEnd = ''
  for (const row of rows) {
    for (const recordNo of row.sourceRecordNos) {
      recordNos.add(recordNo)
    }
    for (const batch of row.batchIds) {
      batches.add(batch)
    }
    if (!windowStart || row.windowStart < windowStart) {
      windowStart = row.windowStart
    }
    if (!windowEnd || row.windowEnd > windowEnd) {
      windowEnd = row.windowEnd
    }
  }
  return {
    version: input.version,
    publishedAt: input.publishedAt,
    mode: input.mode,
    scope: input.scope ?? 'window',
    status: 'published',
    inheritedFrom: input.inheritedFrom,
    notes: input.notes,
    coverage: {
      windowStart,
      windowEnd,
      batchIds: [...batches].sort(),
      recordCount: recordNos.size,
      scriptCount: rows.length,
    },
    rows,
  }
}

/** 增量合并：只替换受影响脚本，其他脚本整行沿用上一版本的基线。 */
export function mergeIncrementalRows(
  baseRows: PerfScriptRow[],
  recomputed: PerfScriptRow[],
  affectedScriptNos: string[],
): PerfScriptRow[] {
  const affected = new Set(affectedScriptNos)
  const recomputedMap = new Map(recomputed.map((row) => [row.scriptNo, row]))
  const merged: PerfScriptRow[] = []
  for (const row of baseRows) {
    if (affected.has(row.scriptNo)) {
      const next = recomputedMap.get(row.scriptNo)
      if (next) {
        merged.push(next)
      }
      // 受影响脚本在本窗口没有执行时，不从旧版本强行保留已不在范围内的指标
      continue
    }
    merged.push(row)
  }
  for (const row of recomputed) {
    if (!baseRows.some((item) => item.scriptNo === row.scriptNo)) {
      merged.push(row)
    }
  }
  return merged.sort((a, b) => a.scriptNo.localeCompare(b.scriptNo))
}

export type PerfStats = {
  scriptCount: number
  sampleCount: number
  failureCount: number
  timeoutCount: number
  highCount: number
  avgDurationMs: number
  returnedRowsTotal: number
}

export function summarizeRows(rows: PerfScriptRow[]): PerfStats {
  const sampleCount = rows.reduce((sum, row) => sum + row.sampleCount, 0)
  const weightedDuration = rows.reduce(
    (sum, row) => sum + row.avgDurationMs * row.sampleCount,
    0,
  )
  return {
    scriptCount: rows.length,
    sampleCount,
    failureCount: rows.reduce((sum, row) => sum + row.failureCount, 0),
    timeoutCount: rows.reduce((sum, row) => sum + row.timeoutCount, 0),
    highCount: rows.filter((row) => row.highDuration).length,
    avgDurationMs: sampleCount > 0 ? Math.round(weightedDuration / sampleCount) : 0,
    returnedRowsTotal: rows.reduce((sum, row) => sum + row.returnedRowsTotal, 0),
  }
}

export type PerfRowFilters = {
  keyword?: string
  source?: string
  start?: string
  end?: string
  highOnly?: boolean
  failedOnly?: boolean
}

/** 判断某条执行是否命中筛选条件（脚本关键字、数据源、日期窗口）。 */
export function executionMatchesFilters(
  execution: RawExecution,
  filters: PerfRowFilters,
): boolean {
  const keyword = (filters.keyword ?? '').trim()
  if (
    keyword &&
    !execution.scriptNo.includes(keyword) &&
    !execution.scriptName.includes(keyword)
  ) {
    return false
  }
  const source = (filters.source ?? '').trim()
  if (source && !execution.source.includes(source)) {
    return false
  }
  return inWindow(execution, filters.start, filters.end)
}

/**
 * 筛选只决定展示哪些脚本和哪些明细执行；脚本的聚合指标仍按其完整覆盖窗口计算，
 * 避免读者把「筛选后的局部数字」误当成整份数据集的指标。
 */
export function filterRowsByExecutions(
  rows: PerfScriptRow[],
  executions: RawExecution[],
  filters: PerfRowFilters,
): PerfScriptRow[] {
  const byRecordNo = new Map(executions.map((item) => [item.recordNo, item]))
  return rows.filter((row) => {
    if (filters.highOnly && !row.highDuration) {
      return false
    }
    if (filters.failedOnly && row.failureCount === 0) {
      return false
    }
    if (!filters.keyword && !filters.source && !filters.start && !filters.end) {
      return true
    }
    const resolved = row.sourceRecordNos
      .map((recordNo) => byRecordNo.get(recordNo))
      .filter((item): item is RawExecution => Boolean(item))
    if (resolved.length > 0) {
      return resolved.some((execution) => executionMatchesFilters(execution, filters))
    }
    // 旧版本引用的执行行可能已被清理：退回用聚合行自带的窗口和数据源判断，不整行吞掉。
    return rowLevelMatches(row, filters)
  })
}

function rowLevelMatches(row: PerfScriptRow, filters: PerfRowFilters): boolean {
  const keyword = (filters.keyword ?? '').trim()
  if (keyword && !row.scriptNo.includes(keyword) && !row.scriptName.includes(keyword)) {
    return false
  }
  const source = (filters.source ?? '').trim()
  if (source && !row.sources.some((item) => item.includes(source))) {
    return false
  }
  const start = filters.start ?? ''
  const end = filters.end ?? ''
  if (start && row.windowEnd && row.windowEnd < start) {
    return false
  }
  if (end && row.windowStart && row.windowStart > end) {
    return false
  }
  return true
}

export function versionSequence(versions: { version: string }[], day: string): number {
  const prefix = `PERF-${day.replace(/-/g, '')}-`
  return versions.filter((item) => item.version.startsWith(prefix)).length + 1
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
