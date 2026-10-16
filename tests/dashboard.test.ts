import type { AgentInfo, FsEntry } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  addUsage,
  cells,
  compact,
  describeCall,
  limitSegment,
  pace,
  recordLimit,
  ZERO_TOKENS,
} from '../hooks/format'
import type { Activity, Workflow } from '../types'
import { buildBoard, typeLabel } from '../hooks/board'
import { activityOf, brief, fit } from '../hooks/format'
import { planOf } from '../hooks/plan'
import { QUIET_MS, arrange, bindAgent, metaOf, readJournal, readNotice, standing, startTask, syncRun } from '../hooks/workflow'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-15T12:00:00Z')
const RESET = new Date(NOW + 2 * HOUR).toISOString()

const PANE = {
  component: 'Pane',
  requestId: 'session-dashboard',
  props: {
    title: 'Dashboard',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify', detail: "it's checked" }],
}
const DIMENSIONS = [{ key: 'bugs' }, { key: 'perf' }, { key: 'security' }]
const results = await pipeline(DIMENSIONS, d => agent(d.prompt, { label: d.key }))`

const lines = (...all: string[]) => all.join('\n')

describe('plan', () => {
  test('counts agents over literal lists, args, lengths and loops', async () => {
    const files = lines(
      "const FILES = ['a', 'b', 'c']",
      'await parallel(FILES.map(f => () => agent(`read ${f}`)))',
      "await agent('synthesize')",
    )
    expect(planOf(files)).toEqual({ total: 4, isOpen: false })
    expect(planOf('await pipeline(args.files, f => agent(f), r => agent(r))', { files: [1, 2, 3] })).toEqual({ total: 6, isOpen: false })
    expect(planOf("await parallel(Array.from({ length: 3 }, () => () => agent('refute')))")).toEqual({ total: 3, isOpen: false })
    expect(planOf(lines('for (let i = 0; i < 4; i++) {', "  await agent('step ' + i)", '}'))).toEqual({ total: 4, isOpen: false })
    const sliced = lines('const { files } = args', 'for (const f of files.slice(0, 2)) {', '  await agent(f)', '}')
    expect(planOf(sliced, { files: ['a', 'b', 'c'] })).toEqual({ total: 2, isOpen: false })
  })

  test("sizes a fan-out over an earlier stage's results", async () => {
    const panel = lines(
      "const ANGLES = ['mvp-first', 'risk-first', 'user-first']",
      'const drafts = await parallel(ANGLES.map(a => () => agent(a)))',
      'await parallel(drafts.filter(Boolean).map((d, i) => () =>',
      '  parallel(Array.from({ length: 3 }, () => () => agent(`judge ${i}`)))))',
      "return agent('synthesize')",
    )
    expect(planOf(panel)).toEqual({ total: 13, isOpen: false })
  })

  test('follows helpers to where they are called or handed on', async () => {
    const script = lines(
      "const DIMS = [{ key: 'bugs' }, { key: 'perf' }]",
      'async function review(d) {',
      "  return agent(d.key, { phase: 'Review' })",
      '}',
      "const check = d => agent('check ' + d.key)",
      'await parallel(DIMS.map(d => () => review(d)))',
      'await pipeline(DIMS, check)',
    )
    expect(planOf(script)).toEqual({ total: 4, isOpen: false })
  })

  test('gives a floor where the repeats hang on what agents return', async () => {
    expect(planOf(SCRIPT.replace('}))', '}), review => parallel(review.findings.map(f => () => agent(f.title))))'))).toEqual({ total: 3, isOpen: true })
    expect(planOf(lines('let dry = 0', 'while (dry < 2) {', "  await agent('find')", '}'))).toEqual({ total: 0, isOpen: true })
  })

  test('skips strings, comments, regexes and fallbacks', async () => {
    const script = lines(
      "// agent('commented')",
      'const note = "call agent(now)"',
      "const t = `${x ? `agent(` : ''}`",
      'const re = /agent\\(/',
      "try { await agent('main') } catch { await agent('fallback') }",
      "await agent('a').catch(() => agent('retry'))",
    )
    expect(planOf(script)).toEqual({ total: 2, isOpen: false })
  })
})

describe('workflow', () => {
  test("reads a script's meta literal", async () => {
    expect(metaOf(SCRIPT)).toEqual({
      name: 'review-changes',
      description: 'Review changed files, verify each finding',
      phases: ['Review', 'Verify'],
    })
    expect(metaOf('await agent("x")')).toBeUndefined()
  })

  test('reads which run a notification ends and how', async () => {
    const text = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>\n</task-notification>'
    expect(readNotice(text)).toEqual({ toolUseId: 'toolu_9', status: 'done' })
    expect(readNotice('<status>killed</status> run wf_ab12')).toEqual({ runId: 'wf_ab12', status: 'stopped' })
    expect(readNotice('<status>completed</status>')).toBeUndefined()
  })

  test("files a run's agents from its journal, and folds the hook's row into one", async () => {
    const journal = [
      '{"type":"launched"}',
      '{"type":"started","key":"v2:a","agentId":"ag1","label":"read:plan.ts","phase":"Read"}',
      '{"type":"started","key":"v2:b","agentId":"ag2","label":"read:view.tsx","phase":"Read"}',
      '{"type":"result","key":"v2:a","agentId":"ag1","result":"two sentences"}',
      '{"type":"result","key":"v2:b","agentId":"ag2","result":null}',
      '{"type":"started","key":"v2:c","agentI',
    ].join('\n')
    const entries = readJournal(journal)
    expect(entries.map(entry => entry.type)).toEqual(['launched', 'started', 'started', 'result', 'result'])
    const call = { name: 'dashboard-check', phases: ['Read', 'Summarize'], plan: { total: 4, isOpen: false } }
    const [flow] = syncRun([], { runId: 'wf_disk', entries, call, startedAt: NOW, at: NOW + 1000 })
    expect(flow).toMatchObject({ name: 'dashboard-check', plan: { total: 4 }, status: 'running' })
    expect(flow?.tasks.map(t => [t.label, t.phase, t.status])).toEqual([
      ['read:plan.ts', 'Read', 'done'],
      ['read:view.tsx', 'Read', 'failed'],
    ])

    // The hook filed index 3 before its agent id came; the journal filed it too.
    const hooked = startTask(syncRun([], { runId: 'wf_x', entries: readJournal('{"type":"started","agentId":"ag9","phase":"Verify"}'), startedAt: NOW, at: NOW }), {
      key: 'toolu_x',
      runId: 'wf_x',
      index: 3,
      label: 'verify:a',
      now: NOW,
    })
    const bound = bindAgent(hooked, 'wf_x', 'toolu_x', 3, 'ag9')
    expect(bound[0]?.tasks.map(t => [t.index, t.label, t.agentId, t.phase])).toEqual([[3, 'verify:a', 'ag9', 'Verify']])
  })

  test('settles a quiet run and lays out the newest open, the rest passing', async () => {
    const one = startTask([], { key: 'k1', runId: 'wf_1', index: 1, label: 'a', now: NOW })
    const first = one.map(flow => ({ ...flow, tasks: flow.tasks.map(t => ({ ...t, status: 'done' as const, endedAt: NOW })) }))
    const flow = first[0]
    if (flow === undefined) throw new Error('no run')
    expect(standing(flow, NOW + 1000)).toBe('running')
    expect(standing(flow, NOW + QUIET_MS)).toBe('done')

    const both = startTask(first, { key: 'k2', runId: 'wf_2', index: 1, label: 'b', now: NOW + QUIET_MS })
    const laid = arrange(both, NOW + QUIET_MS, 2)
    expect(laid.open.map(f => f.key)).toEqual(['k2'])
    expect(laid.passed.map(f => f.key)).toEqual(['k1'])
  })
})

describe('format', () => {
  test('names a call by its most telling argument', async () => {
    expect(describeCall('Bash', { command: 'npm test\necho more' })).toBe('Bash npm test')
    expect(describeCall('Edit', { file_path: '/repo/src/game.ts', old_string: 'a' })).toBe('Edit game.ts')
    expect(describeCall('Bash', { command: 'cd /Users/me/repo/ && cat ~/notes/todo.md "/tmp/a b" 2>/dev/null' })).toBe(
      'Bash cd repo && cat todo.md "a b" 2>/dev/null',
    )
    expect(describeCall('Bash', { command: 'ls $HOME/x ${ROOT}/y ./src/z' })).toBe('Bash ls $HOME/x ${ROOT}/y ./src/z')
    expect(describeCall('WebFetch', { url: 'https://example.com/a/b' })).toBe('WebFetch https://example.com/a/b')
    expect(describeCall('mcp__fcp__find', {})).toBe('fcp·find')
  })

  test('says what a call does in plain words, without tools or paths', async () => {
    expect(activityOf('Bash', { command: 'cd /a/b && npm test', description: 'Run the unit tests' })).toBe('Run the unit tests')
    expect(activityOf('Bash', { command: 'ls /Users/me' })).toBe('명령 실행 중')
    expect(activityOf('Edit', { file_path: '/repo/hooks/plan.ts' })).toBe('plan.ts 수정 중')
    expect(activityOf('Grep', { pattern: 'agent' })).toBe('코드 찾는 중')
    expect(activityOf('mcp__fcp__find', {})).toBe('fcp 작업 중')
    expect(fit('가나다라마', 6)).toBe('가나…')
    expect(fit('short', 6)).toBe('short')
  })

  test('briefs a request or instructions into one line, and names agent types in Korean', async () => {
    expect(brief('[Workflow harness] Read /Users/me/repo/hooks/plan.ts and describe it. Return only text.')).toBe(
      'Read plan.ts and describe it.',
    )
    expect(brief('\n  코드 구조를 탐색해 줘\n두 번째 줄')).toBe('코드 구조를 탐색해 줘')
    expect(brief('짧음. 다음')).toBe('짧음. 다음')
    expect(brief('Find the camera in src/game/view/Camera.ts and merge origin/main.')).toBe(
      'Find the camera in Camera.ts and merge origin/main.',
    )
    expect(brief('a'.repeat(300)).length).toBe(120)
    expect(typeLabel('Explore')).toBe('탐색 에이전트')
    expect(typeLabel('general-purpose')).toBe('범용 에이전트')
    expect(typeLabel('my-plugin:reviewer')).toBe('my-plugin:reviewer')
  })

  test('compacts token counts', async () => {
    expect(compact(950)).toBe('950')
    expect(compact(1234)).toBe('1.2k')
    expect(compact(230_000)).toBe('230k')
    expect(compact(1_250_000)).toBe('1.3M')
  })

  test('adds every input kind and the output of a request', async () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
    const tokens = addUsage(addUsage(ZERO_TOKENS, usage), usage)
    expect(tokens).toEqual({ input: 20, output: 10, cacheRead: 200, cacheWrite: 40, requests: 2 })
  })

  test('keeps a window history and drops samples from a window that reset', async () => {
    const reading = { kind: 'five_hour', percentUsed: 30, resetsAt: RESET }
    const first = recordLimit(undefined, reading, NOW - HOUR)
    const same = recordLimit(first, reading, NOW - HOUR / 2)
    const moved = recordLimit(same, { ...reading, percentUsed: 48 }, NOW)
    expect(same.samples.length).toBe(1)
    expect(moved.samples.map(s => s.percent)).toEqual([30, 48])

    const nextWindow = new Date(NOW + 5 * HOUR).toISOString()
    const reset = recordLimit(moved, { kind: 'five_hour', percentUsed: 2, resetsAt: nextWindow }, NOW + 3 * HOUR)
    expect(reset.samples.map(s => s.percent)).toEqual([2])
  })

  test('counts Hangul as two cells', async () => {
    expect(cells('5시간')).toBe(5)
    expect(cells('⟳2h00m')).toBe(6)
  })

  test('fits a window into the band with a gauge, its reset and no warning on pace', async () => {
    const steady = { kind: 'five_hour', percentUsed: 30, resetsAt: RESET, samples: [] }
    const segment = limitSegment(steady, NOW, 40)
    expect(segment).toMatchObject({ label: '5시간', percent: '30%', reset: '⟳2h00m', tone: 'success' })
    expect(segment.warn).toBeUndefined()
    expect((segment.bar?.filled.length ?? 0) + (segment.bar?.empty.length ?? 0)).toBe(23)
    expect(limitSegment(steady, NOW, 15).bar).toBeUndefined()
  })

  test('warns when the pace runs out of limit before the reset', async () => {
    const window = { kind: 'five_hour', percentUsed: 70, resetsAt: RESET, samples: [] }
    expect(limitSegment(window, NOW, 60)).toMatchObject({ tone: 'warning', warn: '⚠ 1h17m 후 소진' })
    expect(limitSegment({ ...window, percentUsed: 90 }, NOW, 60).tone).toBe('error')
  })

  test('projects the pace to the reset, or the time to the limit', async () => {
    const steady = { kind: 'five_hour', percentUsed: 30, resetsAt: RESET, samples: [] }
    expect(pace(steady, NOW)).toEqual({ elapsed: 60, projected: 50 })
    const hot = { ...steady, percentUsed: 90 }
    const going = pace(hot, NOW)
    expect(going?.projected).toBe(150)
    expect(Math.round((going?.hitsInMs ?? 0) / 60_000)).toBe(20)
  })
})

describe('board', () => {
  test('lists the main session, the team, subagents, workflows and lone agents with their counts', async () => {
    const agents: AgentInfo[] = [
      { id: 'a1', description: '코드 구조 탐색', type: 'Explore', status: 'running' },
      { id: 'a2', description: '문서 조사', type: 'general-purpose', status: 'completed' },
      { id: 'a3', description: '하위 검색', type: 'Explore', status: 'running', parentId: 'a1' },
      { id: 't1', description: '자료 조사', type: 'teammate', status: 'idle', name: 'researcher', teammateId: 'researcher@alpha' },
      { id: 't2', description: '정리', type: 'teammate', status: 'running', name: 'writer', teammateId: 'writer@alpha' },
    ]
    const one = (extra: Partial<Activity>): Activity => ({ running: [], tools: 0, tokens: ZERO_TOKENS, firstSeen: NOW, isBusy: false, ...extra })
    const activity: Record<string, Activity> = {
      main: one({
        isBusy: true,
        todos: [
          { content: '구조 파악', status: 'completed' },
          { content: '테스트', status: 'in_progress', activeForm: '테스트 실행 중' },
        ],
      }),
      a1: one({ isBusy: true, running: [{ id: 'c1', text: 'Grep agent', doing: '코드 찾는 중' }], firstSeen: NOW - 5000 }),
      a2: one({ firstSeen: NOW - 9000, stoppedAt: NOW - 1000 }),
      w9: one({ kind: 'workflow-subagent', isBusy: true, firstSeen: NOW - 2000 }),
    }
    const flow: Workflow = {
      key: 'wf_1',
      runId: 'wf_1',
      name: 'review-changes',
      phases: [],
      plan: { total: 3, isOpen: false },
      status: 'running',
      startedAt: NOW - 3000,
      tasks: [
        { index: 1, label: 'review:bugs', status: 'done', agentId: 'wa', startedAt: NOW - 3000, endedAt: NOW - 1000, tokens: ZERO_TOKENS },
        { index: 2, label: 'review:perf', status: 'running', agentId: 'wb', startedAt: NOW - 3000, tokens: ZERO_TOKENS },
      ],
    }
    const tasks = {
      '1': { id: '1', subject: 'S1', status: 'completed' as const, owner: 'researcher', at: NOW },
      '2': { id: '2', subject: 'S2', status: 'in_progress' as const, owner: 'writer', activeForm: '초안 쓰는 중', at: NOW },
    }
    const board = buildBoard({ now: NOW, agents, activity, flows: [flow], tasks, maxTasks: 6, maxFinished: 6 })

    expect(board.main).toMatchObject({ status: 'running', progress: { done: 1, total: 2 }, doing: '테스트 실행 중' })
    expect(board.running.map(item => item.key)).toEqual(['team', 'agent:a1', 'flow:wf_1', 'agent:w9'])
    const [team, explore, review, lone] = board.running
    expect(explore).toMatchObject({ title: '탐색 에이전트', sub: '코드 구조 탐색', doing: '코드 찾는 중', progress: { done: 0, total: 1 } })
    expect(explore?.children.map(child => child.key)).toEqual(['agent:a3'])
    expect(review).toMatchObject({ progress: { done: 1, total: 3 }, doing: '1개 실행 중 · 1개 대기' })
    expect(review?.children.map(child => [child.title, child.status])).toEqual([
      ['review:bugs', 'done'],
      ['review:perf', 'running'],
    ])
    expect(lone).toMatchObject({ title: '워크플로 에이전트', status: 'running' })
    expect(team).toMatchObject({ title: '에이전트 팀 alpha', status: 'running', progress: { done: 1, total: 2 }, doing: '1명 작업 중' })
    expect(team?.children.map(child => [child.title, child.status, child.doing])).toEqual([
      ['researcher', 'idle', '대기 중'],
      ['writer', 'running', '초안 쓰는 중'],
    ])
    expect(board.finished.map(item => [item.key, item.status, item.progress])).toEqual([['agent:a2', 'done', { done: 1, total: 1 }]])
  })
})

type TestOn = Parameters<TestBody>[1]
type Files = Record<string, { text: string; at: number }>

const SESSION_DIR = '/home/me/.claude/projects/-work-proj/sess-1'

/** The session the plugin reads: its id and folders, HOME, and a filesystem of `files`. */
function world(on: TestOn, files: Files = {}) {
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/work/proj' }))
  on('session.cwd', () => ({ value: '/work/proj' }))
  on('ui.log', () => ({ value: undefined }))
  const isDir = (path: string) => Object.keys(files).some(file => file.startsWith(`${path}/`))
  on('fs.exists', (_$, e) => ({ value: e.path in files || isDir(e.path) }))
  on('fs.list', (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT ${e.path}`)
    const found = new Map<string, FsEntry>()
    for (const [file, { text, at }] of Object.entries(files)) {
      if (!file.startsWith(`${e.path}/`)) continue
      const [name = '', ...rest] = file.slice(e.path.length + 1).split('/')
      found.set(name, rest.length > 0 ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : { name, kind: 'file', size: text.length, mtimeMs: at, isLink: false })
    }
    return { value: [...found.values()] }
  })
  on('fs.stat', (_$, e) => {
    const file = files[e.path]
    if (file !== undefined) return { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.at, isLink: false } }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.read', (_$, e) => {
    const file = files[e.path]
    if (file === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: file.text }
  })
}

