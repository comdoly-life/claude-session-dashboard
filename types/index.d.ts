/** A tool call in flight: how the detail tab names it, and the plain words the board shows. */
export type RunningCall = { id: string; text: string; doing: string }

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

/** One line of a loop's TodoWrite list. */
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

/** What one loop (the main thread, a subagent, a teammate, a workflow agent) has done this session. */
export type Activity = {
  running: RunningCall[]
  last?: string
  /** The calls it made, newest last, as the detail tab lists them. */
  recent?: string[]
  tools: number
  tokens: Tokens
  firstSeen: number
  /** The last time any of its events came. */
  lastAt?: number
  isBusy: boolean
  endedAt?: number
  todos?: Todo[]
  /** What it was asked to do, in one line: an agent's spawn prompt, the main session's last request. */
  task?: string
  /** The agent type its SubagentStart named (`Explore`, `workflow-subagent`, ...). */
  kind?: string
  /** When its SubagentStop came, and what it last said. */
  stoppedAt?: number
  reply?: string
}

/** One task of the session's task list (TaskCreate / TaskUpdate, the team's shared list). */
export type TaskItem = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  activeForm?: string
  /** The loop that created it: `main` or an agent id. */
  by?: string
  at: number
}

export type LimitSample = { at: number; percent: number }

export type LimitWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
  samples: LimitSample[]
}

export type Meter = {
  limits: LimitWindow[]
  costUsd?: number
  contextPercent?: number
}

export type TaskStatus = 'running' | 'done' | 'failed'

/** One `agent()` call of a workflow run. */
export type WorkflowTask = {
  index: number
  label: string
  status: TaskStatus
  agentId?: string
  phase?: string
  startedAt: number
  endedAt?: number
  tokens: Tokens
}

export type WorkflowStatus = 'running' | 'done' | 'failed' | 'stopped'

/**
 * How many agents a run's script starts, read from the script before it
 * runs; `isOpen` when more hang on what its agents return.
 */
export type WorkflowPlan = { total: number; isOpen: boolean }

/** One Workflow tool call and the agents its run started. */
export type Workflow = {
  /** The Workflow call's tool_use_id, or the run id when the call is unknown. */
  key: string
  runId?: string
  name: string
  description?: string
  phases: string[]
  plan?: WorkflowPlan
  status: WorkflowStatus
  startedAt: number
  endedAt?: number
  tasks: WorkflowTask[]
}

/** What a Workflow call said about itself before it ran. */
export type WorkflowCall = {
  name: string
  description?: string
  phases: string[]
  plan?: WorkflowPlan
  /** The call's `args`, which a plan read later from the run's saved script needs. */
  args?: unknown
  /** A hash of the script the call runs, to know its saved copy again. */
  hash?: number
}

/** A detail tab: what it shows, by the board's item key, and its label. */
export type Tab = { key: string; title: string }

/** The pane's tabs: `active` is `all` for the board, else an open tab's key. */
export type Tabs = { open: Tab[]; active: string }

/** A hook or a drawing that failed: shown on the board, never swallowed. */
export type Fault = { at: number; where: string; message: string }

/** A model family the band picks by its alias, which names the family's latest model. */
export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The session's model, effort, workflows and ultracode, as the band's buttons show them. */
export type Controls = {
  /** The main loop's model as `$.session.model()` answers it (`claude-opus-5-5`). */
  model?: string
  /** `auto` once `/effort auto` handed the effort back to the model's default. */
  effort?: EffortLevel | 'auto'
  /** The `/config` row `workflows` (Dynamic workflows); unknown until read. */
  workflows?: boolean
  /** Ultracode for this session, as `/effort ultracode on|off` last left it. */
  ultracode: boolean
  /** The button whose change is still on its way, drawn with an ellipsis. */
  pending?: string
}

/** A Claude Code session running on this machine, as its registry file names it. */
export type Peer = {
  pid: number
  sessionId: string
  /** The folder it runs in, without a trailing separator. */
  cwd: string
  name?: string
  /** `busy`, `idle`, or what else the registry says. */
  status?: string
  /** What it waits on, when it waits on the person. */
  waitingFor?: string
  kind?: string
  entrypoint?: string
  version?: string
  startedAt?: number
  /** When its status last changed. */
  statusAt?: number
}

/** The sessions the registry lists, and which of them is this one. */
export type Peers = {
  list: Peer[]
  /** This session's id; it keeps its row while the registry lags behind a /clear. */
  mine?: string
  /**
   * This session's own process: what tells its row apart. Two processes can carry one session
   * id (the same conversation resumed in another folder), so a row is known by its pid.
   */
  minePid?: number
  /** This session's folder, the one the pane opens on. */
  folder?: string
  /** The person's home folder, which the pane writes as `~`. */
  homeDir?: string
  readAt?: number
  error?: string
}

/**
 * Which sessions the pane lists: the folder level (this session's folder, or the one picked
 * from the view above) or every session on the machine; `ending` a session whose end waits on a second press.
 */
export type Scope = { level: 'folder' | 'all'; folder?: string; ending?: number }

declare module 'claude-code' {
  interface PluginState {
    'session-dashboard': {
      peers: Peers
      scope: Scope
      activity: Record<string, Activity>
      meter: Meter
      tick: number
      calls: Record<string, WorkflowCall>
      workflows: Workflow[]
      tasks: Record<string, TaskItem>
      tabs: Tabs
      faults: Fault[]
      controls: Controls
    }
  }
}
