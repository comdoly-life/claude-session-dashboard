import type { Tokens, Workflow, WorkflowCall, WorkflowStatus, WorkflowTask } from '../types'
import { ZERO_TOKENS, hashOf, shortPaths, sumTokens } from './format'
import { planOf } from './plan'

const MAX_WORKFLOWS = 12
const MAX_CALLS = 20
const MAX_LABEL = 120
/** A run whose agents have all settled and that starts none for this long is done. */
export const QUIET_MS = 60_000

/**
 * What a Workflow call's input says about the run: its script's meta, or its
 * name, and how many agents the script starts. `file` is the script a
 * `scriptPath` or `name` call runs, when it could be read.
 */
export function readWorkflowCall(input: unknown, file?: string): WorkflowCall | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const args = input as Record<string, unknown>
  const script = typeof args.script === 'string' ? args.script : file
  const named = (): WorkflowCall | undefined => {
    if (typeof args.name === 'string' && args.name !== '') return { name: args.name, phases: [] }
    if (typeof args.scriptPath !== 'string' || args.scriptPath === '') return undefined
    const base = args.scriptPath.split('/').pop() ?? args.scriptPath
    return { name: base.replace(/\.[^.]+$/, ''), phases: [] }
  }
  const call = (script === undefined ? undefined : metaOf(script)) ?? named()
  if (call === undefined) return undefined
  if (script !== undefined) {
    call.plan = planOf(script, args.args)
    call.hash = hashOf(script)
  }
  if (args.args !== undefined) call.args = args.args
  return call
}

/** What a run's saved script says about it: its meta and plan, `args` from the call that ran it. */
export function callOfScript(script: string, calls: Readonly<Record<string, WorkflowCall>>): WorkflowCall | undefined {
  const meta = metaOf(script)
  if (meta === undefined) return undefined
  const hash = hashOf(script)
  const call = Object.values(calls).find(one => one.hash === hash)
  return { ...meta, plan: planOf(script, call?.args), hash }
}

/** Where a call that names its script rather than sending it keeps that script. */
export function scriptPaths(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const args = input as Record<string, unknown>
  if (typeof args.script === 'string') return []
  if (typeof args.scriptPath === 'string' && args.scriptPath !== '') return [args.scriptPath]
  if (typeof args.name !== 'string' || !/^[\w.-]+$/.test(args.name)) return []
  return [`.claude/workflows/${args.name}.js`, `.claude/workflows/${args.name}.mjs`]
}

