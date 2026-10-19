import type { Peer } from '../types'
import { cells } from './format'

/** This session's own color: its row, its `[이 세션]` chip and the folder that holds it. */
export const MINE = '#5fd7ff'

/** A registry status in words and the color of its dot. */
export type PeerLook = { word: string; color: string }

const LOOKS: Record<string, PeerLook> = {
  busy: { word: '작업 중', color: 'success' },
  shell: { word: '명령 실행 중', color: 'success' },
  idle: { word: '대기 중', color: 'inactive' },
  waiting: { word: '응답 기다림', color: 'warning' },
}

/** The registry's words for a session that waits rather than works. */
const RESTING = new Set(['idle', 'waiting'])

/**
 * Whether a session is at work: the registry says `busy`, or another word for work such as
 * `shell` (a command it runs), and it waits on nobody. Only `idle` and waiting are rest.
 */
export function isWorking(peer: Pick<Peer, 'status' | 'waitingFor'>): boolean {
  return peer.status !== undefined && !RESTING.has(peer.status) && peer.waitingFor === undefined
}

/** One folder of the all-sessions view and the sessions running in it. */
export type Folder = { path: string; sessions: Peer[]; hasMine: boolean; busy: number; lastAt: number }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A folder as the registry and the session answer it, without a trailing separator. */
export function folderKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' ? path : trimmed
}

/**
 * One file of the engine's session registry (`<config>/sessions/<pid>.json`), which every
 * running Claude Code process on this machine keeps; undefined when it is not one.
 */
export function peerOf(source: string): Peer | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const pid = number(row['pid'])
  const sessionId = text(row['sessionId'])
  const cwd = text(row['cwd'])
  if (pid === undefined || sessionId === undefined || cwd === undefined) return undefined
  const peer: Peer = { pid, sessionId, cwd: folderKey(cwd) }
  const name = text(row['name'])
  const status = text(row['status'])
  const waitingFor = text(row['waitingFor'])
  const kind = text(row['kind'])
  const entrypoint = text(row['entrypoint'])
  const version = text(row['version'])
  const startedAt = number(row['startedAt'])
  const statusAt = number(row['statusUpdatedAt']) ?? number(row['updatedAt'])
  if (name !== undefined) peer.name = name
  if (status !== undefined) peer.status = status
  if (waitingFor !== undefined) peer.waitingFor = waitingFor
  if (kind !== undefined) peer.kind = kind
  if (entrypoint !== undefined) peer.entrypoint = entrypoint
  if (version !== undefined) peer.version = version
  if (startedAt !== undefined) peer.startedAt = startedAt
  if (statusAt !== undefined) peer.statusAt = statusAt
  return peer
}

/** The process ids `ps -o pid=,comm= -p ...` still lists: the registry's files outlive a crash. */
export function alivePids(listing: string): Set<number> {
  const alive = new Set<number>()
  for (const line of listing.split('\n')) {
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
    if (Number.isInteger(pid) && pid > 0) alive.add(pid)
  }
  return alive
}

export function lookOf(peer: Pick<Peer, 'status' | 'waitingFor'>): PeerLook {
  if (peer.waitingFor !== undefined) return LOOKS['waiting'] as PeerLook
  const known = peer.status === undefined ? undefined : LOOKS[peer.status]
  if (known !== undefined) return known
  if (peer.status === undefined) return { word: '상태 모름', color: 'inactive' }
  // A word for work this mod has no Korean for yet: still at work, the word kept.
  return { word: `작업 중 · ${peer.status}`, color: 'success' }
}