test('the board shows every loop with its work, tokens and time; a press opens a tab that closes', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  world(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: '코드 구조 탐색', type: 'Explore', status: 'running' },
      { id: 'a2', description: '문서 조사', type: 'general-purpose', status: 'completed' },
    ],
  }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2000,
        output_tokens: 4100,
        cache_read_input_tokens: 220_000,
        cache_creation_input_tokens: 8000,
      },
    }
  })

  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const isRunning = new Promise<void>(resolve => {
    entered = resolve
  })
  on('tool.call', async () => {
    entered()
    await gate
    return { result: 'ok' }
  })

  await $.prompt.submit({
    text: '대시보드 세부 탭을 고쳐 줘. 그리고 한글로 바꿔 줘.\n자세한 내용',
    wait: false,
    origin: { kind: 'composer' },
  })
  await $.prompt.submit({
    text: '<task-notification>done</task-notification>',
    isMeta: true,
    wait: false,
    origin: { kind: 'task-notification' },
  })

  await $.session.measure({
    context: { window: 200_000, tokens: 76_000, percent: 38 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 48, resetsAt: RESET },
      { kind: 'seven_day', percentUsed: 21, resetsAt: new Date(NOW + 72 * HOUR).toISOString() },
    ],
    cost: { usd: 4.2 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'a1' })
  for await (const _chunk of stream) {
    // Drained only for its result.
  }
  await stream.result

  const call = $.tool.call({ tool: 'Bash', command: 'cd /Users/me/repo && npm test', description: 'Run the unit tests' })
  await isRunning

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'session-dashboard', surface, ...BAND })
    expect(await band.find({ text: '5시간' })).toBeDefined()
    expect(await band.find({ text: '48%' })).toBeDefined()
    expect(await band.find({ text: ' ⟳2h00m' })).toBeDefined()
    expect(await band.find({ text: '주간' })).toBeDefined()
    expect(await band.find({ text: '21%' })).toBeDefined()
    const tree = await band.drawn()
    expect('props' in tree ? tree.props : undefined).toMatchObject({ marginTop: 1 })
    await band.unmount()

    const ui = await $.ui.mount({ plugin: 'session-dashboard', surface, ...PANE })
    expect(await ui.find({ text: /5시간/ })).toBeUndefined()
    expect(await ui.find({ text: /대시보드 · 1개 실행 중/ })).toBeDefined()
    expect(await ui.find({ text: /Run the unit tests/ })).toBeDefined()
    expect(await ui.find({ text: /npm test|\/Users\/me/ })).toBeUndefined()
    expect(await ui.find({ text: /탐색 에이전트 · 코드/ })).toBeDefined()
    expect(await ui.find({ text: /↑230k ↓4.1k · 0s/ })).toBeDefined()
    expect(await ui.find({ text: ' (0/1)' })).toBeDefined()
    expect(await ui.find({ text: '☑' })).toBeDefined()
    expect(await ui.find({ text: /\$4\.20/ })).toBeDefined()
    expect(await ui.find({ text: /⚠/ })).toBeUndefined()
    await ui.unmount()
  }

  release()
  await call

  const ui = await $.ui.mount({ plugin: 'session-dashboard', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /Run the unit tests/ })).toBeUndefined()
  expect(await ui.find({ text: /메인 세션/ })).toBeDefined()
  expect(await ui.find({ text: /생각 중/ })).toBeDefined()

  await ui.press({ key: 'open:main' })
  expect(await ui.find({ text: '맡은 일 ' })).toBeDefined()
  expect(await ui.find({ text: '대시보드 세부 탭을 고쳐 줘.' })).toBeDefined()
  expect(await ui.find({ text: '생각 중' })).toBeDefined()
  expect(await ui.find({ text: /↳ Bash cd repo && npm test/ })).toBeDefined()
  expect(await ui.find({ text: /1회 호출/ })).toBeDefined()
  expect(await ui.find({ text: '× 닫기' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'open:agent:a1' })
  expect(await ui.find({ text: /새 입력 2k · 캐시 읽기 220k · 캐시 쓰기 8k · 요청 1회/ })).toBeDefined()
  expect(await ui.find({ text: '탐색 에이전트 (Explore)' })).toBeDefined()
  expect(await ui.find({ text: '코드 구조 탐색' })).toBeDefined()

  await ui.press({ key: 'close:agent:a1' })
  expect(await ui.find({ text: /대시보드 · 1개 실행 중/ })).toBeDefined()
  await ui.press({ key: 'tab:main' })
  expect(await ui.find({ text: /1회 호출/ })).toBeDefined()
  await ui.press({ key: 'close-top:main' })
  expect(await ui.find({ text: /대시보드/ })).toBeDefined()
  expect(await ui.find({ text: /1회 호출/ })).toBeUndefined()
  await ui.unmount()
})

