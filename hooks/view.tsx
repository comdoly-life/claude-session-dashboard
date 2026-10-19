import type { AgentInfo, EngineInterface, RenderChildren } from 'claude-code'

import type { Activity, Fault, Peer, Peers, Scope, Tabs, TaskItem, Tokens, Workflow } from '../types'
import type { Board, Count, Item, ItemStatus } from './board'
import { ALL, doingOf, isSettled, statusOf, taskCount, taskItem, todoCount, typeLabel } from './board'
import { CHIP } from './controls'
import { MAIN, ZERO_TOKENS, brief, cells, compact, duration, fit, gauge, inputTotal, tokenText } from './format'
import { KINDS, MINE, fitPath, foldersOf, homeShort, lookOf, peerName, rank } from './sessions'
import { finishedAt, progress, standing } from './workflow'

/** The surface's element table, as `$.ui.resolve(e)` hands it out. */
export type Kit = ReturnType<EngineInterface['ui']['resolve']>

/** What a drawing reads, and what its presses do. */
export type Scene = {
  kit: Kit
  now: number
  width: number
  board: Board
  tabs: Tabs
  agents: readonly AgentInfo[]
  activity: Readonly<Record<string, Activity>>
  flows: readonly Workflow[]
  tasks: Readonly<Record<string, TaskItem>>
  faults: readonly Fault[]
  totals: string
  /** Every Claude Code session on this machine, and which list of them the pane shows. */
  peers: Peers
  scope: Scope
  open: (key: string, title: string) => void
  close: (key: string) => void
  show: (key: string) => void
  /** Up to every session, or down to a folder's (this session's when none is named). */
  goAll: () => void
  goFolder: (path?: string) => void
  /** A press on a session: this one opens its own tab, another its session tab. */
  openPeer: (peer: Peer) => void
  message: (peer: Peer) => void
  end: (peer: Peer) => void
}

/** This session's folder and this session itself, as the lists tag them. */
const FOLDER_TAG = '[작업폴더]'
const MINE_TAG = '[작업 세션]'
/** The message chip on a session's row. */
const ROW_MESSAGE = '메시지'

const RECENT_ROWS = 6
const REPLY_ROWS = 4
const SUMMARY_LABEL = 8
const SUMMARY_NAMES = 2
const FAULT_MS = 10 * 60_000
const LABEL = 6
const TAB_TITLE = 14
const BAR = 10

const LOOK: Record<ItemStatus, { box: string; color: string }> = {
  running: { box: '☐', color: 'claude' },
  idle: { box: '☐', color: 'inactive' },
  done: { box: '☑', color: 'success' },
  failed: { box: '☒', color: 'error' },
}

const WORD: Record<ItemStatus, string> = { running: '실행 중', idle: '대기 중', done: '완료', failed: '실패·중단' }

/** A settled item's own color: green once done, red once failed; none while it runs. */
function inkOf(status: ItemStatus): { color?: string } {
  return status === 'done' ? { color: 'success' } : status === 'failed' ? { color: 'error' } : {}
}

export function countText(count: Count | undefined): string {
  return count === undefined ? '' : ` (${count.done}/${count.total}${count.isOpen === true ? '+' : ''})`
}

/** The tokens an item spent and how long it ran: what sits right of its title. */
export function costText(item: Pick<Item, 'tokens' | 'startedAt' | 'endedAt' | 'kind'>, now: number): string {
  const ran = item.kind === 'main' || item.startedAt === undefined ? '' : duration((item.endedAt ?? now) - item.startedAt)
  return [tokenText(item.tokens), ran].filter(Boolean).join(' · ')
}

/** The pane: the tab bar, then the board or the tab it shows. */
export function drawPane(scene: Scene) {
  const { Box } = scene.kit
  const shown = scene.tabs.open.find(tab => tab.key === scene.tabs.active)
  return (
    <Box flexDirection="column">
      {drawTabBar(scene)}
      {shown === undefined ? drawList(scene) : drawDetail(scene, shown.key)}
    </Box>
  )
}

/** Whether the list shows this session's folder, where its board is, rather than every session or another folder. */
function isHomeList(scene: Scene): boolean {
  return scene.scope.level === 'folder' && (scene.scope.folder === undefined || scene.scope.folder === scene.peers.folder)
}