/** How a session is called on the board: the registry's name, else its folder's last part. */
export function peerName(peer: Pick<Peer, 'name' | 'cwd' | 'sessionId'>): string {
  return peer.name ?? `${baseName(peer.cwd)} · ${peer.sessionId.slice(0, 8)}`
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** A folder with the home folder as `~`. */
export function homeShort(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path
  const base = folderKey(home)
  return path === base ? '~' : path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}

/** A path cut to `width` cells from its start, keeping the end that names it. */
export function fitPath(path: string, width: number): string {
  if (cells(path) <= width) return path
  const chars = [...path]
  let out = ''
  for (let i = chars.length - 1; i >= 0; i--) {
    if (cells(`…${chars[i]}${out}`) > width) break
    out = `${chars[i]}${out}`
  }
  return `…${out}`
}

function lastOf(peer: Peer): number {
  return peer.statusAt ?? peer.startedAt ?? 0
}

/**
 * This session first, then the busy ones, then the latest to change, then by process id, so
 * that rows keep their order while nothing about them changes. `minePid` is this session's process.
 */
export function rank(list: readonly Peer[], minePid: number | undefined): Peer[] {
  const busy = (peer: Peer) => (isWorking(peer) ? 0 : 1)
  return [...list].sort(
    (a, b) =>
      Number(b.pid === minePid) - Number(a.pid === minePid) || busy(a) - busy(b) || lastOf(b) - lastOf(a) || a.pid - b.pid,
  )
}

/**
 * Which row is this session's: its own process when that is known and listed, else the one row
 * that carries its id in its folder, else the one row that carries its id. Never a guess between
 * two processes that share the id.
 */
export function ownRow(list: readonly Peer[], sessionId: string, cwd: string, pid: number | undefined): Peer | undefined {
  const byPid = pid === undefined ? undefined : list.find(peer => peer.pid === pid)
  if (byPid !== undefined) return byPid
  const here = list.filter(peer => peer.sessionId === sessionId && peer.cwd === cwd)
  if (here.length === 1) return here[0]
  const anywhere = list.filter(peer => peer.sessionId === sessionId)
  return anywhere.length === 1 ? anywhere[0] : undefined
}

/** The sessions by the folder they run in: this session's folder first, then the busiest and latest. */
export function foldersOf(list: readonly Peer[], minePid: number | undefined): Folder[] {
  const byPath = new Map<string, Peer[]>()
  for (const peer of list) byPath.set(peer.cwd, [...(byPath.get(peer.cwd) ?? []), peer])
  const folders = [...byPath].map(([path, sessions]): Folder => ({
    path,
    sessions: rank(sessions, minePid),
    hasMine: sessions.some(peer => peer.pid === minePid),
    busy: sessions.filter(isWorking).length,
    lastAt: Math.max(...sessions.map(lastOf)),
  }))
  return folders.sort(
    (a, b) => Number(b.hasMine) - Number(a.hasMine) || b.busy - a.busy || b.lastAt - a.lastAt || a.path.localeCompare(b.path),
  )
}

/**
 * The session a `/dash-send` names: its registry name, its process id, or its session id (whole
 * or its start); an id two processes share names neither.
 */
export function findPeer(list: readonly Peer[], name: string): Peer | undefined {
  const wanted = name.trim().toLowerCase()
  if (wanted === '') return undefined
  const only = (found: Peer[]) => (found.length === 1 ? found[0] : undefined)
  return (
    only(list.filter(peer => peer.name?.toLowerCase() === wanted)) ??
    (/^\d+$/.test(wanted) ? list.find(peer => peer.pid === Number(wanted)) : undefined) ??
    only(list.filter(peer => peer.sessionId.toLowerCase() === wanted)) ??
    (wanted.length >= 6 ? only(list.filter(peer => peer.sessionId.toLowerCase().startsWith(wanted))) : undefined)
  )
}

/** How `$.session.send` reaches a session: its registry name, which is its own, else its id. */
export function addressOf(peer: Peer): string | { sessionId: string } {
  return peer.name !== undefined && !/\s/.test(peer.name) ? peer.name : { sessionId: peer.sessionId }
}

/** `/dash-send <session> <message>`: the session named first, the message after it. */
export function sendArgs(args: string): { to: string; text: string } | undefined {
  const match = /^\s*(\S+)\s+([\s\S]*\S)\s*$/.exec(args)
  return match === null ? undefined : { to: match[1] as string, text: match[2] as string }
}

export const KINDS: Record<string, string> = { interactive: '대화형', bg: '백그라운드', background: '백그라운드', sdk: 'SDK' }
