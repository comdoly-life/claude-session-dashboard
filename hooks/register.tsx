import { atom, read, update } from 'claude-code'
import type { AgentInfo, ConfigRow, EngineInterface, Register, SessionUsage, Settings } from 'claude-code'

import type { Activity, Controls, EffortLevel, LimitWindow, Meter, ModelFamily, Tabs, TaskItem, Todo, WorkflowCall } from '../types'
import { ALL, buildBoard, closeTab, openTab, showTab } from './board'
import { CHIP, EFFORTS, MODELS, NO_CONTROLS, afterCommand, effortOf, familyOf, isEffortLevel, isRefusal, modelText, savedEffort } from './controls'
import {
  MAIN,
  activityOf,
  addUsage,
  brief,
  describeCall,
  fit,
  freshActivity,
  isCurrent,
  recordLimit,
  limitBar,
  sumTokens,
  tokenText,
} from './format'
import { drawPane } from './view'
import {
  bindAgent,
  callOfScript,
  endWorkflow,
  finishTask,
  keepCall,
  readJournal,
  readNotice,
  readWorkflowCall,
  refuseTask,
  scriptPaths,
  startTask,
  syncRun,
  taskLabel,
} from './workflow'

const PANE = 'session-dashboard'
const TITLE = '대시보드'
const STORE_KEY = 'limit-windows'
const FAULTS_KEY = 'faults'
const TICK_MS = 5000
const MAX_FINISHED = 6
const MAX_TASKS = 6
const MAX_RECENT = 12
const MAX_FAULTS = 5
const MAX_RUNS = 12
/** A run whose journal and agents have been still this long has stopped unseen. */
const STALE_MS = 15 * 60_000
const BAND_GAP = 2
const LIMIT_GAP = '   '
const MODEL_ROW = 'model'
const WORKFLOWS_ROW = 'workflows'
// The Agent tool's own call spans a foreground subagent's run, and the
// Workflow tool's launches a run's agents: a tool.call hook on either would
// sit above those runs, and a hook is never run beneath its own frame.
const NOT_AGENT = /^(?!(?:Agent|Task|Workflow)$)/

const activity = atom({ plugin: 'session-dashboard', key: 'activity' } as const, {})
const meter = atom({ plugin: 'session-dashboard', key: 'meter' } as const, { limits: [] })
const tick = atom({ plugin: 'session-dashboard', key: 'tick' } as const, 0)
const calls = atom({ plugin: 'session-dashboard', key: 'calls' } as const, {})
const workflows = atom({ plugin: 'session-dashboard', key: 'workflows' } as const, [])
const tasks = atom({ plugin: 'session-dashboard', key: 'tasks' } as const, {})
const tabs = atom({ plugin: 'session-dashboard', key: 'tabs' } as const, { open: [], active: ALL })
const faults = atom({ plugin: 'session-dashboard', key: 'faults' } as const, [])
const controls = atom({ plugin: 'session-dashboard', key: 'controls' } as const, NO_CONTROLS)

type Engine = EngineInterface

/** Where this session keeps its transcript folder, once found. */
const place: { id?: string; dir?: string } = {}
/** Each run's journal time when last read, and what its saved script said. */
const journals = new Map<string, number>()
const scripts = new Map<string, WorkflowCall | null>()
let isSyncing = false

async function touch($: Engine, key: string, fn: (one: Activity, now: number) => Activity) {
  const now = await $.clock.now()
  await update($, activity, all => ({ ...all, [key]: { ...fn(all[key] ?? freshActivity(now), now), lastAt: now } }))
}

/** Keeps what failed where the board shows it, the store and the debug log. */
async function fault($: Engine, where: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
  try {
    $.ui.log(`session-dashboard ${where}: ${message}`, { to: 'debug' })
    const at = await $.clock.now()
    await update($, faults, list => [...list, { at, where, message }].slice(-MAX_FAULTS))
    await $.store.set(FAULTS_KEY, await read($, faults))
  } catch {
    // Nowhere left to say it.
  }
}

/** Runs a piece of bookkeeping; a failure costs the board a figure, never the event. */
async function safe($: Engine, where: string, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (error) {
    await fault($, where, error)
  }
}

