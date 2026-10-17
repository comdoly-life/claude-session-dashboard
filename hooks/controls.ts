import type { Settings } from 'claude-code'

import type { Controls, EffortLevel, ModelFamily } from '../types'

/** The band's model buttons, each set by its family's alias, which names the latest model. */
export const MODELS: readonly { family: ModelFamily; label: string }[] = [
  { family: 'fable', label: '페이블' },
  { family: 'opus', label: '오푸스' },
  { family: 'sonnet', label: '소넷' },
  { family: 'haiku', label: '하이쿠' },
]

export const EFFORTS: readonly { level: EffortLevel; label: string }[] = [
  { level: 'low', label: 'low' },
  { level: 'medium', label: 'med' },
  { level: 'high', label: 'high' },
  { level: 'xhigh', label: 'xhigh' },
  { level: 'max', label: 'max' },
]

const LEVELS = new Set<string>(EFFORTS.map(one => one.level))

export const NO_CONTROLS: Controls = { ultracode: false }

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && LEVELS.has(value)
}

/** A level, or `auto`, out of a settings value or an environment variable. */
export function effortOf(value: unknown): EffortLevel | 'auto' | undefined {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : undefined
  return level === 'auto' || isEffortLevel(level) ? level : undefined
}

/** A model id or alias without its context suffix: `claude-opus-5-5[1m]` is `claude-opus-5-5`. */
function baseOf(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
}

/**
 * The effort settings keep for a model, the one a session on it starts with: its own
 * `modelSettings` entry (where `/effort` saves it, under the id or the family's alias),
 * else the top-level `effortLevel`; undefined when neither names one (the model's default).
 */
export function savedEffort(settings: Settings, model: string | undefined): EffortLevel | 'auto' | undefined {
  const table = settings['modelSettings']
  const entries = typeof table === 'object' && table !== null && !Array.isArray(table) ? Object.entries(table) : []
  const id = baseOf(model ?? '')
  const family = familyOf(model)
  let byFamily: EffortLevel | 'auto' | undefined
  for (const [key, entry] of entries) {
    const level = typeof entry === 'object' && entry !== null ? effortOf((entry as Record<string, unknown>)['effortLevel']) : undefined
    if (level === undefined) continue
    const name = baseOf(key)
    if (name === id) return level
    if (name === family) byFamily ??= level
  }
  return byFamily ?? effortOf(settings['effortLevel'])
}

/** The family a model id or alias belongs to: `claude-opus-5-5` and `opus[1m]` are `opus`. */
export function familyOf(model: string | undefined): ModelFamily | undefined {
  const name = (model ?? '').toLowerCase()
  return MODELS.find(one => name.includes(one.family))?.family
}

/** A model id's version as people write it: `claude-fable-5-1` is `5.1`, `claude-opus-5` is `5`. */
export function versionOf(model: string | undefined): string | undefined {
  const match = /claude-[a-z]+-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(model ?? '')
  if (match === null) return undefined
  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`
}

/** A model as the band and its toasts name it: `오푸스 5.5`, or the id itself when it is no family's. */
export function modelText(model: string | undefined): string {
  const family = familyOf(model)
  const label = MODELS.find(one => one.family === family)?.label
  if (label === undefined) return model ?? '?'
  const version = versionOf(model)
  return version === undefined ? label : `${label} ${version}`
}

/**
 * The effort a `/effort` answer left in force: `Set effort level to high`,
 * the capped `set to 'xhigh' instead`, or `set to auto`; undefined otherwise.
 */
export function effortIn(text: string | undefined): EffortLevel | 'auto' | undefined {
  const match = /(?:set|level) to '?(low|medium|high|xhigh|max|auto)\b/i.exec(text ?? '')
  const level = match?.[1]?.toLowerCase()
  return level === 'auto' || isEffortLevel(level) ? level : undefined
}

/** Whether a `/effort` answer turned ultracode on or off; undefined when it says neither. */
export function ultracodeIn(text: string | undefined): boolean | undefined {
  const match = /ultracode (on|off)\b/i.exec(text ?? '')
  return match === null ? undefined : match[1]?.toLowerCase() === 'on'
}

/** Whether a command's answer reads as a refusal rather than a change made. */
export function isRefusal(text: string | undefined): boolean {
  return /invalid|isn't available|not available|needs|cannot|can't|couldn't|blocked|denied/i.test(text ?? '')
}

/** What a `/model` or `/effort` run left in force, folded into the controls. */
export function afterCommand(controls: Controls, command: string, args: string, text: string | undefined): Controls {
  if (command !== 'effort') return controls
  const next = { ...controls }
  const asked = args.trim().toLowerCase()
  const effort = effortIn(text) ?? (text === undefined && (asked === 'auto' || isEffortLevel(asked)) ? asked : undefined)
  if (effort !== undefined) next.effort = effort
  const ultracode = ultracodeIn(text) ?? (text === undefined && /^ultracode (on|off)$/.test(asked) ? asked.endsWith('on') : undefined)
  if (ultracode !== undefined && !(ultracode && isRefusal(text))) next.ultracode = ultracode
  return next
}