test('a workflow shows each agent at work, ticks them off, then passes into the settled list', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  world(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-haiku-5-5', agentId: `${e.workflow?.runId ?? 'agent'}-${e.workflow?.agentIndex ?? 0}` }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))

  const spawn = (key: string, runId: string, agentIndex: number, description: string) =>
    $.agent.spawn({
      tool_use_id: key,
      prompt: `Review the changed files for ${description}. Report each finding with its file and line.`,
      description,
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
      workflow: { runId, agentIndex },
    })
  const complete = (agentId: string) =>
    $.turn.complete({
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: `t-${agentId}`,
      agentId,
      reason: 'answer',
      usage: { model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 11_000, cache_creation_input_tokens: 0 },
    })
  const pane = async (check: (ui: Awaited<ReturnType<typeof $.ui.mount<'terminal', 'Pane'>>>) => Promise<void>) => {
    const ui = await $.ui.mount({ plugin: 'session-dashboard', surface: 'terminal', ...PANE })
    await check(ui)
    await ui.unmount()
  }

  await $.tool.check({ tool: 'Workflow', input: { script: SCRIPT }, tool_use_id: 'toolu_wf1' })
  await spawn('toolu_wf1', 'wf_one', 1, 'review:bugs')
  await spawn('toolu_wf1', 'wf_one', 2, 'review:perf')
  await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/plan.ts', agentId: 'wf_one-2' } as unknown as Parameters<typeof $.tool.call>[0])
  await pane(async ui => {
    expect(await ui.find({ text: /대시보드 · 1개 실행 중/ })).toBeDefined()
    expect(await ui.find({ text: /^워크플로 · review-changes/ })).toBeDefined()
    expect(await ui.find({ text: ' (0/3)' })).toBeDefined()
    expect(await ui.find({ text: /2개 실행 중 · 1개 대기/ })).toBeDefined()
    expect(await ui.find({ text: /review:perf/ })).toBeDefined()
  })

  await complete('wf_one-1')
  await pane(async ui => {
    expect(await ui.find({ text: ' (1/3)' })).toBeDefined()
    expect(await ui.find({ text: / ↑12k ↓2k · 0s/ })).toBeDefined()
    await ui.press({ key: 'open:flow:toolu_wf1' })
    expect(await ui.find({ text: 'Review changed files, verify each finding' })).toBeDefined()
    expect(await ui.find({ text: 'review:perf 실행 중' })).toBeDefined()
    expect(await ui.find({ text: /단계/ })).toBeDefined()
    expect(await ui.find({ text: /Review › Verify/ })).toBeDefined()
    expect(await ui.find({ text: / 1\/3 33%/ })).toBeDefined()
    await ui.press({ key: 'open:task:toolu_wf1:2' })
    expect(await ui.find({ text: 'Review the changed files for review:perf.' })).toBeDefined()
    expect(await ui.find({ text: /워크플로 review-changes/ })).toBeDefined()
    expect(await ui.find({ text: /↳ Read plan\.ts/ })).toBeDefined()
    await ui.press({ key: 'close:task:toolu_wf1:2' })
    await ui.press({ key: 'close:flow:toolu_wf1' })
  })

  await complete('wf_one-2')
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      isMeta: true,
      content: [{ type: 'text', text: '<task-notification>\n<tool-use-id>toolu_wf1</tool-use-id>\n<status>completed</status>\n</task-notification>' }],
    },
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'row-1',
  })
  await pane(async ui => {
    expect(await ui.find({ text: /실행 중인 서브 작업 없음/ })).toBeDefined()
    expect(await ui.find({ text: ' (2/2)' })).toBeDefined()
    expect(await ui.find({ text: /review:bugs/ })).toBeUndefined()
  })

  await clock.advance(5000)
  await spawn('toolu_wf2', 'wf_two', 1, 'explore:api')
  await pane(async ui => {
    expect(await ui.find({ text: /대시보드 · 1개 실행 중/ })).toBeDefined()
    expect(await ui.find({ text: ' (0/1+)' })).toBeDefined()
    expect(await ui.find({ text: /explore:api/ })).toBeDefined()
    expect(await ui.find({ text: ' (2/2)' })).toBeDefined()
    expect(await ui.find({ text: /⚠/ })).toBeUndefined()
  })
})