async function recordMeter($: Engine, usage: Pick<SessionUsage, 'rateLimits' | 'cost' | 'context'>) {
  const now = await $.clock.now()
  const prev = await read($, meter)
  const saved = prev.limits.length > 0 ? [] : await loadSaved($)
  const known = [...prev.limits, ...saved]
  const fresh = usage.rateLimits.map(reading =>
    recordLimit(known.find(one => one.kind === reading.kind), reading, now),
  )
  const kept = known.filter(one => isCurrent(one, now) && !fresh.some(f => f.kind === one.kind))
  const limits = [...fresh, ...kept].sort((a, b) => order(a.kind) - order(b.kind))
  const next: Meter = { limits }
  if (usage.cost !== undefined) next.costUsd = usage.cost.usd
  if (usage.context.percent !== undefined) next.contextPercent = usage.context.percent
  await update($, meter, () => next)
  if (fresh.length > 0) await $.store.set(STORE_KEY, limits)
}

async function loadSaved($: Engine): Promise<LimitWindow[]> {
  const saved = await $.store.get(STORE_KEY)
  return Array.isArray(saved) ? (saved as LimitWindow[]) : []
}

function order(kind: string): number {
  const at = ['five_hour', 'seven_day'].indexOf(kind)
  return at === -1 ? 9 : at
}

/** The first of `paths` that reads: the script a call names instead of sending. */
async function scriptFile($: Engine, paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text === 'string') return text
  }
  return undefined
}

/** A classic event's transcript path names the session's folder exactly. */
function noteTranscript(path: unknown) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return
  place.dir = path.slice(0, -'.jsonl'.length)
  place.id = place.dir.split('/').pop()
}

/** The session's own folder (`<config>/projects/<project>/<session id>`), where runs keep their journals. */
async function sessionDir($: Engine): Promise<string | undefined> {
  const id = await $.session.id()
  if (place.id === id && place.dir !== undefined) return place.dir
  const home = await $.env.get('HOME')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
  if (config === undefined) return undefined
  for (const where of new Set([await $.session.root(), await $.session.cwd()])) {
    const dir = `${config}/projects/${where.replace(/[^A-Za-z0-9]/g, '-')}/${id}`
    if (await $.fs.exists(`${dir}.jsonl`).catch(() => false)) {
      place.id = id
      place.dir = dir
      return dir
    }
  }
  return undefined
}

/**
 * Reads the session's workflow runs off disk: each run's journal (which
 * agent it started, under what label and phase, and which returned) and its
 * saved script (name, phases, plan). A run is shown whether or not a hook saw
 * it start: one started before this plugin loaded, or while it reloaded.
 */
async function syncRuns($: Engine) {
  if (isSyncing) return
  isSyncing = true
  try {
    const dir = await sessionDir($)
    if (dir === undefined) return
    const root = `${dir}/subagents/workflows`
    if (!(await $.fs.exists(root).catch(() => false))) return
    const runs = (await $.fs.list(root).catch(() => [])).filter(entry => entry.kind === 'dir' && entry.name.startsWith('wf_'))
    if (runs.length === 0) return
    const saved = await $.fs.list(`${dir}/workflows/scripts`).catch(() => [])
    const stamped = await Promise.all(
      runs.map(async run => ({ run, stat: await $.fs.stat(`${root}/${run.name}/journal.jsonl`).catch(() => undefined) })),
    )
    const newest = stamped
      .filter((one): one is { run: (typeof runs)[number]; stat: NonNullable<typeof one.stat> } => one.stat !== undefined)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, MAX_RUNS)
    for (const { run, stat } of newest) {
      const runId = run.name
      if (journals.get(runId) === stat.mtimeMs) continue
      const entries = readJournal(await $.fs.read(`${root}/${runId}/journal.jsonl`))
      const script = saved.find(entry => entry.kind === 'file' && entry.name.endsWith(`-${runId}.js`))
      if (!scripts.has(runId)) {
        const text = script === undefined ? undefined : await $.fs.read(`${dir}/workflows/scripts/${script.name}`).catch(() => undefined)
        scripts.set(runId, typeof text === 'string' ? (callOfScript(text, await read($, calls)) ?? null) : null)
      }
      const call = scripts.get(runId) ?? undefined
      const at = Math.min(stat.mtimeMs, await $.clock.now())
      const startedAt = script?.mtimeMs !== undefined && script.mtimeMs > 0 ? script.mtimeMs : at
      await update($, workflows, list => syncRun(list, { runId, entries, startedAt, at, ...(call !== undefined && { call }) }))
      journals.set(runId, stat.mtimeMs)
    }
    await settleStale($, newest.map(one => ({ runId: one.run.name, at: one.stat.mtimeMs })))
  } catch (error) {
    await fault($, 'workflow sync', error)
  } finally {
    isSyncing = false
  }
}

