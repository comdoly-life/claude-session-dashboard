import type { ModelUsage } from 'claude-code'

import type { Activity, LimitWindow, Tokens } from '../types'

export const MAIN = 'main'

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR }
const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '주간',
  spend_limit: '지출',
}
const MAX_SAMPLES = 600
const SAME_RESET_MS = 5 * 60_000
const MIN_BAR = 6
const MAX_BAR = 24
const DETAIL_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']

export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }

export function freshActivity(now: number): Activity {
  return { running: [], tools: 0, tokens: ZERO_TOKENS, firstSeen: now, isBusy: false }
}

export function addUsage(tokens: Tokens, usage: ModelUsage): Tokens {
  return {
    input: tokens.input + usage.input_tokens,
    output: tokens.output + usage.output_tokens,
    cacheRead: tokens.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: tokens.cacheWrite + usage.cache_creation_input_tokens,
    requests: tokens.requests + 1,
  }
}

export function sumTokens(list: readonly Tokens[]): Tokens {
  return list.reduce(
    (sum, t) => ({
      input: sum.input + t.input,
      output: sum.output + t.output,
      cacheRead: sum.cacheRead + t.cacheRead,
      cacheWrite: sum.cacheWrite + t.cacheWrite,
      requests: sum.requests + t.requests,
    }),
    ZERO_TOKENS,
  )
}

/** Every input token the model read: uncached, cache-written and cache-read. */
export function inputTotal(t: Tokens): number {
  return t.input + t.cacheRead + t.cacheWrite
}

export function tokenText(t: Tokens): string {
  return t.requests === 0 ? '' : `↑${compact(inputTotal(t))} ↓${compact(t.output)}`
}

export function compact(n: number): string {
  const scaled = (x: number) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''))
  if (n < 1000) return String(n)
  if (n < 1e6) return `${scaled(n / 1e3)}k`
  if (n < 1e9) return `${scaled(n / 1e6)}M`
  return `${scaled(n / 1e9)}B`
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

export function toolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]}·${mcp[2]}` : tool
}

/** One line naming a tool call: the tool and its most telling argument, paths cut to their last part. */
export function describeCall(tool: string, input: Readonly<Record<string, unknown>>): string {
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const detail = key.endsWith('path') ? lastPart(value) : shortPaths(value.trim().split('\n')[0] ?? '')
    return `${toolLabel(tool)} ${detail}`.slice(0, 200)
  }
  return toolLabel(tool)
}

/** A path as its last part: `/repo/src/game.ts` is `game.ts`. */
export function lastPart(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path
}

/**
 * A line with each absolute or home path in it cut to its last part; a URL,
 * a path built on a variable and `/dev/...` are left whole.
 */
export function shortPaths(text: string): string {
  return text.replace(/(?<![\w.:/~$})-])~?\/(?!dev\/)[^\s'"`;|&()<>]+/g, lastPart)
}

const EDITS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const PLANS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

/**
 * What a loop is doing, in plain words for the board: no tool names or
 * paths, a file named by its last part; a Bash call by its own description.
 */
export function activityOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
  const file = lastPart(text('file_path') || text('notebook_path'))
  if (tool === 'Bash' || tool === 'PowerShell') return firstLine(text('description')) || '명령 실행 중'
  if (tool === 'Read') return file === '' ? '파일 읽는 중' : `${file} 읽는 중`
  if (EDITS.has(tool)) return file === '' ? '파일 수정 중' : `${file} 수정 중`
  if (tool === 'Write') return file === '' ? '파일 작성 중' : `${file} 작성 중`
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LSP') return '코드 찾는 중'
  if (tool === 'WebSearch') return '웹 검색 중'
  if (tool === 'WebFetch') return '웹 페이지 읽는 중'
  if (PLANS.has(tool)) return '작업 목록 정리 중'
  if (tool === 'Skill') return '스킬 불러오는 중'
  if (tool === 'ToolSearch') return '도구 준비 중'
  if (tool === 'SendMessage') return '메시지 보내는 중'
  if (tool === 'AskUserQuestion') return '질문에 답 기다리는 중'
  if (tool === 'Artifact') return '페이지 게시 중'
  const mcp = /^mcp__(.+?)__/.exec(tool)
  return mcp === null ? '작업 중' : `${mcp[1]} 작업 중`
}

function firstLine(text: string): string {
  return shortPaths(text.split('\n')[0] ?? '').slice(0, 120)
}

/**
 * A request or an agent's instructions in one line: its first sentence (or
 * line), a leading `[tag]` left off, paths cut to their last part (a relative
 * one too when it names a file, `src/a/b.ts` being `b.ts`), at most `width` cells.
 */
export function brief(text: string, width = 120): string {
  const body = text.replace(/^\s*\[[^\]\n]{1,80}\]\s*/, '')
  const line = (body.split('\n').find(one => one.trim() !== '') ?? '').trim().replace(/\s+/g, ' ')
  const sentence = /^.+?[.!?。！？](?=\s|$)/.exec(line)?.[0] ?? line
  const short = shortPaths(sentence.length >= 12 ? sentence : line).replace(
    /(?<![\w./~$-])(?:[\w.-]+\/)+([\w-]+\.[A-Za-z]\w{0,7})(?![\w/])/g,
    '$1',
  )
  return fit(short, width)
}