/**
 * The tabs on top: every session and this session's own view, always there, then the detail tabs
 * opened from them. Another folder's sessions count as the every-session view they were reached from.
 */
function drawTabBar(scene: Scene) {
  const { Box, Text, Button } = scene.kit
  const isList = scene.tabs.active === ALL || !scene.tabs.open.some(tab => tab.key === scene.tabs.active)
  const isHome = isHomeList(scene)
  const top = (key: string, word: string, isActive: boolean, onPress: () => void) => (
    <Button key={key} label={word} {...(isActive && { variant: 'primary' as const })} onPress={onPress}>
      {word}
    </Button>
  )
  return (
    <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
      {top('top:all', '모든 세션', isList && !isHome, () => scene.goAll())}
      <Text> </Text>
      {top('top:mine', '현재 세션', isList && isHome, () => scene.goFolder())}
      {scene.tabs.open.length > 0 && <Text dimColor> │</Text>}
      {scene.tabs.open.map(tab => (
        <Box flexDirection="row">
          <Text> </Text>
          <Button
            key={`tab:${tab.key}`}
            label={fit(tab.title, TAB_TITLE)}
            {...(scene.tabs.active === tab.key && { variant: 'primary' as const })}
            onPress={() => scene.show(tab.key)}
          >
            {fit(tab.title, TAB_TITLE)}
          </Button>
          <Button key={`close:${tab.key}`} plain label="×" onPress={() => scene.close(tab.key)}>
            ×
          </Button>
        </Box>
      ))}
    </Box>
  )
}

/**
 * The list the pane opens on: the sessions of a folder (this session's by default) with this
 * session's own board under them, or one level up, every session on the machine by folder.
 */
function drawList(scene: Scene) {
  return scene.scope.level === 'all' ? drawAll(scene) : drawFolder(scene)
}

/** The sessions running in this machine's folders, this session's folder first. */
function drawAll(scene: Scene) {
  const { Box, Text, Button } = scene.kit
  const { list, minePid, homeDir } = scene.peers
  const folders = foldersOf(list, minePid)
  return (
    <Box flexDirection="column">
      <Text dimColor>{`폴더 ${folders.length}개 · 세션 ${list.length}개`}</Text>
      {folders.map(folder => {
        const count = ` · ${folder.sessions.length}개${folder.busy > 0 ? ` (${folder.busy}개 작업 중)` : ''}`
        const tag = folder.hasMine ? ` ${FOLDER_TAG}` : ''
        const room = Math.max(8, scene.width - 2 - cells(count) - cells(tag))
        return (
          <Box flexDirection="column" marginTop={1}>
            <Button key={`folder:${folder.path}`} plain label={folder.path} onPress={() => scene.goFolder(folder.path)}>
              <Text weight="bold" {...(folder.hasMine && { color: MINE })}>
                {`▸ ${fitPath(homeShort(folder.path, homeDir), room)}`}
              </Text>
              <Text dimColor>{count}</Text>
              {folder.hasMine && (
                <Text color={MINE} weight="bold">
                  {tag}
                </Text>
              )}
            </Button>
            {folder.sessions.map(peer => peerRow(scene, peer, 1))}
          </Box>
        )
      })}
      {folders.length === 0 && <Text dimColor>  실행 중인 세션을 찾지 못했습니다.</Text>}
      {scene.peers.error !== undefined && (
        <Text color="warning" wrap="truncate-end">
          {`⚠ 세션 목록: ${scene.peers.error}`}
        </Text>
      )}
    </Box>
  )
}

/**
 * A folder's sessions; in this session's folder, this session's board under them, and in another
 * folder a way back up to every session.
 */