/** A run still open whose journal and agents have all been still for long stopped without a word. */
async function settleStale($: Engine, runs: readonly { runId: string; at: number }[]) {
  const now = await $.clock.now()
  const all = await read($, activity)
  const flows = await read($, workflows)
  for (const { runId, at } of runs) {
    const flow = flows.find(one => one.runId === runId)
    if (flow === undefined || flow.status !== 'running' || now - at < STALE_MS) continue
    const heard = Math.max(at, ...flow.tasks.map(t => (t.agentId === undefined ? 0 : (all[t.agentId]?.lastAt ?? 0))))
    if (now - heard < STALE_MS) continue
    await update($, workflows, list => endWorkflow(list, { runId, status: 'stopped' }, now))
  }
}

function todosOf(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((row): Todo[] => {
    if (typeof row !== 'object' || row === null) return []
    const { content, status, activeForm } = row as Record<string, unknown>
    if (typeof content !== 'string' || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return []
    return [{ content, status, ...(typeof activeForm === 'string' && { activeForm }) }]
  })
}

/** Follows the session's task list through the calls that change it. */
async function noteTasks($: Engine, tool: string, input: Record<string, unknown>, output: unknown, by: string) {
  const now = await $.clock.now()
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  if (tool === 'TaskCreate') {
    const created = (output as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
    if (typeof created?.id !== 'string') return
    const id = created.id
    const subject = typeof created.subject === 'string' ? created.subject : (text('subject') ?? id)
    const activeForm = text('activeForm')
    await update($, tasks, all => ({
      ...all,
      [id]: { id, subject, status: all[id]?.status ?? 'pending', by, at: now, ...(activeForm !== undefined && { activeForm }) },
    }))
  } else if (tool === 'TaskUpdate') {
    const id = text('taskId')
    if (id === undefined) return
    const status = text('status')
    await update($, tasks, all => {
      const { [id]: known, ...rest } = all
      if (status === 'deleted') return rest
      const base: TaskItem = known ?? { id, subject: text('subject') ?? id, status: 'pending', at: now }
      const next: TaskItem = { ...base }
      if (status === 'pending' || status === 'in_progress' || status === 'completed') next.status = status
      const subject = text('subject')
      if (subject !== undefined) next.subject = subject
      const owner = text('owner')
      if (owner !== undefined) next.owner = owner
      const activeForm = text('activeForm')
      if (activeForm !== undefined) next.activeForm = activeForm
      return { ...rest, [id]: next }
    })
  }
}

/**
 * The effort a session on this model starts with: `CLAUDE_CODE_EFFORT_LEVEL` over what
 * settings keep for the model. A request's own effort (`turn.step`) tells better once one is sent.
 */
async function startingEffort($: Engine, model: string) {
  const forced = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL').catch(() => undefined)
  const settings = await $.settings.read().catch((): Settings => ({}))
  return effortOf(forced) ?? savedEffort(settings, model)
}

/**
 * Reads what the band's buttons show: the main loop's model, the workflows row and the
 * model's effort; an effort already known for the same model (a reload, a /clear) is kept.
 */
async function readControls($: Engine) {
  const model = await $.session.model()
  const rows = await $.config.list().catch((): ConfigRow[] => [])
  const workflows = rows.find(row => row.key === WORKFLOWS_ROW)?.value
  const effort = await startingEffort($, model)
  await update($, controls, now => {
    const next: Controls = { ...now, model }
    if (typeof workflows === 'boolean') next.workflows = workflows
    if (effort !== undefined && (now.effort === undefined || now.model !== model)) next.effort = effort
    return next
  })
}

/** Follows the main loop's model; another model starts on the effort settings keep for it. */
async function noteModel($: Engine): Promise<string> {
  const model = await $.session.model()
  if ((await read($, controls)).model === model) return model
  const effort = await startingEffort($, model)
  await update($, controls, now => (effort === undefined ? { ...now, model } : { ...now, model, effort }))
  return model
}

/** Runs a button's change in the background: the button drawn pending meanwhile, the outcome a toast. */
function act($: Engine, key: string, work: () => Promise<string>) {
  const run = async () => {
    await update($, controls, now => ({ ...now, pending: key }))
    try {
      $.ui.toast(await work())
    } catch (error) {
      await fault($, `control ${key}`, error)
      $.ui.toast(`바꾸지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await update($, controls, now => {
        if (now.pending !== key) return now
        const { pending: _, ...rest } = now
        return rest
      })
    }
  }
  void run().catch(error => fault($, 'control', error))
}

/** The family's alias names its latest model; a pick the `/config` row refuses (one asking consent first) goes through `/model`. */
async function chooseModel($: Engine, family: ModelFamily): Promise<string> {
  const set = await $.config.set({ key: MODEL_ROW, value: family }).catch((error: unknown) => ({ deny: String(error) }))
  let refused: string | undefined
  if (set.deny !== undefined) {
    const ran = await $.command.run({ command: 'model', args: family })
    if (isRefusal(ran.text)) refused = ran.text
  }
  const model = await noteModel($)
  return refused ?? `모델: ${modelText(model)}`
}

async function chooseEffort($: Engine, level: EffortLevel): Promise<string> {
  const ran = await $.command.run({ command: 'effort', args: level })
  await update($, controls, now => afterCommand(now, 'effort', level, ran.text))
  const effort = (await read($, controls)).effort
  return effort === level ? `effort: ${level}` : (ran.text ?? `effort: ${effort ?? '?'}`)
}

/** Whether the band draws ultracode on: it runs on dynamic workflows, so with them off it is off. */
function isUltracodeOn(state: Controls): boolean {
  return state.ultracode && state.workflows !== false
}

/**
 * Ultracode on or off. On needs the `/config` row `workflows` (Dynamic workflows), which
 * it turns on first where it is off; off leaves workflows on, for a workflow asked for by name.
 */
async function toggleUltracode($: Engine): Promise<string> {
  const now = await read($, controls)
  const wasOn = isUltracodeOn(now)
  let hasOpened = false
  if (!wasOn && now.workflows === false) {
    const set = await $.config.set({ key: WORKFLOWS_ROW, value: true })
    if (set.deny !== undefined) return `워크플로를 켜지 못해 울트라코드를 켤 수 없습니다: ${set.deny}`
    await update($, controls, current => ({ ...current, workflows: true }))
    hasOpened = true
  }
  const args = `ultracode ${wasOn ? 'off' : 'on'}`
  const ran = await $.command.run({ command: 'effort', args })
  await update($, controls, current => afterCommand(current, 'effort', args, ran.text))
  const isOn = isUltracodeOn(await read($, controls))
  if (isOn === wasOn) return ran.text ?? '울트라코드를 바꾸지 못했습니다.'
  if (!isOn) return '울트라코드 끔'
  return hasOpened ? '워크플로를 켜고 울트라코드 켬 (이 세션만)' : '울트라코드 켬 (이 세션만)'
}

/** The `/config` row `workflows` (Dynamic workflows): off takes ultracode down with it. */
async function toggleWorkflows($: Engine): Promise<string> {
  const isOn = (await read($, controls)).workflows !== true
  const set = await $.config.set({ key: WORKFLOWS_ROW, value: isOn })
  if (set.deny !== undefined) return `워크플로를 바꾸지 못했습니다: ${set.deny}`
  const workflows = set.value === true
  await update($, controls, now => ({ ...now, workflows }))
  return workflows ? '워크플로 켬' : '워크플로 끔 (울트라코드도 쓸 수 없음)'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dash',
      description: '세션 대시보드(서브에이전트·팀·워크플로·토큰)를 열거나 닫습니다',
    })
    await safe($, 'meter', async () => recordMeter($, await $.session.usage()))
    await safe($, 'controls', () => readControls($))
    $.clock.every(TICK_MS, () => {
      void update($, tick, n => n + 1)
      void syncRuns($)
    })
    void syncRuns($)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'dash' }, async $ => {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isShown === true) {
      await $.ui.close({ id: PANE })
      return { text: '대시보드를 닫았습니다.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '대시보드를 열었습니다.' }
  })

  // The person's own /model and /effort, typed or picked: the band follows what they left in force.
  on('command.run', { command: /^(?:model|effort)$/ }, async ($, e, next) => {
    const result = await next(e)
    await safe($, 'controls', async () => {
      await update($, controls, now => afterCommand(now, e.command, e.args, result.text))
      if (e.command === 'model') await noteModel($)
    })

    return result
  })

  // The same rows changed in /config; this plugin's own $.config.set never passes here.
  on('config.set', { key: /^(?:model|workflows)$/ }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      const workflows = result.value === true
      await safe($, 'controls', () =>
        e.key === WORKFLOWS_ROW ? update($, controls, now => ({ ...now, workflows })) : noteModel($),
      )
    }

    return result
  })

  // A /clear goes on under a new session id and fires no session.start: the band reads its model, effort and limits again.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await safe($, 'meter', async () => recordMeter($, await $.session.usage()))
      await safe($, 'controls', () => readControls($))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await safe($, 'meter', () => recordMeter($, e))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await safe($, 'turn.start', () =>
      touch($, e.agentId ?? MAIN, one => {
        const { endedAt: _, ...rest } = one
        return { ...rest, isBusy: true }
      }),
    )

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.effort
    if (e.agentId === undefined && isEffortLevel(effort)) {
      await safe($, 'controls', async () => {
        if ((await read($, controls)).effort !== effort) await update($, controls, now => ({ ...now, effort }))
      })
    }
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      await safe($, 'turn.step', () => touch($, e.agentId ?? MAIN, one => ({ ...one, tokens: addUsage(one.tokens, usage) })))
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const usage = e.usage
    await safe($, 'turn.complete', async () => {
      // A loop whose steps passed this plugin by is counted at its end.
      await touch($, agentId ?? MAIN, (one, now) => ({
        ...one,
        isBusy: false,
        running: [],
        endedAt: now,
        tokens: one.tokens.requests === 0 && usage !== undefined ? addUsage(one.tokens, usage) : one.tokens,
      }))
      if (agentId === undefined) return noteModel($)
      const isTask = (await read($, workflows)).some(flow => flow.tasks.some(t => t.agentId === agentId))
      if (!isTask) return
      const now = await $.clock.now()
      const tokens = (await read($, activity))[agentId]?.tokens ?? freshActivity(now).tokens
      await update($, workflows, list => finishTask(list, agentId, { isFailed: e.reason !== 'answer', tokens, now }))
    })

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await safe($, 'SubagentStart', async () => {
      noteTranscript(e.transcript_path)
      await touch($, e.agent_id, (one, now) => {
        const { stoppedAt: _, ...rest } = one
        return { ...rest, kind: e.agent_type, firstSeen: Math.min(one.firstSeen, now) }
      })
      if (e.agent_type === 'workflow-subagent') await syncRuns($)
    })

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await safe($, 'SubagentStop', async () => {
      noteTranscript(e.transcript_path)
      const reply = typeof e.last_assistant_message === 'string' ? e.last_assistant_message.slice(0, 600) : undefined
      await touch($, e.agent_id, (one, now) => ({
        ...one,
        isBusy: false,
        running: [],
        stoppedAt: now,
        ...(reply !== undefined && { reply }),
      }))
    })

    return next(e)
  })

  on('classic.TaskCreated', async ($, e, next) => {
    await safe($, 'TaskCreated', async () => {
      const at = await $.clock.now()
      const id = e.task_id
      await update($, tasks, all => ({
        ...all,
        [id]: { ...all[id], id, subject: e.task_subject, status: all[id]?.status ?? 'pending', at: all[id]?.at ?? at },
      }))
    })

    return next(e)
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    await safe($, 'TaskCompleted', async () => {
      const at = await $.clock.now()
      const id = e.task_id
      await update($, tasks, all => ({
        ...all,
        [id]: { ...all[id], id, subject: all[id]?.subject ?? e.task_subject, status: 'completed' as const, at: all[id]?.at ?? at },
      }))
    })

    return next(e)
  })

  on('tool.check', { tool: 'Workflow' }, async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (id === undefined || verdict.decision === 'deny') return verdict
    await safe($, 'Workflow check', async () => {
      const call = readWorkflowCall(e.input, await scriptFile($, scriptPaths(e.input)))
      if (call !== undefined) await update($, calls, all => keepCall(all, id, call))
    })

    return verdict
  })

  // 서브에이전트·팀원·워크플로 에이전트가 받은 지시를 한 줄로: 세부 탭의 "맡은 일"
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const agentId = result.agentId
    const task = brief(String(e.prompt ?? ''))
    if (agentId !== undefined && task !== '') {
      await safe($, 'agent.spawn', () => touch($, agentId, one => ({ ...one, task })))
    }

    return result
  })

  // 메인 세션의 "맡은 일": 사람이 직접(터미널·원격·SDK) 보낸 마지막 요청. 슬래시 명령, 보이지 않는 알림,
  // 다른 세션이 보낸 메시지는 덮어쓰지 않는다.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const isOwn = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (isOwn && e.command === undefined && e.isMeta !== true) {
      const task = brief(e.text)
      if (task !== '') await safe($, 'prompt.submit', () => touch($, MAIN, one => ({ ...one, task })))
    }

    return next(e)
  })

  on('agent.spawn', { workflow: { runId: /^wf_/ } }, async ($, e, next) => {
    const run = e.workflow
    if (run === undefined) return next(e)
    const key = e.tool_use_id ?? ''
    const { runId, agentIndex: index } = run
    await safe($, 'workflow spawn', async () => {
      const now = await $.clock.now()
      const call = key === '' ? undefined : (await read($, calls))[key]
      const label = taskLabel(String(e.description ?? ''), String(e.prompt ?? ''))
      await update($, workflows, list => startTask(list, { key, runId, index, label, now, ...(call && { call }) }))
    })
    const result = await next(e)
    await safe($, 'workflow spawn', async () => {
      if (result.agentId !== undefined) {
        const agentId = result.agentId
        await update($, workflows, list => bindAgent(list, runId, key, index, agentId))
      } else if (result.deny !== undefined) {
        const now = await $.clock.now()
        await update($, workflows, list => refuseTask(list, runId, key, index, now))
      }
    })

    return result
  })

  on('session.append', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    const stored = await next(e)
    await safe($, 'task notification', async () => {
      const text = e.message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
      const notice = readNotice(text)
      if (notice === undefined) return
      if (notice.runId !== undefined) journals.delete(notice.runId)
      await syncRuns($)
      const now = await $.clock.now()
      await update($, workflows, list => endWorkflow(list, notice, now))
    })

    return stored
  })

  on('tool.call', { tool: NOT_AGENT }, async ($, e, next) => {
    const key = e.agentId ?? MAIN
    const input = e as unknown as Record<string, unknown>
    const call = { id: e.tool_use_id, text: describeCall(e.tool, input), doing: activityOf(e.tool, input) }
    const todos = e.tool === 'TodoWrite' ? todosOf(input.todos) : undefined
    await safe($, 'tool.call', () =>
      touch($, key, one => ({
        ...one,
        isBusy: true,
        running: [...one.running, call].slice(-8),
        ...(todos !== undefined && { todos }),
      })),
    )
    let output: unknown
    try {
      const result = await next(e)
      if (result.deny === undefined && result.isError !== true) output = result.result
      return result
    } finally {
      await safe($, 'tool.call', async () => {
        await touch($, key, one => ({
          ...one,
          running: one.running.filter(c => c.id !== call.id),
          last: call.text,
          recent: [...(one.recent ?? []), call.text].slice(-MAX_RECENT),
          tools: one.tools + 1,
        }))
        if (output !== undefined) await noteTasks($, e.tool, input, output, key)
      })
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const { Box, Text } = kit
    try {
      await read($, tick)
      const now = await $.clock.now()
      const all = await read($, activity)
      const { costUsd, contextPercent } = await read($, meter)
      const agents = await $.agent.list().catch((): AgentInfo[] => [])
      const flows = await read($, workflows)
      const taskList = await read($, tasks)
      const tabState = await read($, tabs)
      const faultList = await read($, faults)
      const board = buildBoard({ now, agents, activity: all, flows, tasks: taskList, maxTasks: MAX_TASKS, maxFinished: MAX_FINISHED })
      const total = sumTokens(Object.values(all).map(one => one.tokens))
      const totals = [
        `합계 ${tokenText(total) || '0'}`,
        costUsd === undefined ? '' : `$${costUsd.toFixed(2)}`,
        contextPercent === undefined ? '' : `컨텍스트 ${contextPercent}%`,
      ]
        .filter(Boolean)
        .join(' · ')
      const press = (change: (state: Tabs) => Tabs) => {
        void update($, tabs, change).catch(error => fault($, 'tab', error))
      }
      return drawPane({
        kit,
        now,
        width: e.props.bodyColumns,
        board,
        tabs: tabState,
        agents,
        activity: all,
        flows,
        tasks: taskList,
        faults: faultList,
        totals,
        open: (key, title) => press(state => openTab(state, { key, title: fit(title, 24) })),
        close: key => press(state => closeTab(state, key)),
        show: key => press(state => showTab(state, key)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void $.store.set(FAULTS_KEY, [{ at: Date.now(), where: 'render', message }]).catch(() => undefined)
      return (
        <Box flexDirection="column">
          <Text color="error">대시보드를 그리지 못했습니다.</Text>
          <Text dimColor wrap="wrap">
            {message}
          </Text>
        </Box>
      )
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const windows = (await read($, meter)).limits.filter(one => isCurrent(one, now))
    const state = await read($, controls)

    const { Box, Text, Button } = $.ui.resolve(e)
    const press = (key: string, work: () => Promise<string>) => () => act($, key, work)
    const family = familyOf(state.model)
    const room = Math.floor((e.props.bodyColumns - LIMIT_GAP.length * (windows.length - 1)) / Math.max(1, windows.length))
    // A chip: the gray of an idle button, or its group's bright color once picked.
    const chip = (key: string, label: string, picked: string | undefined, onPress: () => void) => (
      <Button plain key={key} onPress={onPress}>
        {picked === undefined ? (
          <Text backgroundColor={CHIP.idle} color="text">{` ${label}${state.pending === key ? '…' : ''} `}</Text>
        ) : (
          <Text backgroundColor={picked} color={CHIP.ink} weight="bold">{` ${label}${state.pending === key ? '…' : ''} `}</Text>
        )}
      </Button>
    )

    // The blank row above keeps the band apart from the transcript's output; the limits, the
    // model and effort, and workflows with ultracode keep a row each; a narrow terminal wraps groups.
    return (
      <Box flexDirection="column" marginTop={1}>
        {windows.length > 0 && (
          <Text wrap="truncate-end">
            {windows.map((window, index) => {
              const bar = limitBar(window, room)
              return (
                <Text>
                  {index > 0 ? LIMIT_GAP : ''}
                  <Text weight="bold">{bar.label}</Text>{' '}
                  {bar.used !== '' && <Text color={bar.color}>{bar.used}</Text>}
                  {bar.free !== '' && <Text dimColor>{bar.free}</Text>}
                  {bar.used !== '' || bar.free !== '' ? ' ' : ''}
                  <Text dimColor>잔여 </Text>
                  <Text color={bar.color} weight="bold">{`${bar.left}%`}</Text>
                </Text>
              )
            })}
          </Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={BAND_GAP}>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>모델</Text>
            {MODELS.map(one => {
              const key = `model:${one.family}`
              const isPicked = one.family === family
              return chip(key, isPicked ? modelText(state.model) : one.label, isPicked ? CHIP.model : undefined, press(key, () => chooseModel($, one.family)))
            })}
          </Box>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>effort</Text>
            {EFFORTS.map(one => {
              const key = `effort:${one.level}`
              return chip(key, one.label, one.level === state.effort ? CHIP.effort : undefined, press(key, () => chooseEffort($, one.level)))
            })}
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={BAND_GAP}>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>워크플로</Text>
            {state.workflows === true
              ? chip('workflows', 'ON', CHIP.workflows, press('workflows', () => toggleWorkflows($)))
              : chip('workflows', state.workflows === false ? 'OFF' : '—', undefined, press('workflows', () => toggleWorkflows($)))}
          </Box>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>울트라코드</Text>
            {isUltracodeOn(state)
              ? chip('ultracode', 'ON', CHIP.ultracode, press('ultracode', () => toggleUltracode($)))
              : chip('ultracode', 'OFF', undefined, press('ultracode', () => toggleUltracode($)))}
          </Box>
        </Box>
      </Box>
    )
  })
}