/** The `export const meta = { name, description, phases }` literal a workflow script begins with. */
export function metaOf(script: string): WorkflowCall | undefined {
  const head = /export\s+const\s+meta\s*=\s*\{/.exec(script)
  if (head === null) return undefined
  const open = head.index + head[0].length - 1
  const body = script.slice(open + 1, closing(script, open))
  const top = topLevel(body)
  const name = stringField(top, 'name')
  if (name === undefined) return undefined
  const call: WorkflowCall = { name, phases: [] }
  const description = stringField(top, 'description')
  if (description !== undefined) call.description = description
  const phases = /\bphases\s*:\s*\[/.exec(body)
  if (phases !== null) {
    const from = phases.index + phases[0].length - 1
    const list = body.slice(from + 1, closing(body, from))
    call.phases = [...list.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(m => unescape(m[2] ?? ''))
  }
  return call
}

/** Where the bracket opened at `open` closes, strings skipped; the text's end when it never does. */
function closing(text: string, open: number): number {
  let depth = 0
  let quote: string | undefined
  for (let at = open; at < text.length; at += 1) {
    const char = text[at]
    if (quote !== undefined) {
      if (char === '\\') at += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return text.length
}

/** An object body with its nested objects and lists left out, strings kept. */
function topLevel(body: string): string {
  let out = ''
  let depth = 0
  let quote: string | undefined
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at] ?? ''
    if (quote !== undefined) {
      if (depth === 0) out += char
      if (char === '\\') {
        if (depth === 0) out += body[at + 1] ?? ''
        at += 1
      } else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    if (char === '{' || char === '[' || char === '(') depth += 1
    if (depth === 0) out += char
    if (char === '}' || char === ']' || char === ')') depth = Math.max(0, depth - 1)
  }
  return out
}

function stringField(text: string, key: string): string | undefined {
  const found = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(text)
  return found === null ? undefined : unescape(found[2] ?? '')
}

function unescape(text: string): string {
  return text.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').trim()
}

/** A workflow agent's line: its description, else its prompt's first line. */
export function taskLabel(description: string, prompt: string): string {
  const text = description.trim() !== '' ? description : (prompt.trim().split('\n')[0] ?? '')
  return shortPaths(text.trim()).slice(0, MAX_LABEL) || '작업'
}

export function keepCall(all: Record<string, WorkflowCall>, id: string, call: WorkflowCall): Record<string, WorkflowCall> {
  const entries = [...Object.entries(all).filter(([key]) => key !== id), [id, call] as const]
  return Object.fromEntries(entries.slice(-MAX_CALLS))
}

function find(list: readonly Workflow[], key: string, runId: string): number {
  if (runId !== '') {
    const byRun = list.findIndex(one => one.runId === runId)
    if (byRun !== -1) return byRun
  }
  return key === '' ? -1 : list.findIndex(one => one.key === key)
}

/**
 * Files an agent a run's `agent()` started: under its run, found by run id
 * and then by the Workflow call that started it, or under a new entry.
 * The same place in a run (a resume replaying it) takes the task over.
 */
export function startTask(
  list: readonly Workflow[],
  start: { key: string; runId: string; index: number; label: string; call?: WorkflowCall; now: number },
): Workflow[] {
  const { key, runId, index, label, call, now } = start
  const at = find(list, key, runId)
  const task: WorkflowTask = { index, label, status: 'running', startedAt: now, tokens: ZERO_TOKENS }
  const base: Workflow =
    at === -1
      ? {
          key: key !== '' ? key : runId,
          name: call?.name ?? (runId !== '' ? runId : 'workflow'),
          phases: call?.phases ?? [],
          status: 'running',
          startedAt: now,
          tasks: [],
        }
      : (list[at] as Workflow)
  const { endedAt: _, ...open } = base
  const next: Workflow = { ...open, status: 'running', tasks: [...base.tasks.filter(t => t.index !== index), task] }
  next.tasks.sort((a, b) => a.index - b.index)
  if (runId !== '') next.runId = runId
  if (call !== undefined) {
    next.name = call.name
    next.phases = call.phases
    if (call.description !== undefined) next.description = call.description
    if (call.plan !== undefined) next.plan = call.plan
  }
  const rest = list.filter((_one, i) => i !== at)
  return trim([...rest, next])
}

/**
 * Names the agent a started task runs as, so its end can find it; a row the
 * run's journal filed for the same agent first is folded into this one.
 */
export function bindAgent(list: readonly Workflow[], runId: string, key: string, index: number, agentId: string): Workflow[] {
  const at = find(list, key, runId)
  if (at === -1) return [...list]
  return list.map((one, i) => {
    if (i !== at) return one
    const twin = one.tasks.find(t => t.agentId === agentId && t.index !== index)
    const tasks = one.tasks
      .filter(t => t !== twin)
      .map(t => (t.index !== index ? t : { ...t, agentId, ...(twin?.phase !== undefined && { phase: twin.phase }) }))
    return { ...one, tasks }
  })
}

/** Settles the task an agent ran, as done or failed, with what it cost. */
export function finishTask(
  list: readonly Workflow[],
  agentId: string,
  end: { isFailed: boolean; tokens: Tokens; now: number },
): Workflow[] {
  return list.map(one =>
    one.tasks.some(t => t.agentId === agentId)
      ? {
          ...one,
          tasks: one.tasks.map(t =>
            t.agentId === agentId && t.status === 'running'
              ? { ...t, status: end.isFailed ? 'failed' : 'done', endedAt: end.now, tokens: end.tokens }
              : t,
          ),
        }
      : one,
  )
}

/** Fails the task a refused spawn left running. */
export function refuseTask(list: readonly Workflow[], runId: string, key: string, index: number, now: number): Workflow[] {
  const at = find(list, key, runId)
  return list.map((one, i) =>
    i !== at
      ? one
      : { ...one, tasks: one.tasks.map(t => (t.index === index ? { ...t, status: 'failed', endedAt: now } : t)) },
  )
}

/** One line of a run's `journal.jsonl`: `started`, `result` and the rest. */
export type JournalEntry = { type: string; agentId?: string; label?: string; phase?: string; result?: unknown }

export function readJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      if (typeof row.type !== 'string') continue
      const entry: JournalEntry = { type: row.type }
      if (typeof row.agentId === 'string') entry.agentId = row.agentId
      if (typeof row.label === 'string') entry.label = row.label
      if (typeof row.phase === 'string') entry.phase = row.phase
      if ('result' in row) entry.result = row.result === null ? null : true
      entries.push(entry)
    } catch {
      // A line still being written reads whole on the next pass.
    }
  }
  return entries
}

/**
 * Brings a run in line with its journal on disk: each agent it started (by
 * agent id, with its label and phase) and each that returned, a null return
 * being a failed or skipped one. A run the hooks never saw is filed here.
 * What the journal shows is dated by when it was last written (`at`).
 */
export function syncRun(
  list: readonly Workflow[],
  run: { runId: string; entries: readonly JournalEntry[]; call?: WorkflowCall; startedAt: number; at: number },
): Workflow[] {
  const at = list.findIndex(one => one.runId === run.runId)
  const base: Workflow =
    at === -1
      ? { key: run.runId, runId: run.runId, name: run.runId, phases: [], status: 'running', startedAt: run.startedAt, tasks: [] }
      : (list[at] as Workflow)
  const tasks = [...base.tasks]
  for (const entry of run.entries) {
    const agentId = entry.agentId
    if (agentId === undefined) continue
    const found = tasks.findIndex(t => t.agentId === agentId)
    if (entry.type === 'started') {
      const label = entry.label === undefined ? undefined : taskLabel(entry.label, '')
      if (found !== -1) {
        const task = tasks[found] as WorkflowTask
        tasks[found] = { ...task, ...(entry.phase !== undefined && { phase: entry.phase }), ...(label !== undefined && task.label === '작업' && { label }) }
        continue
      }
      const index = Math.max(0, ...tasks.map(t => t.index)) + 1
      const task: WorkflowTask = { index, label: label ?? '작업', status: 'running', agentId, startedAt: run.at, tokens: ZERO_TOKENS }
      if (entry.phase !== undefined) task.phase = entry.phase
      tasks.push(task)
      continue
    }
    const task = found === -1 ? undefined : tasks[found]
    if (task === undefined || task.status !== 'running') continue
    if (entry.type === 'result') {
      tasks[found] = { ...task, status: entry.result === null ? 'failed' : 'done', endedAt: run.at }
    } else if (/error|fail/i.test(entry.type)) {
      tasks[found] = { ...task, status: 'failed', endedAt: run.at }
    }
  }
  const next: Workflow = { ...base, tasks }
  const call = run.call
  if (call !== undefined && (next.name === run.runId || next.plan === undefined)) {
    next.name = call.name
    next.phases = call.phases
    if (call.description !== undefined) next.description = call.description
    if (call.plan !== undefined) next.plan = call.plan
  }
  if (at === -1) return trim([...list, next])
  return list.map((one, i) => (i === at ? next : one))
}

export type Notice = { toolUseId?: string; runId?: string; status: WorkflowStatus }

/** What a background task's notification says: which call or run, and how it ended. */
export function readNotice(text: string): Notice | undefined {
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim()
  const word = tag('status')?.toLowerCase()
  const status: WorkflowStatus | undefined =
    word === undefined
      ? undefined
      : /^(completed|done|success)/.test(word)
        ? 'done'
        : /^(failed|error)/.test(word)
          ? 'failed'
          : /^(killed|stopped|cancel)/.test(word)
            ? 'stopped'
            : undefined
  if (status === undefined) return undefined
  const notice: Notice = { status }
  const toolUseId = tag('tool-use-id')
  if (toolUseId !== undefined && toolUseId !== '') notice.toolUseId = toolUseId
  const runId = /\bwf_[A-Za-z0-9_-]+/.exec(text)?.[0]
  if (runId !== undefined) notice.runId = runId
  return notice.toolUseId === undefined && notice.runId === undefined ? undefined : notice
}

/** Ends the run a notification names; the agents it left running end with it. */
export function endWorkflow(list: readonly Workflow[], notice: Notice, now: number): Workflow[] {
  const at = find(list, notice.toolUseId ?? '', notice.runId ?? '')
  if (at === -1) return [...list]
  return list.map((one, i) =>
    i !== at
      ? one
      : {
          ...one,
          status: notice.status,
          endedAt: now,
          tasks: one.tasks.map(t =>
            t.status === 'running' ? { ...t, status: notice.status === 'done' ? 'done' : 'failed', endedAt: now } : t,
          ),
        },
  )
}

/** Keeps the newest runs, dropping settled ones first. */
function trim(list: Workflow[]): Workflow[] {
  if (list.length <= MAX_WORKFLOWS) return list
  const drop = new Set(
    list
      .filter(one => one.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, list.length - MAX_WORKFLOWS),
  )
  return list.filter(one => !drop.has(one)).slice(-MAX_WORKFLOWS)
}

/**
 * Where a run stands now: its notification's word, or done once every agent
 * it started has settled and it has started none for a while.
 */
export function standing(flow: Workflow, now: number): WorkflowStatus {
  if (flow.status !== 'running' || flow.tasks.length === 0) return flow.status
  if (flow.tasks.some(t => t.status === 'running')) return 'running'
  const last = Math.max(...flow.tasks.map(t => t.endedAt ?? t.startedAt))
  return now - last >= QUIET_MS ? 'done' : 'running'
}

export function finishedAt(flow: Workflow): number | undefined {
  if (flow.endedAt !== undefined) return flow.endedAt
  const ends = flow.tasks.map(t => t.endedAt).filter((at): at is number => at !== undefined)
  return ends.length === 0 ? undefined : Math.max(...ends)
}

export type Progress = {
  /** Agents that finished their work, those the journal replayed among them. */
  done: number
  failed: number
  running: number
  /** Agents the script starts that have not started yet. */
  waiting: number
  /** Agents replayed from a resumed run's journal: done, never raised. */
  cached: number
  total: number
  /** The total is a floor: more agents hang on what the run's agents return. */
  isOpen: boolean
  /** How far along the run is, 0 to 100. */
  percent: number
  tokens: Tokens
}

/**
 * Where a run's agents stand against all the run starts: the plan its script
 * gave, or the agents seen, whichever is more; a done run counts the agents
 * it did start, since a branch it skipped never comes.
 */
export function progress(flow: Workflow, status: WorkflowStatus): Progress {
  const count = (state: WorkflowTask['status']) => flow.tasks.filter(t => t.status === state).length
  const seen = Math.max(flow.tasks.length, ...flow.tasks.map(t => t.index))
  const cached = seen - flow.tasks.length
  const isRunning = status === 'running'
  const total = status === 'done' ? seen : Math.max(seen, flow.plan?.total ?? 0)
  const done = count('done') + cached
  return {
    done,
    failed: count('failed'),
    running: count('running'),
    waiting: isRunning ? total - seen : 0,
    cached,
    total,
    isOpen: isRunning && (flow.plan === undefined || flow.plan.isOpen),
    percent: total === 0 ? 0 : Math.floor((done / total) * 100),
    tokens: sumTokens(flow.tasks.map(t => t.tokens)),
  }
}

/**
 * How the pane lays the runs out, newest first: every running run open, or
 * the newest when none runs; the settled runs before it as passing lines.
 */
export function arrange(list: readonly Workflow[], now: number, keep: number): { open: Workflow[]; passed: Workflow[]; hidden: number } {
  const newest = [...list].sort((a, b) => b.startedAt - a.startedAt)
  const running = newest.filter(one => standing(one, now) === 'running')
  const open = running.length > 0 ? running : newest.slice(0, 1)
  const rest = newest.filter(one => !open.includes(one))
  return { open, passed: rest.slice(0, keep), hidden: Math.max(0, rest.length - keep) }
}

/** The tasks an open run lists in `room` rows: all that run, then the latest settled. */
export function visibleTasks(flow: Workflow, room: number): { shown: WorkflowTask[]; folded: number } {
  if (flow.tasks.length <= room) return { shown: flow.tasks, folded: 0 }
  const running = flow.tasks.filter(t => t.status === 'running')
  const settled = flow.tasks
    .filter(t => t.status !== 'running')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, Math.max(0, room - running.length))
  const shown = [...running.slice(0, room), ...settled].sort((a, b) => a.index - b.index)
  return { shown, folded: flow.tasks.length - shown.length }
}