function drawFolder(scene: Scene) {
  const { Box, Text, Button } = scene.kit
  const { list, minePid, homeDir } = scene.peers
  const folder = scene.scope.folder ?? scene.peers.folder
  const isHome = isHomeList(scene)
  const sessions = rank(
    list.filter(peer => peer.cwd === folder),
    minePid,
  )
  const count = ` · 세션 ${sessions.length}개`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {!isHome && (
          <Box flexShrink={0} marginRight={1}>
            <Button key="scope:all" plain label="← 모든 세션" onPress={() => scene.goAll()}>
              <Text backgroundColor={CHIP.idle} color="text">
                {' ← 모든 세션 '}
              </Text>
            </Button>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text weight="bold" {...(isHome && { color: MINE })}>
              {fitPath(homeShort(folder ?? '', homeDir), Math.max(8, scene.width - (isHome ? 0 : 16) - cells(count)))}
            </Text>
            <Text dimColor>{count}</Text>
          </Text>
        </Box>
      </Box>
      {sessions.map(peer => peerRow(scene, peer, 0))}
      {sessions.length === 0 && <Text dimColor>  이 폴더에서 실행 중인 세션이 없습니다.</Text>}
      {isHome && <Box marginTop={1}>{drawBoard(scene)}</Box>}
    </Box>
  )
}

/**
 * One session: its status dot and name (this one in its own color, tagged), how long it has stood
 * so, and for another session a message and an end right on its row (the end asks twice).
 */
function peerRow(scene: Scene, peer: Peer, depth: number): RenderChildren {
  const { Box, Text, Button } = scene.kit
  const isMine = peer.pid === scene.peers.minePid
  const look = lookOf(peer)
  const pad = '  '.repeat(depth)
  const since = peer.statusAt === undefined ? '' : ` · ${duration(scene.now - peer.statusAt)}`
  const right = ` ${look.word}${since}`
  const tag = isMine ? ` ${MINE_TAG}` : ''
  const name = peerName(peer)
  const isEnding = scene.scope.ending === peer.pid
  const endWord = isEnding ? ' 한 번 더 ' : ' 종료 '
  const actions = isMine ? 0 : cells(` ${ROW_MESSAGE} `) + cells(endWord) + 2
  const room = Math.max(6, scene.width - cells(pad) - 2 - cells(tag) - cells(right) - actions)
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1} flexDirection="row">
        {pad !== '' && <Text>{pad}</Text>}
        <Button key={`peer:${peer.pid}`} plain label={name} onPress={() => scene.openPeer(peer)}>
          <Text color={look.color}>●</Text>{' '}
          <Text {...(isMine && { color: MINE, weight: 'bold' as const })}>{fit(name, room)}</Text>
          {isMine && (
            <Text color={MINE} weight="bold">
              {tag}
            </Text>
          )}
        </Button>
      </Box>
      <Box flexShrink={0}>
        <Text {...(isMine ? { color: MINE } : { dimColor: true })}>{right}</Text>
      </Box>
      {!isMine && (
        <Box flexShrink={0} flexDirection="row" columnGap={1} marginLeft={1}>
          <Button key={`row-message:${peer.pid}`} plain label={`${peerName(peer)}에 메시지`} onPress={() => scene.message(peer)}>
            <Text backgroundColor={CHIP.idle} color="text">
              {` ${ROW_MESSAGE} `}
            </Text>
          </Button>
          <Button
            key={`row-end:${peer.pid}`}
            plain
            label={isEnding ? `${peerName(peer)} 한 번 더 누르면 종료` : `${peerName(peer)} 종료`}
            onPress={() => scene.end(peer)}
          >
            <Text
              {...(isEnding
                ? { backgroundColor: 'error', color: CHIP.ink, weight: 'bold' as const }
                : { backgroundColor: CHIP.idle, color: 'text' })}
            >
              {endWord}
            </Text>
          </Button>
        </Box>
      )}
    </Box>
  )
}

/** The board: every loop of the session on one row each, running ones first. */
function drawBoard(scene: Scene) {
  const { Box, Text } = scene.kit
  const { board } = scene
  const busy = board.running.filter(item => item.status === 'running').length
  const fault = scene.faults.at(-1)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" color="claude">
          이 세션의 작업{busy > 0 ? ` · ${busy}개 실행 중` : ''}
        </Text>
        <Text dimColor>↑입력 ↓출력 · 시간</Text>
      </Box>
      {itemRow(scene, board.main, 0)}
      {board.running.map(item => itemRow(scene, item, 0))}
      {board.running.length === 0 && <Text dimColor>  실행 중인 서브 작업 없음</Text>}
      {board.finished.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>완료</Text>
        </Box>
      )}
      {board.finished.map(item => itemRow(scene, item, 0))}
      {board.hidden > 0 && <Text dimColor>{`  +${board.hidden}개 더 완료`}</Text>}
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {scene.totals}
        </Text>
      </Box>
      {fault !== undefined && scene.now - fault.at < FAULT_MS && (
        <Text color="warning" wrap="truncate-end">
          {`⚠ ${fault.where}: ${fault.message}`}
        </Text>
      )}
    </Box>
  )
}

