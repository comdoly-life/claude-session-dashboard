import type { AgentInfo, AgentStatus } from 'claude-code'

import type { Activity, Tab, Tabs, TaskItem, Todo, Tokens, Workflow, WorkflowTask } from '../types'
import { MAIN, ZERO_TOKENS, sumTokens } from './format'
import { finishedAt, progress, standing, visibleTasks } from './workflow'

/** Where an item of the board stands: `idle` is alive but waiting (a teammate, the main session). */
export type ItemStatus = 'running' | 'idle' | 'done' | 'failed'

export type ItemKind = 'main' | 'agent' | 'team' | 'teammate' | 'flow' | 'task'

export type Count = { done: number; total: number; isOpen?: boolean }

/** One row of the board and what its detail tab opens on. */
export type Item = {
  /** The tab key: `main`, `agent:<id>`, `team`, `flow:<key>` or `task:<flow key>:<index>`. */
  key: string
  kind: ItemKind
  title: string
  sub?: string
  status: ItemStatus
  progress?: Count
  tokens: Tokens
  startedAt?: number
  endedAt?: number
  /** What it is doing now, in plain words. */
  doing?: string
  children: Item[]
  /** Settled children left off the board. */
  folded?: number
  /** A shorter label for its tab, when the title leads with its kind. */
  tab?: string
}

export type Board = { main: Item; running: Item[]; finished: Item[]; hidden: number }

export type BoardInput = {
  now: number
  agents: readonly AgentInfo[]
  activity: Readonly<Record<string, Activity>>
  flows: readonly Workflow[]
  tasks: Readonly<Record<string, TaskItem>>
  /** Rows a running workflow lists before it folds its settled agents. */
  maxTasks: number
  /** Settled items the board keeps before it counts the rest. */
  maxFinished: number
}

const MAX_DEPTH = 4

/** The engine's agent types in Korean; a plugin's or a custom one keeps its own name. */
const TYPE_LABELS: Record<string, string> = {
  'general-purpose': '범용 에이전트',
  claude: '범용 에이전트',
  Explore: '탐색 에이전트',
  Plan: '계획 에이전트',
  'claude-code-guide': 'Claude Code 안내',
  'statusline-setup': '상태 줄 설정',
  'workflow-subagent': '워크플로 에이전트',
  teammate: '팀원',
  fork: '포크',
}

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

/**
 * The board: the main session, then everything that runs (the agent team,
 * subagents and their children, workflows and their agents, agents only a
 * SubagentStart named), then what settled, newest first.
 */
export function buildBoard(input: BoardInput): Board {
  const { now, agents, activity, flows, tasks } = input
  const allTasks = Object.values(tasks)
  const linked = new Set(flows.flatMap(flow => flow.tasks.map(t => t.agentId ?? '')))
  const listed = new Set(agents.map(agent => agent.id))
  const live = (id: string | undefined, fallback: Tokens = ZERO_TOKENS) => {
    const tokens = id === undefined ? undefined : activity[id]?.tokens
    return tokens !== undefined && tokens.requests > 0 ? tokens : fallback
  }

  const mainOne = activity[MAIN]
  const main: Item = {
    key: 'main',
    kind: 'main',
    title: '메인 세션',
    status: mainOne?.isBusy === true ? 'running' : 'idle',
    tokens: mainOne?.tokens ?? ZERO_TOKENS,
    doing: doingOf(mainOne, allTasks.find(t => t.status === 'in_progress' && (t.by === MAIN || t.owner === undefined))) ??
      (mainOne?.isBusy === true ? '생각 중' : '대기 중'),
    children: [],
  }
  const mainCount = todoCount(mainOne?.todos) ?? taskCount(allTasks)
  if (mainCount !== undefined) main.progress = mainCount

  const tops: Item[] = []

  const teammates = agents.filter(isTeammate)
  if (teammates.length > 0) tops.push(teamItem(teammates, allTasks, activity))

  const subagents = agents.filter(agent => !isTeammate(agent))
  const ids = new Set(subagents.map(agent => agent.id))
  const childrenOf = new Map<string, AgentInfo[]>()
  for (const agent of subagents) {
    const parent = agent.parentId !== undefined && ids.has(agent.parentId) ? agent.parentId : ''
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), agent])
  }
  const agentItem = (agent: AgentInfo, depth: number): Item => {
    const one = activity[agent.id]
    const status = statusOf(agent.status)
    const item: Item = {
      key: `agent:${agent.id}`,
      kind: 'agent',
      title: agent.name ?? typeLabel(agent.type),
      sub: agent.description,
      status,
      progress: todoCount(one?.todos) ?? single(status),
      tokens: one?.tokens ?? ZERO_TOKENS,
      children: depth >= MAX_DEPTH ? [] : (childrenOf.get(agent.id) ?? []).map(child => agentItem(child, depth + 1)),
    }
    if (one !== undefined) item.startedAt = one.firstSeen
    const end = one?.stoppedAt ?? one?.endedAt
    if (isSettled(status) && end !== undefined) item.endedAt = end
    const doing = status === 'running' ? (doingOf(one) ?? '생각 중') : undefined
    if (doing !== undefined) item.doing = doing
    return item
  }
  tops.push(...(childrenOf.get('') ?? []).map(agent => agentItem(agent, 0)))

  for (const flow of flows) tops.push(flowItem(flow, now, input.maxTasks, activity, live))

  // A loop only a SubagentStart named: a workflow agent before its run's
  // journal is read, or one of a run this session never filed.
  for (const [id, one] of Object.entries(activity)) {
    if (id === MAIN || listed.has(id) || linked.has(id) || one.kind === undefined) continue
    const status: ItemStatus = one.stoppedAt !== undefined ? 'done' : 'running'
    const item: Item = {
      key: `agent:${id}`,
      kind: 'agent',
      title: typeLabel(one.kind),
      status,
      progress: todoCount(one.todos) ?? single(status),
      tokens: one.tokens,
      startedAt: one.firstSeen,
      children: [],
    }
    if (one.stoppedAt !== undefined) item.endedAt = one.stoppedAt
    const doing = status === 'running' ? (doingOf(one) ?? '생각 중') : undefined
    if (doing !== undefined) item.doing = doing
    tops.push(item)
  }

  const running = tops
    .filter(item => !isSettled(item.status))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const settled = tops
    .filter(item => isSettled(item.status))
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
  return {
    main,
    running,
    finished: settled.slice(0, input.maxFinished),
    hidden: Math.max(0, settled.length - input.maxFinished),
  }
}