test('a run no hook saw is read from its journal and saved script on disk', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const journal = [
    '{"type":"launched"}',
    '{"type":"started","key":"v2:a","agentId":"ag1","label":"read:plan.ts","phase":"Read"}',
    '{"type":"started","key":"v2:b","agentId":"ag2","label":"read:view.tsx","phase":"Read"}',
    '{"type":"result","key":"v2:a","agentId":"ag1","result":"done"}',
  ].join('\n')
  const script = `export const meta = { name: 'dashboard-check', description: 'x', phases: [{ title: 'Read' }, { title: 'Summarize' }] }
const FILES = ['a', 'b', 'c']
const notes = await parallel(FILES.map(f => () => agent(f, { label: 'read:' + f, phase: 'Read' })))
return agent('sum', { label: 'summary', phase: 'Summarize' })`
  world(on, {
    [`${SESSION_DIR}.jsonl`]: { text: '', at: NOW - 60_000 },
    [`${SESSION_DIR}/subagents/workflows/wf_disk/journal.jsonl`]: { text: journal, at: NOW - 1000 },
    [`${SESSION_DIR}/workflows/scripts/dashboard-check-wf_disk.js`]: { text: script, at: NOW - 30_000 },
  })
  on('agent.list', () => ({ value: [] }))
  on('classic.SubagentStart', () => ({}))
  on('tool.call', () => ({ result: 'ok' }))

  await $.classic.SubagentStart({ agent_id: 'ag2', agent_type: 'workflow-subagent' })
  await $.tool.call({ tool: 'WebSearch', query: 'agent', agentId: 'ag2' } as unknown as Parameters<typeof $.tool.call>[0])
  const ui = await $.ui.mount({ plugin: 'session-dashboard', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /^워크플로 · dashboard-check/ })).toBeDefined()
  expect(await ui.find({ text: ' (1/4)' })).toBeDefined()
  expect(await ui.find({ text: /read:view\.tsx · Read/ })).toBeDefined()
  expect(await ui.find({ text: /^워크플로 에이전트/ })).toBeUndefined()
  expect(await ui.find({ text: / 30s$/ })).toBeDefined()
  await ui.press({ key: 'open:flow:wf_disk' })
  expect(await ui.find({ text: 'Read 단계 · read:view.tsx 실행 중' })).toBeDefined()
  expect(await ui.find({ text: /Read 1\/2 › Summarize/ })).toBeDefined()
  expect(await ui.find({ text: /실행 ID wf_disk/ })).toBeDefined()
  await ui.unmount()
})