/**
 * One item: a checkbox that ticks once it is done, its title (a press opens
 * its tab), its progress, and on the right its tokens and time; under a
 * running one what it is doing, then its children.
 */
function itemRow(scene: Scene, item: Item, depth: number): RenderChildren {
  const { Box, Text, Button } = scene.kit
  const pad = '  '.repeat(depth)
  const look = LOOK[item.status]
  const ink = inkOf(item.status)
  const right = costText(item, scene.now)
  const count = countText(item.progress)
  const name = item.sub !== undefined && item.sub !== '' && item.sub !== item.title ? `${item.title} · ${item.sub}` : item.title
  const room = Math.max(6, scene.width - cells(pad) - 2 - cells(count) - (right === '' ? 0 : cells(right) + 1))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1} flexDirection="row">
          {pad !== '' && <Text>{pad}</Text>}
          <Button
            key={`open:${item.key}`}
            plain
            label={item.title}
            onPress={() => scene.open(item.key, item.tab ?? item.title)}
          >
            <Text color={look.color}>{look.box}</Text>{' '}
            <Text {...ink} {...(depth === 0 && { weight: 'bold' as const })}>
              {fit(name, room)}
            </Text>
            <Text {...ink} {...(isSettled(item.status) ? {} : { dimColor: true })}>
              {count}
            </Text>
          </Button>
        </Box>
        <Box flexShrink={0}>
          <Text {...ink} {...(isSettled(item.status) ? {} : { dimColor: true })}>
            {right === '' ? '' : ` ${right}`}
          </Text>
        </Box>
      </Box>
      {!isSettled(item.status) && item.doing !== undefined && item.doing !== '' && (
        <Text dimColor wrap="truncate-end">
          {`${pad}    ${item.doing}`}
        </Text>
      )}
      {item.children.map(child => itemRow(scene, child, depth + 1))}
      {(item.folded ?? 0) > 0 && <Text dimColor>{`${pad}    +${item.folded}개 완료`}</Text>}
    </Box>
  )
}

/** A detail tab: the item's header and close, then what is known of it. */
function drawDetail(scene: Scene, key: string) {
  const { Box, Text, Button } = scene.kit
  const body =
    key === 'team'
      ? teamDetail(scene)
      : key.startsWith('flow:')
        ? flowDetail(scene, key.slice(5))
        : key.startsWith('peer:')
          ? peerDetail(scene, Number(key.slice(5)))
          : agentDetail(scene, key)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Button key="back" plain label="← 목록" onPress={() => scene.show(ALL)}>
          <Text dimColor>← 목록</Text>
        </Button>
        <Button key={`close-top:${key}`} label="× 닫기" onPress={() => scene.close(key)}>
          × 닫기
        </Button>
      </Box>
      {body ?? <Text dimColor>이 항목은 더 이상 세션에 없습니다.</Text>}
    </Box>
  )
}

function header(scene: Scene, item: Pick<Item, 'title' | 'sub' | 'status' | 'progress' | 'tokens' | 'startedAt' | 'endedAt' | 'kind'>) {
  const { Box, Text } = scene.kit
  const look = LOOK[item.status]
  const right = costText(item, scene.now)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={look.color}>{look.box}</Text> <Text weight="bold" {...inkOf(item.status)}>{item.title}</Text>
            <Text dimColor>{countText(item.progress)}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{right === '' ? '' : ` ${right}`}</Text>
        </Box>
      </Box>
      {item.sub !== undefined && item.sub !== '' && (
        <Text dimColor wrap="wrap">
          {`  ${item.sub}`}
        </Text>
      )}
    </Box>
  )
}

/**
 * A tab's opening lines: what the item was asked to do and what it is doing
 * now, in a word or a sentence, before the figures below.
 */
function summary(scene: Scene, task: string | undefined, now: string) {
  const { Box, Text } = scene.kit
  const row = (label: string, value: string) => (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text weight="bold" color="claude">
          {label + ' '.repeat(Math.max(1, SUMMARY_LABEL - cells(label)))}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">{value}</Text>
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      {task !== undefined && task !== '' && row('맡은 일', task)}
      {row('지금', now)}
    </Box>
  )
}