function flowItem(
  flow: Workflow,
  now: number,
  maxTasks: number,
  activity: Readonly<Record<string, Activity>>,
  live: (id: string | undefined, fallback?: Tokens) => Tokens,
): Item {
  const standingNow = standing(flow, now)
  const count = progress(flow, standingNow)
  const status: ItemStatus = standingNow === 'running' ? 'running' : standingNow === 'done' ? 'done' : 'failed'
  const { shown, folded } = visibleTasks(flow, maxTasks)
  const item: Item = {
    key: `flow:${flow.key}`,
    kind: 'flow',
    title: `워크플로 · ${flow.name}`,
    tab: flow.name,
    status,
    progress: { done: count.done, total: count.total, isOpen: count.isOpen },
    tokens: sumTokens(flow.tasks.map(task => live(task.agentId, task.tokens))),
    startedAt: flow.startedAt,
    children: status === 'running' ? shown.map(task => taskItem(flow, task, activity, live)) : [],
    folded: status === 'running' ? folded : 0,
  }
  if (status !== 'running') {
    const end = finishedAt(flow)
    if (end !== undefined) item.endedAt = end
  } else {
    item.doing = [
      count.running > 0 ? `${count.running}개 실행 중` : '',
      count.waiting > 0 ? `${count.waiting}개 대기` : '',
      count.failed > 0 ? `${count.failed}개 실패` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return item
}

export function taskItem(
  flow: Workflow,
  task: WorkflowTask,
  activity: Readonly<Record<string, Activity>>,
  live: (id: string | undefined, fallback?: Tokens) => Tokens,
): Item {
  const status: ItemStatus = task.status === 'running' ? 'running' : task.status === 'done' ? 'done' : 'failed'
  const item: Item = {
    key: `task:${flow.key}:${task.index}`,
    kind: 'task',
    title: task.label,
    status,
    progress: single(status),
    tokens: live(task.agentId, task.tokens),
    startedAt: task.startedAt,
    children: [],
  }
  if (task.phase !== undefined) item.sub = task.phase
  if (task.endedAt !== undefined) item.endedAt = task.endedAt
  if (status === 'running') item.doing = doingOf(task.agentId === undefined ? undefined : activity[task.agentId]) ?? '생각 중'
  return item
}

function teamItem(members: readonly AgentInfo[], tasks: readonly TaskItem[], activity: Readonly<Record<string, Activity>>): Item {
  const names = (agent: AgentInfo) => [agent.name, agent.teammateId?.split('@')[0]].filter((n): n is string => n !== undefined)
  const children = members.map((agent): Item => {
    const one = activity[agent.id]
    const status = statusOf(agent.status)
    const owned = tasks.filter(t => t.owner !== undefined && names(agent).includes(t.owner))
    const item: Item = {
      key: `agent:${agent.id}`,
      kind: 'teammate',
      title: agent.name ?? agent.teammateId ?? typeLabel(agent.type),
      sub: agent.description,
      status,
      progress: taskCount(owned) ?? todoCount(one?.todos) ?? single(status),
      tokens: one?.tokens ?? ZERO_TOKENS,
      children: [],
    }
    if (one !== undefined) item.startedAt = one.firstSeen
    const end = one?.stoppedAt ?? one?.endedAt
    if (isSettled(status) && end !== undefined) item.endedAt = end
    const doing =
      status === 'running'
        ? (doingOf(one, owned.find(t => t.status === 'in_progress')) ?? '생각 중')
        : status === 'idle'
          ? '대기 중'
          : undefined
    if (doing !== undefined) item.doing = doing
    return item
  })
  const status: ItemStatus = children.some(c => c.status === 'running')
    ? 'running'
    : children.some(c => c.status === 'idle')
      ? 'idle'
      : children.every(c => c.status === 'done')
        ? 'done'
        : 'failed'
  const team = members.map(agent => agent.teammateId?.split('@')[1]).find((name): name is string => name !== undefined)
  const starts = children.map(c => c.startedAt).filter((at): at is number => at !== undefined)
  const ends = children.map(c => c.endedAt).filter((at): at is number => at !== undefined)
  const item: Item = {
    key: 'team',
    kind: 'team',
    title: team === undefined ? '에이전트 팀' : `에이전트 팀 ${team}`,
    status,
    progress: taskCount(tasks) ?? { done: children.filter(c => isSettled(c.status)).length, total: children.length },
    tokens: sumTokens(children.map(c => c.tokens)),
    children,
  }
  if (starts.length > 0) item.startedAt = Math.min(...starts)
  if (isSettled(status) && ends.length > 0) item.endedAt = Math.max(...ends)
  const busy = children.filter(c => c.status === 'running').length
  item.doing = busy > 0 ? `${busy}명 작업 중` : '모두 대기 중'
  return item
}

/**
 * What a loop is doing: the task or todo it marked in progress, then the
 * call it has in flight, both in plain words.
 */
export function doingOf(one: Activity | undefined, task?: TaskItem): string | undefined {
  const todo = one?.todos?.find(t => t.status === 'in_progress')
  const plan = task?.activeForm ?? task?.subject ?? todo?.activeForm ?? todo?.content
  const call = one?.running.at(-1)?.doing
  const parts = [plan, call].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

export function todoCount(todos: readonly Todo[] | undefined): Count | undefined {
  if (todos === undefined || todos.length === 0) return undefined
  return { done: todos.filter(t => t.status === 'completed').length, total: todos.length }
}

export function taskCount(tasks: readonly TaskItem[]): Count | undefined {
  if (tasks.length === 0) return undefined
  return { done: tasks.filter(t => t.status === 'completed').length, total: tasks.length }
}

/** An agent with no list of its own is one task: 0/1 until it settles. */
function single(status: ItemStatus): Count {
  return { done: status === 'done' ? 1 : 0, total: 1 }
}

export function statusOf(status: AgentStatus): ItemStatus {
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'killed') return 'failed'
  return status === 'idle' ? 'idle' : 'running'
}

export function isSettled(status: ItemStatus): boolean {
  return status === 'done' || status === 'failed'
}

export function isTeammate(agent: AgentInfo): boolean {
  return agent.teammateId !== undefined || agent.type === 'teammate'
}

/** The tab key of the board itself. */
export const ALL = 'all'
const MAX_TABS = 6

/** Opens (or retitles) a detail tab and shows it; the oldest of too many goes. */
export function openTab(tabs: Tabs, tab: Tab): Tabs {
  const isOpen = tabs.open.some(one => one.key === tab.key)
  const open = isOpen ? tabs.open.map(one => (one.key === tab.key ? tab : one)) : [...tabs.open, tab].slice(-MAX_TABS)
  return { open, active: tab.key }
}

/** Closes a tab; closing the one shown goes back to the board. */
export function closeTab(tabs: Tabs, key: string): Tabs {
  return { open: tabs.open.filter(one => one.key !== key), active: tabs.active === key ? ALL : tabs.active }
}

export function showTab(tabs: Tabs, key: string): Tabs {
  return key === ALL || tabs.open.some(one => one.key === key) ? { ...tabs, active: key } : tabs
}