/** `text` cut to `width` terminal cells, an ellipsis marking the cut. */
export function fit(text: string, width: number): string {
  if (cells(text) <= width) return text
  let out = ''
  for (const char of text) {
    if (cells(out + char) > width - 1) break
    out += char
  }
  return `${out}…`
}

/** A short hash of a text (djb2), to know a script again without keeping it. */
export function hashOf(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return hash >>> 0
}

export function windowLabel(kind: string): string {
  return WINDOW_LABEL[kind] ?? kind
}

export function windowSpan(window: LimitWindow, now: number): { start: number; end: number } | undefined {
  const span = WINDOW_MS[window.kind]
  const end = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt)
  if (span === undefined || Number.isNaN(end)) return undefined
  return { start: end - span, end: Math.max(end, now) }
}

/**
 * Folds a fresh reading into a window's history: samples from before the
 * window began (an earlier window) are dropped, and a sample is added only
 * when the percentage moved, since usage carries forward until it does.
 */
export function recordLimit(
  prev: LimitWindow | undefined,
  reading: { kind: string; percentUsed: number; resetsAt?: string },
  now: number,
): LimitWindow {
  const next: LimitWindow = { kind: reading.kind, percentUsed: reading.percentUsed, samples: [] }
  if (reading.resetsAt !== undefined) next.resetsAt = reading.resetsAt
  const span = windowSpan(next, now)
  const history = isSameWindow(prev?.resetsAt, reading.resetsAt) ? (prev?.samples ?? []) : []
  const kept = history.filter(s => s.at <= now && (span === undefined || s.at >= span.start))
  const last = kept[kept.length - 1]
  next.samples = last?.percent === reading.percentUsed ? kept : [...kept, { at: now, percent: reading.percentUsed }]
  next.samples = next.samples.slice(-MAX_SAMPLES)
  return next
}

/** Two readings of one window name the same reset, give or take a drift. */
function isSameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return Math.abs(Date.parse(a) - Date.parse(b)) < SAME_RESET_MS
}

/** A window that has reset since it was read says nothing about now. */
export function isCurrent(window: LimitWindow, now: number): boolean {
  const end = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt)
  return Number.isNaN(end) || end > now
}

export type Tone = 'success' | 'warning' | 'error'

export function tone(percent: number): Tone {
  return percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success'
}

export function gauge(percent: number, width: number): { filled: string; empty: string } {
  const cells = Math.max(1, width)
  const filled = Math.min(cells, Math.round((Math.max(0, percent) / 100) * cells))
  return { filled: '█'.repeat(filled), empty: '░'.repeat(cells - filled) }
}

/** Terminal cells a text takes: Hangul and other wide letters take two. */
export function cells(text: string): number {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60)
    count += isWide ? 2 : 1
  }
  return count
}

export type Segment = {
  label: string
  percent: string
  tone: Tone
  bar?: { filled: string; empty: string }
  reset?: string
  warn?: string
}

/**
 * One window as the band draws it in `room` cells: its label, a gauge when
 * there is room for one, the percentage used, the time to its reset, and a
 * warning when the pace so far runs out of limit before the reset.
 */
export function limitSegment(window: LimitWindow, now: number, room: number): Segment {
  const end = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt)
  const hits = pace(window, now)?.hitsInMs
  const segment: Segment = {
    label: windowLabel(window.kind),
    percent: `${Math.round(window.percentUsed)}%`,
    tone:
      window.percentUsed >= 80 || (hits !== undefined && hits <= 0)
        ? 'error'
        : hits !== undefined
          ? 'warning'
          : tone(window.percentUsed),
  }
  if (!Number.isNaN(end)) segment.reset = `⟳${duration(end - now)}`
  if (hits !== undefined) segment.warn = hits <= 0 ? '⚠ 한도 도달' : `⚠ ${duration(hits)} 후 소진`

  const words = [segment.label, segment.percent, segment.reset, segment.warn].filter(Boolean)
  const fixed = words.reduce((sum, word) => sum + cells(word ?? ''), 0) + words.length
  const bar = Math.min(MAX_BAR, room - fixed)
  if (bar >= MIN_BAR) segment.bar = gauge(window.percentUsed, bar)
  return segment
}

/**
 * How the window is going: how much of it has passed, and either where usage
 * lands at the reset at the pace so far or, when that is past 100%, how long
 * until the limit is hit.
 */
export function pace(window: LimitWindow, now: number): { elapsed: number; projected?: number; hitsInMs?: number } | undefined {
  const span = windowSpan(window, now)
  if (span === undefined) return undefined
  const length = span.end - span.start
  const passed = Math.min(length, Math.max(0, now - span.start))
  const elapsed = Math.round((passed / length) * 100)
  if (passed < length * 0.05 || window.percentUsed <= 0) return { elapsed }
  const projected = Math.round((window.percentUsed / passed) * length)
  if (projected <= 100) return { elapsed, projected }
  const perMs = window.percentUsed / passed
  return { elapsed, projected, hitsInMs: (100 - window.percentUsed) / perMs }
}