/** What a settled agent ended with: done with its last words, or why it stopped. */
function endedText(status: ItemStatus, reply: string | undefined): string {
  if (status === 'failed') return '실패·중단'
  const last = reply === undefined ? '' : brief(reply, 90)
  return last === '' ? '끝남' : `끝남 · ${last}`
}

/** A few names, then how many more. */
function names(list: readonly string[]): string {
  const shown = list.slice(0, SUMMARY_NAMES).join(', ')
  return list.length > SUMMARY_NAMES ? `${shown} 외 ${list.length - SUMMARY_NAMES}개` : shown
}

function field(scene: Scene, label: string, value: RenderChildren) {
  const { Box, Text } = scene.kit
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text dimColor>{label + ' '.repeat(Math.max(1, LABEL + 1 - cells(label)))}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{value}</Text>
      </Box>
    </Box>
  )
}

function section(scene: Scene, title: string, rows: RenderChildren[]) {
  const { Box, Text } = scene.kit
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text weight="bold">{title}</Text>
      {rows}
    </Box>
  )
}

function tokenParts(tokens: Tokens): string {
  if (tokens.requests === 0) return '아직 없음'
  return [
    `↑${compact(inputTotal(tokens))} ↓${compact(tokens.output)}`,
    `새 입력 ${compact(tokens.input)}`,
    `캐시 읽기 ${compact(tokens.cacheRead)}`,
    `캐시 쓰기 ${compact(tokens.cacheWrite)}`,
    `요청 ${tokens.requests}회`,
  ].join(' · ')
}

function timeText(status: ItemStatus, startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return WORD[status]
  return `${WORD[status]} · ${duration((isSettled(status) ? (endedAt ?? now) : now) - startedAt)}`
}

function checkRow(scene: Scene, done: boolean, text: string, note?: string) {
  const { Text } = scene.kit
  return (
    <Text wrap="truncate-end">
      {'  '}
      <Text color={done ? 'success' : 'inactive'}>{done ? '☑' : '☐'}</Text>{' '}
      <Text {...(done ? { color: 'success' } : {})}>{text}</Text>
      {note !== undefined && note !== '' && <Text dimColor>{` · ${note}`}</Text>}
    </Text>
  )
}

