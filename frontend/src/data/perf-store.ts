import type { PerfDataset, PerfRunLog } from './perf-core'

// 已发布的聚合样本版本只能追加，不能就地覆盖：旧版本连同覆盖范围一起留着备查。
const STORAGE_KEY = 'data-explore-selfservice:perf-datasets'

export type PerfState = {
  versions: PerfDataset[]
  activeVersion: string | null
  runs: PerfRunLog[]
}

const EMPTY_STATE: PerfState = { versions: [], activeVersion: null, runs: [] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeState(value: unknown): PerfState {
  if (!value || typeof value !== 'object') {
    return clone(EMPTY_STATE)
  }
  const input = value as Partial<PerfState>
  const versions = Array.isArray(input.versions)
    ? input.versions.filter(
        (item): item is PerfDataset =>
          Boolean(item) && typeof item === 'object' && Array.isArray((item as PerfDataset).rows),
      )
    : []
  const activeVersion =
    typeof input.activeVersion === 'string' &&
    versions.some((item) => item.version === input.activeVersion)
      ? input.activeVersion
      : versions.length > 0
        ? versions[versions.length - 1].version
        : null
  const runs = Array.isArray(input.runs)
    ? input.runs.filter((item): item is PerfRunLog => Boolean(item) && typeof item === 'object')
    : []
  return { versions, activeVersion, runs }
}

let cache: PerfState | null = null

export function readPerfState(): PerfState {
  if (cache) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = clone(EMPTY_STATE)
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = clone(EMPTY_STATE)
    return cache
  }
  try {
    cache = normalizeState(JSON.parse(raw))
  } catch {
    cache = clone(EMPTY_STATE)
  }
  return cache
}

function persist(state: PerfState): PerfState {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
  return state
}

export function activeDataset(): PerfDataset | null {
  const state = readPerfState()
  if (!state.activeVersion) {
    return null
  }
  return state.versions.find((item) => item.version === state.activeVersion) ?? null
}

export function listVersions(): PerfDataset[] {
  return [...readPerfState().versions].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
}

export function getVersion(version: string): PerfDataset | null {
  return readPerfState().versions.find((item) => item.version === version) ?? null
}

export function listRuns(limit = 30): PerfRunLog[] {
  return [...readPerfState().runs]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

/**
 * 只有完整构建成功的版本才会推进 activeVersion。
 * 中断时调用方拿到的仍是上一份有效数据集。
 * 按记录编号的核对版本只归档、不接管 activeVersion：不能因为一次抽样核对
 * 就让读者误以为完整基线只剩几条记录。
 */
export function publishVersion(
  dataset: PerfDataset,
  run: PerfRunLog,
  options: { activate?: boolean } = {},
): PerfState {
  const state = readPerfState()
  if (state.versions.some((item) => item.version === dataset.version)) {
    throw new Error(`聚合样本版本 ${dataset.version} 已存在，版本号不能复用`)
  }
  return persist({
    versions: [...state.versions, dataset],
    activeVersion: options.activate === false ? state.activeVersion : dataset.version,
    runs: [...state.runs, run].slice(-200),
  })
}

/** 记录一次未产出版本的运行：activeVersion 保持不动。 */
export function recordInterruptedRun(run: PerfRunLog): PerfState {
  const state = readPerfState()
  return persist({ ...state, runs: [...state.runs, run].slice(-200) })
}

export function resetPerfState(): PerfState {
  return persist(clone(EMPTY_STATE))
}

export function perfStorageKey(): string {
  return STORAGE_KEY
}