/** The main session, a subagent, a teammate or a workflow agent. */
function agentDetail(scene: Scene, key: string): RenderChildren | undefined {
  const { Text } = scene.kit
  const { now } = scene
  let id: string | undefined
  let flow: Workflow | undefined
  let item: Item | undefined
  if (key === 'main') {
    id = MAIN
    item = scene.board.main
  } else if (key.startsWith('agent:')) {
    id = key.slice(6)
  } else if (key.startsWith('task:')) {
    const cut = key.lastIndexOf(':')
    const flowKey = key.slice(5, cut)
    const index = Number(key.slice(cut + 1))
    flow = scene.flows.find(one => one.key === flowKey)
    const task = flow?.tasks.find(t => t.index === index)
    if (flow === undefined || task === undefined) return undefined
    id = task.agentId
    item = taskItem(flow, task, scene.activity, (agentId, fallback = ZERO_TOKENS) => {
      const tokens = agentId === undefined ? undefined : scene.activity[agentId]?.tokens
      return tokens !== undefined && tokens.requests > 0 ? tokens : fallback
    })
  }
  const one = id === undefined ? undefined : scene.activity[id]
  const agent = id === undefined ? undefined : scene.agents.find(a => a.id === id)
  if (item === undefined) {
    if (agent === undefined && one === undefined) return undefined
    const status: ItemStatus = agent !== undefined ? statusOf(agent.status) : one?.stoppedAt !== undefined ? 'done' : 'running'
    item = {
      key,
      kind: 'agent',
      title: agent?.name ?? typeLabel(agent?.type ?? one?.kind ?? '에이전트'),
      status,
      tokens: one?.tokens ?? ZERO_TOKENS,
      children: [],
      ...(agent?.description !== undefined && { sub: agent.description }),
      ...(one !== undefined && { startedAt: one.firstSeen }),
      ...(isSettled(status) && (one?.stoppedAt ?? one?.endedAt) !== undefined && { endedAt: (one?.stoppedAt ?? one?.endedAt) as number }),
    }
    const count = todoCount(one?.todos)
    if (count !== undefined) item.progress = count
  }
  const owned = Object.values(scene.tasks).filter(t =>
    id === MAIN ? t.by === MAIN || t.owner === undefined : t.owner !== undefined && [agent?.name, agent?.teammateId?.split('@')[0]].includes(t.owner),
  )
  const parent = agent?.parentId === undefined ? undefined : scene.agents.find(a => a.id === agent.parentId)
  const rawKind = agent?.type ?? one?.kind ?? (flow !== undefined ? 'workflow-subagent' : undefined)
  const kind =
    rawKind === undefined
      ? key === 'main'
        ? '메인 루프'
        : undefined
      : typeLabel(rawKind) === rawKind
        ? rawKind
        : `${typeLabel(rawKind)} (${rawKind})`
  const doing = doingOf(one, owned.find(t => t.status === 'in_progress'))
  const task = one?.task ?? (flow !== undefined ? item.title : agent?.description)
  const current = isSettled(item.status)
    ? endedText(item.status, one?.reply)
    : (doing ?? (item.status === 'idle' ? '대기 중' : '생각 중'))
  const todos = one?.todos ?? []
  const recent = (one?.recent ?? []).slice(-RECENT_ROWS).reverse()
  const reply = (one?.reply ?? '').split('\n').filter(line => line.trim() !== '').slice(0, REPLY_ROWS)
  return [
    header(scene, item),
    summary(scene, task, current),
    field(scene, '상태', timeText(item.status, item.startedAt, item.endedAt, scene.now)),
    kind !== undefined && field(scene, '종류', kind),
    flow !== undefined && field(scene, '소속', `워크플로 ${flow.name}${item.sub !== undefined ? ` · ${item.sub} 단계` : ''}`),
    parent !== undefined && field(scene, '상위', parent.name ?? parent.type),
    field(scene, '토큰', tokenParts(item.tokens)),
    one !== undefined && field(scene, '도구', `${one.tools}회 호출`),
    (one?.running.length ?? 0) > 0 &&
      section(
        scene,
        '실행 중인 호출',
        (one?.running ?? []).map(call => <Text wrap="truncate-end">{`  ⚙ ${call.text}`}</Text>),
      ),
    todos.length > 0 &&
      section(scene, `할 일${countText(todoCount(todos))}`, todos.map(t => checkRow(scene, t.status === 'completed', t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content))),
    todos.length === 0 &&
      owned.length > 0 &&
      section(scene, `작업 목록${countText(taskCount(owned))}`, owned.map(t => checkRow(scene, t.status === 'completed', t.subject, t.owner))),
    recent.length > 0 && section(scene, '최근 호출', recent.map(text => <Text dimColor wrap="truncate-end">{`  ↳ ${text}`}</Text>)),
    reply.length > 0 && section(scene, '마지막 응답', reply.map(line => <Text wrap="truncate-end">{`  ${line}`}</Text>)),
    id !== undefined && id !== MAIN && <Text dimColor>{`ID ${id}`}</Text>,
  ]
}

/** A workflow run: its plan and phases, then every agent it started. */
function flowDetail(scene: Scene, flowKey: string): RenderChildren | undefined {
  const { Box, Text, Button } = scene.kit
  const { now } = scene
  const flow = scene.flows.find(one => one.key === flowKey)
  if (flow === undefined) return undefined
  const status = standing(flow, now)
  const count = progress(flow, status)
  const itemStatus: ItemStatus = status === 'running' ? 'running' : status === 'done' ? 'done' : 'failed'
  const live = (agentId: string | undefined, fallback: Tokens = ZERO_TOKENS) => {
    const tokens = agentId === undefined ? undefined : scene.activity[agentId]?.tokens
    return tokens !== undefined && tokens.requests > 0 ? tokens : fallback
  }
  const tasks = flow.tasks.map(task => taskItem(flow, task, scene.activity, live))
  const end = status === 'running' ? undefined : finishedAt(flow)
  const tokens: Tokens = tasks.reduce(
    (sum, t) => ({
      input: sum.input + t.tokens.input,
      output: sum.output + t.tokens.output,
      cacheRead: sum.cacheRead + t.tokens.cacheRead,
      cacheWrite: sum.cacheWrite + t.tokens.cacheWrite,
      requests: sum.requests + t.tokens.requests,
    }),
    ZERO_TOKENS,
  )
  const item: Item = {
    key: `flow:${flow.key}`,
    kind: 'flow',
    title: `워크플로 · ${flow.name}`,
    status: itemStatus,
    progress: { done: count.done, total: count.total, isOpen: count.isOpen },
    tokens,
    startedAt: flow.startedAt,
    children: [],
    ...(end !== undefined && { endedAt: end }),
  }
  // 지금: 실행 중인 에이전트들이 가장 많이 속한 단계와 그 이름들
  const running = flow.tasks.filter(t => t.status === 'running')
  const tally = new Map<string, number>()
  for (const t of running) {
    if (t.phase !== undefined) tally.set(t.phase, (tally.get(t.phase) ?? 0) + 1)
  }
  let phaseNow: string | undefined
  for (const [phase, n] of tally) {
    if (phaseNow === undefined || n > (tally.get(phaseNow) ?? 0)) phaseNow = phase
  }
  const current =
    status === 'running'
      ? running.length > 0
        ? `${phaseNow === undefined ? '' : `${phaseNow} 단계 · `}${names(running.map(t => t.label))} 실행 중`
        : count.waiting > 0
          ? '다음 에이전트를 기다리는 중'
          : '마무리 중'
      : status === 'done'
        ? `끝남 · 에이전트 ${count.done}개 완료`
        : `실패·중단 · ${count.done}/${count.total} 완료`
  const bar = gauge(count.percent, BAR)
  const phases = phaseCounts(flow)
  const stats = [
    count.running > 0 ? `${count.running}개 실행 중` : '',
    count.waiting > 0 ? `${count.waiting}개 대기` : '',
    count.failed > 0 ? `${count.failed}개 실패` : '',
    count.cached > 0 ? `${count.cached}개 재사용` : '',
  ].filter(Boolean)
  return [
    header(scene, item),
    summary(scene, flow.description ?? flow.name, current),
    field(scene, '상태', timeText(itemStatus, flow.startedAt, end, now)),
    field(
      scene,
      '진행',
      <Text>
        <Text color="claude">{bar.filled}</Text>
        <Text dimColor>{bar.empty}</Text>
        {` ${count.done}/${count.total}${count.isOpen ? '+' : ''}${count.isOpen ? '' : ` ${count.percent}%`}`}
        {stats.length > 0 && <Text dimColor>{` · ${stats.join(' · ')}`}</Text>}
      </Text>,
    ),
    phases.length > 0 && field(scene, '단계', phases.join(' › ')),
    flow.plan !== undefined &&
      field(scene, '계획', `${flow.plan.total}개${flow.plan.isOpen ? '+ (에이전트 결과에 따라 늘어남)' : ''}`),
    field(scene, '토큰', tokenParts(tokens)),
    section(
      scene,
      `에이전트${countText(item.progress)}`,
      tasks.map(task => (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1} flexDirection="row">
            <Text>  </Text>
            <Button
              key={`open:${task.key}`}
              plain
              label={task.title}
              onPress={() => scene.open(task.key, task.title)}
            >
              <Text color={LOOK[task.status].color}>{LOOK[task.status].box}</Text>{' '}
              <Text {...inkOf(task.status)}>{fit(task.title, Math.max(6, scene.width - 30))}</Text>
              {task.sub !== undefined && <Text dimColor>{` ${task.sub}`}</Text>}
            </Button>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{` ${costText(task, now)}`}</Text>
          </Box>
        </Box>
      )),
    ),
    flow.runId !== undefined && <Text dimColor>{`실행 ID ${flow.runId}`}</Text>,
  ]
}

/** The phases of a run with how many of each one's agents are done. */
function phaseCounts(flow: Workflow): string[] {
  const named = [...flow.phases, ...flow.tasks.map(t => t.phase ?? '')].filter((p, i, all) => p !== '' && all.indexOf(p) === i)
  return named.map(phase => {
    const tasks = flow.tasks.filter(t => t.phase === phase)
    if (tasks.length === 0) return phase
    const done = tasks.filter(t => t.status === 'done').length
    return `${phase} ${done}/${tasks.length}${done === tasks.length ? ' ✓' : ''}`
  })
}

/** The agent team: its members, then the team's task list. */
function teamDetail(scene: Scene): RenderChildren | undefined {
  const { Text } = scene.kit
  const team = [...scene.board.running, ...scene.board.finished].find(item => item.key === 'team')
  if (team === undefined) return undefined
  const tasks = Object.values(scene.tasks)
  const active = tasks.filter(t => t.status === 'in_progress').map(t => t.activeForm ?? t.subject)
  const count = taskCount(tasks)
  const task =
    active.length > 0
      ? names(active)
      : count !== undefined
        ? `작업 목록 ${count.done}/${count.total} 완료`
        : `팀원 ${team.children.length}명`
  const busy = team.children.filter(member => member.status === 'running')
  const current = isSettled(team.status)
    ? endedText(team.status, undefined)
    : busy.length > 0
      ? names(busy.map(member => `${member.title}: ${member.doing ?? '생각 중'}`))
      : '모두 대기 중'
  return [
    header(scene, team),
    summary(scene, task, current),
    field(scene, '상태', timeText(team.status, team.startedAt, team.endedAt, scene.now)),
    field(scene, '토큰', tokenParts(team.tokens)),
    section(scene, `구성원 ${team.children.length}명`, team.children.map(member => itemRow(scene, member, 1))),
    tasks.length > 0 &&
      section(
        scene,
        `작업 목록${countText(taskCount(tasks))}`,
        tasks.map(t => checkRow(scene, t.status === 'completed', t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject, t.owner)),
      ),
    tasks.length === 0 && <Text dimColor>  아직 작업 목록이 없습니다.</Text>,
  ]
}

/** Another session: where it runs and how it stands, a message to it, or its end. */
function peerDetail(scene: Scene, pid: number): RenderChildren | undefined {
  const { Box, Text, Button } = scene.kit
  const { now } = scene
  const peer = scene.peers.list.find(one => one.pid === pid)
  if (peer === undefined) {
    const known = scene.tabs.open.find(tab => tab.key === `peer:${pid}`)
    return [
      <Text dimColor wrap="wrap">
        {`  ${known?.title ?? '이'} 세션은 더 이상 실행 중이 아닙니다.`}
      </Text>,
    ]
  }
  const look = lookOf(peer)
  const since = peer.statusAt === undefined ? '' : ` · ${duration(now - peer.statusAt)}째`
  const kind = [peer.kind === undefined ? undefined : (KINDS[peer.kind] ?? peer.kind), peer.entrypoint, peer.version === undefined ? undefined : `v${peer.version}`]
    .filter(Boolean)
    .join(' · ')
  const isEnding = scene.scope.ending === peer.pid
  return [
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={look.color}>●</Text> <Text weight="bold">{peerName(peer)}</Text>
      </Text>
    </Box>,
    <Box flexDirection="column" marginTop={1}>
      {field(scene, '상태', `${look.word}${peer.waitingFor === undefined ? '' : ` (${peer.waitingFor})`}${since}`)}
      {field(scene, '폴더', homeShort(peer.cwd, scene.peers.homeDir))}
      {peer.startedAt !== undefined && field(scene, '시작', `${duration(now - peer.startedAt)} 전`)}
      {kind !== '' && field(scene, '종류', kind)}
      {field(scene, 'PID', String(peer.pid))}
      {field(scene, 'ID', peer.sessionId)}
    </Box>,
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
      <Button key={`message:${peer.pid}`} plain label="메시지 보내기" onPress={() => scene.message(peer)}>
        <Text backgroundColor={CHIP.idle} color="text">
          {' 메시지 보내기 '}
        </Text>
      </Button>
      <Button key={`end:${peer.pid}`} plain label={isEnding ? '한 번 더 누르면 종료' : '세션 종료'} onPress={() => scene.end(peer)}>
        <Text
          {...(isEnding ? { backgroundColor: 'error', color: CHIP.ink, weight: 'bold' as const } : { backgroundColor: CHIP.idle, color: 'text' })}
        >
          {isEnding ? ' 한 번 더 누르면 종료 ' : ' 세션 종료 '}
        </Text>
      </Button>
    </Box>,
    <Text dimColor wrap="wrap">
      {'메시지는 그 세션이 다음 차례에 읽습니다. 종료한 세션은 그 폴더에서 claude --resume 으로 다시 엽니다.'}
    </Text>,
  ]
}
