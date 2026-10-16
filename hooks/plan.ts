import type { WorkflowPlan } from '../types'

/** How deep a count follows names, helpers and their callers before it gives up. */
const MAX_DEPTH = 8
const OPENERS = '([{'
const CLOSERS = ')]}'
const NAME = /^[A-Za-z_$][\w$]*$/
const ITERATES = new Set(['map', 'flatMap', 'forEach', 'filter', 'reduce', 'reduceRight'])
const KEEPS_SIZE = new Set(['map', 'fill', 'reverse', 'sort', 'toSorted', 'toReversed'])

/** A count, or undefined where it hangs on what the run's agents return. */
type Count = number | undefined

type Helper = { name: string; at: number; from: number; to: number }

type Script = {
  code: string
  args: unknown
  bindings: Map<string, string | null>
  helpers: Helper[]
}

/**
 * How many agents a workflow script starts, read before it runs: each
 * `agent()` call counted as often as the lists, `args`, `Array.from` lengths
 * and loops around it repeat it. A repeat that hangs on what agents return
 * (their findings, a `while`) makes the count a floor, `isOpen`.
 */
export function planOf(script: string, args?: unknown): WorkflowPlan {
  const code = mask(script)
  const at = { code, args, bindings: bindingsOf(code), helpers: helpersOf(code) }
  let total = 0
  let isOpen = /(?<![\w$.])workflow\s*\(/.test(code)
  for (const site of code.matchAll(/(?<![\w$.])agent\s*\(/g)) {
    const times = repeats(at, site.index, 0)
    if (times === undefined) isOpen = true
    else total += times
  }
  return { total, isOpen }
}

/** How often the code at `p` runs: the repeats around it, times its helper's calls. */
function repeats(at: Script, p: number, depth: number): Count {
  if (depth > MAX_DEPTH) return undefined
  const helper = at.helpers
    .filter(one => one.from <= p && p < one.to)
    .sort((a, b) => b.from - a.from)[0]
  let times: Count = 1
  for (const open of enclosing(at.code, p)) {
    if (helper !== undefined && open < helper.from) break
    const factor = factorAt(at, open, p, depth)
    if (factor === 0) return 0
    times = factor === undefined || times === undefined ? undefined : times * factor
  }
  if (helper === undefined || times === 0) return times
  let calls: Count = 0
  for (const use of at.code.matchAll(new RegExp(`(?<![\\w$.])${escape(helper.name)}(?![\\w$])(?!\\s*:)`, 'g'))) {
    if (use.index === helper.at) continue
    const each = repeats(at, use.index, depth + 1)
    calls = each === undefined || calls === undefined ? undefined : calls + each
  }
  return times === undefined || calls === undefined ? (calls === 0 ? 0 : undefined) : times * calls
}

/** How often the bracket opened at `open` runs what `p` sits in. */
function factorAt(at: Script, open: number, p: number, depth: number): Count {
  const { code } = at
  const before = code.slice(0, open).trimEnd()
  if (code[open] === '(') {
    if (/(?<![\w$])while$/.test(before)) return undefined
    if (/\.\s*catch$/.test(before)) return 0
    const method = /\.\s*([A-Za-z_$][\w$]*)$/.exec(before)
    if (method !== null && ITERATES.has(method[1] ?? '')) {
      return sizeOf(at, receiverBefore(code, method.index), depth + 1)
    }
    if (method !== null && /^(some|every|find|findIndex|findLast)$/.test(method[1] ?? '')) return undefined
    const place = argIndex(code, open, p)
    if (/(?<![\w$.])pipeline$/.test(before) && place >= 1) {
      return sizeOf(at, argText(code, open, 0), depth + 1)
    }
    if (/(?<![\w$.])Array\s*\.\s*from$/.test(before) && place >= 1) {
      return lengthOf(at, argText(code, open, 0), depth + 1)
    }
    return 1
  }
  if (code[open] === '{') {
    if (/(?<![\w$])(do|catch)$/.test(before)) return /do$/.test(before) ? undefined : 0
    if (!before.endsWith(')')) return 1
    const head = matchOpen(code, before.length - 1)
    const word = code.slice(0, head).trimEnd()
    if (/(?<![\w$])catch$/.test(word)) return 0
    if (/(?<![\w$])while$/.test(word)) return undefined
    if (/(?<![\w$])for(\s+await)?$/.test(word)) return loopCount(at, code.slice(head + 1, before.length - 1), depth + 1)
  }
  return 1
}

/** How many times a `for` header runs its body. */
function loopCount(at: Script, header: string, depth: number): Count {
  const over = /^\s*(?:const|let|var)?\s*(?:[\w$]+|\[[^\]]*\]|\{[^}]*\})\s+of\s+([\s\S]+)$/.exec(header)
  if (over !== null) return sizeOf(at, over[1] ?? '', depth)
  const parts = splitTop(header, ';')
  if (parts.length !== 3) return undefined
  const [init = '', test = '', step = ''] = parts
  const start = /^\s*(?:let|var)?\s*([\w$]+)\s*=\s*([\s\S]+)$/.exec(init)
  const name = start?.[1]
  if (start === null || name === undefined) return undefined
  const from = numberOf(at, start[2] ?? '', depth)
  const bound = new RegExp(`^\\s*${escape(name)}\\s*(<=?)\\s*([\\s\\S]+)$`).exec(test)
  const to = bound === null ? undefined : numberOf(at, bound[2] ?? '', depth)
  const isStep = new RegExp(`^\\s*(?:${escape(name)}\\s*\\+\\+|\\+\\+\\s*${escape(name)}|${escape(name)}\\s*\\+=\\s*1)\\s*$`).test(step)
  if (from === undefined || to === undefined || !isStep || bound === null) return undefined
  return Math.max(0, to - from + (bound[1] === '<=' ? 1 : 0))
}

/** How many items a list expression holds. */
function sizeOf(at: Script, text: string, depth: number): Count {
  if (depth > MAX_DEPTH) return undefined
  const t = bare(text)
  if (t === '') return undefined
  if (t.startsWith('[') && matchClose(t, 0) === t.length - 1) {
    let sum: Count = 0
    const items = splitTop(t.slice(1, -1), ',')
    if (items.length > 0 && (items[items.length - 1] ?? '').trim() === '') items.pop()
    for (const item of items) {
      const spread = /^\s*\.\.\.([\s\S]+)$/.exec(item)
      const each = spread === null ? 1 : sizeOf(at, spread[1] ?? '', depth + 1)
      sum = each === undefined || sum === undefined ? undefined : sum + each
    }
    return sum
  }
  if (isPath(t)) {
    const value = valueAt(at, t, depth)
    return Array.isArray(value) ? value.length : typeof value === 'string' ? sizeOf(at, value, depth + 1) : undefined
  }
  if (!t.endsWith(')')) return undefined
  const open = matchOpen(t, t.length - 1)
  const callee = t.slice(0, open).trimEnd()
  const inner = t.slice(open + 1, -1)
  if (/^Array\s*\.\s*from$/.test(callee)) return lengthOf(at, splitTop(inner, ',')[0] ?? '', depth + 1)
  if (/^(new\s+)?Array$/.test(callee)) {
    const parts = splitTop(inner, ',')
    return parts.length === 1 ? numberOf(at, parts[0] ?? '', depth + 1) : parts.length
  }
  const keys = /^Object\s*\.\s*(keys|values|entries)$/.exec(callee)
  if (keys !== null) return keysOf(at, inner, depth + 1)
  // A run's results come back one per item, a failed one as null.
  if (/^(parallel|pipeline|Promise\s*\.\s*all(Settled)?)$/.test(callee)) {
    return sizeOf(at, splitTop(inner, ',')[0] ?? '', depth + 1)
  }
  const method = /\.\s*([A-Za-z_$][\w$]*)$/.exec(callee)
  if (method === null) return undefined
  const receiver = callee.slice(0, method.index)
  const name = method[1] ?? ''
  if (KEEPS_SIZE.has(name) || (name === 'filter' && inner.trim() === 'Boolean')) return sizeOf(at, receiver, depth + 1)
  if (name === 'concat') {
    let sum = sizeOf(at, receiver, depth + 1)
    for (const part of splitTop(inner, ',')) {
      const each = sizeOf(at, part, depth + 1)
      sum = each === undefined || sum === undefined ? undefined : sum + each
    }
    return sum
  }
  if (name === 'slice') {
    const size = sizeOf(at, receiver, depth + 1)
    const [a, b] = splitTop(inner, ',')
    const from = a === undefined || a.trim() === '' ? 0 : numberOf(at, a, depth + 1)
    const to = b === undefined ? size : numberOf(at, b, depth + 1)
    if (size === undefined || from === undefined || to === undefined) return undefined
    const clamp = (n: number) => (n < 0 ? Math.max(0, size + n) : Math.min(size, n))
    return Math.max(0, clamp(to) - clamp(from))
  }
  return undefined
}

/** `{ length: N }`, the first argument of `Array.from`, or a list's size. */
function lengthOf(at: Script, text: string, depth: number): Count {
  const t = bare(text)
  const length = /^\{\s*length\s*:\s*([\s\S]+?)\s*,?\s*\}$/.exec(t)
  return length === null ? sizeOf(at, t, depth) : numberOf(at, length[1] ?? '', depth)
}

function numberOf(at: Script, text: string, depth: number): Count {
  if (depth > MAX_DEPTH) return undefined
  const t = bare(text)
  if (/^\d+$/.test(t)) return Number(t)
  const pick = /^Math\s*\.\s*(min|max)\s*\(([\s\S]*)\)$/.exec(t)
  if (pick !== null) {
    const values = splitTop(pick[2] ?? '', ',').map(part => numberOf(at, part, depth + 1))
    if (values.length === 0 || values.some(v => v === undefined)) return undefined
    return pick[1] === 'min' ? Math.min(...(values as number[])) : Math.max(...(values as number[]))
  }
  const length = /^([\s\S]+?)\s*\.\s*length$/.exec(t)
  if (length !== null) return sizeOf(at, length[1] ?? '', depth + 1)
  if (!isPath(t)) return undefined
  const value = valueAt(at, t, depth)
  if (typeof value === 'number' && Number.isInteger(value)) return value
  return typeof value === 'string' ? numberOf(at, value, depth + 1) : undefined
}

function keysOf(at: Script, text: string, depth: number): Count {
  const value = isPath(bare(text)) ? valueAt(at, bare(text), depth) : bare(text)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return Object.keys(value).length
  if (Array.isArray(value)) return value.length
  if (typeof value !== 'string') return undefined
  const t = bare(value)
  if (!t.startsWith('{') || matchClose(t, 0) !== t.length - 1) return undefined
  const entries = splitTop(t.slice(1, -1), ',').filter(part => part.trim() !== '')
  return entries.some(part => part.trim().startsWith('...')) ? undefined : entries.length
}

/**
 * What a path like `args.files` or `DIMENSIONS` stands for: a value from the
 * call's `args`, or the source text a `const` binds, followed key by key.
 */
function valueAt(at: Script, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined
  const [root = '', ...keys] = path.replace(/\?/g, '').split(/\s*\.\s*|\s*\[\s*|\s*\]\s*/).filter(Boolean)
  let value: unknown = root === 'args' ? at.args : at.bindings.get(root)
  if (value === null) return undefined
  for (const [place, key] of keys.entries()) {
    if (typeof value === 'string') {
      const t = bare(value)
      if (isPath(t)) return valueAt(at, [t, ...keys.slice(place)].join('.'), depth + 1)
      value = propertyOf(at, t, key)
    } else if (typeof value === 'object' && value !== null) {
      value = (value as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return value
}

/** The source text of `key` in an object literal, or undefined. */
function propertyOf(at: Script, object: string, key: string): string | undefined {
  if (!object.startsWith('{') || matchClose(object, 0) !== object.length - 1) return undefined
  for (const part of splitTop(object.slice(1, -1), ',')) {
    const entry = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(part)
    if (entry?.[1] !== key) continue
    return entry[2] ?? (at.bindings.get(key) ?? undefined)
  }
  return undefined
}

/** Each `const` name and the source text it binds; a name bound twice is unknown (null). */
function bindingsOf(code: string): Map<string, string | null> {
  const bound = new Map<string, string | null>()
  const bind = (name: string, text: string) => bound.set(name, bound.has(name) ? null : text)
  for (const one of code.matchAll(/(?<![\w$.])const\s+([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    const from = one.index + one[0].length
    bind(one[1] ?? '', code.slice(from, expressionEnd(code, from)))
  }
  for (const one of code.matchAll(/(?<![\w$.])const\s*\{([^{}]*)\}\s*=(?![=>])/g)) {
    const from = one.index + one[0].length
    const source = bare(code.slice(from, expressionEnd(code, from)))
    if (!isPath(source)) continue
    for (const part of splitTop(one[1] ?? '', ',')) {
      const entry = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[\s\S]*)?$/.exec(part)
      if (entry?.[1] !== undefined) bind(entry[2] ?? entry[1], `${source}.${entry[1]}`)
    }
  }
  return bound
}

/** Every named function and arrow, with the span its body takes. */
function helpersOf(code: string): Helper[] {
  const helpers: Helper[] = []
  for (const one of code.matchAll(/(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = one.index + one[0].length - 1
    const body = code.indexOf('{', matchClose(code, params))
    if (body === -1) continue
    const name = one[1] ?? ''
    helpers.push({ name, at: one.index + one[0].indexOf(name, 8), from: body + 1, to: matchClose(code, body) })
  }
  for (const one of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?/g)) {
    let from = one.index + one[0].length
    if (code.startsWith('function', from)) {
      const params = code.indexOf('(', from)
      const body = params === -1 ? -1 : code.indexOf('{', matchClose(code, params))
      if (body === -1) continue
      from = body
    } else {
      const params = code[from] === '(' ? matchClose(code, from) + 1 : (/^[A-Za-z_$][\w$]*/.exec(code.slice(from))?.[0].length ?? -1) + from
      const arrow = /^\s*=>\s*/.exec(code.slice(params))
      if (params < from || arrow === null) continue
      from = params + arrow[0].length
    }
    const name = one[1] ?? ''
    const at = one.index + one[0].indexOf(name, 3)
    if (code[from] === '{') helpers.push({ name, at, from: from + 1, to: matchClose(code, from) })
    else helpers.push({ name, at, from, to: expressionEnd(code, from) })
  }
  return helpers
}

/** The open brackets around `p`, innermost first. */
function enclosing(code: string, p: number): number[] {
  const stack: number[] = []
  for (let i = 0; i < p; i += 1) {
    const char = code[i] ?? ''
    if (OPENERS.includes(char)) stack.push(i)
    else if (CLOSERS.includes(char)) stack.pop()
  }
  return stack.reverse()
}

/** Which argument of the call opened at `open` holds `p`, from 0. */
function argIndex(code: string, open: number, p: number): number {
  let place = 0
  for (let i = open + 1; i < p; i += 1) {
    const char = code[i] ?? ''
    if (OPENERS.includes(char)) {
      const close = matchClose(code, i)
      if (close >= p) break
      i = close
    } else if (char === ',') place += 1
  }
  return place
}

function argText(code: string, open: number, place: number): string {
  return splitTop(code.slice(open + 1, matchClose(code, open)), ',')[place] ?? ''
}

/** The member chain a `.method` hangs from, e.g. `Array.from({ length: 3 })`. */
function receiverBefore(code: string, dot: number): string {
  let i = dot - 1
  for (;;) {
    while (i >= 0 && /\s/.test(code[i] ?? '')) i -= 1
    const char = code[i] ?? ''
    if (char === ')' || char === ']') i = matchOpen(code, i) - 1
    else if (/[\w$]/.test(char)) {
      while (i >= 0 && /[\w$]/.test(code[i] ?? '')) i -= 1
    } else break
    let j = i
    while (j >= 0 && /\s/.test(code[j] ?? '')) j -= 1
    const link = code[j] ?? ''
    const next = code[i + 1] ?? ''
    if (link === '.' || ((link === ')' || link === ']' || /[\w$]/.test(link)) && /[([]/.test(next))) {
      i = link === '.' ? j - (code[j - 1] === '?' ? 2 : 1) : j
      continue
    }
    break
  }
  return code.slice(i + 1, dot)
}

/** Where the expression starting at `from` ends: a `;`, a `,` or a closing bracket at its level, or a line that does not go on. */
function expressionEnd(code: string, from: number): number {
  for (let i = from; i < code.length; i += 1) {
    const char = code[i] ?? ''
    if (OPENERS.includes(char)) i = matchClose(code, i)
    else if (CLOSERS.includes(char) || char === ';' || char === ',') return i
    else if (char === '\n') {
      const rest = code.slice(i).trimStart()
      if (!/^([.?:+\-*/%&|^<>]|=[=>])/.test(rest) && code.slice(from, i).trim() !== '') return i
    }
  }
  return code.length
}

function splitTop(text: string, by: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (OPENERS.includes(char)) depth += 1
    else if (CLOSERS.includes(char)) depth -= 1
    else if (char === by && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  const last = text.slice(start)
  if (parts.length > 0 || last.trim() !== '') parts.push(last)
  return parts
}

function matchClose(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (OPENERS.includes(char)) depth += 1
    else if (CLOSERS.includes(char)) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length
}

function matchOpen(text: string, close: number): number {
  let depth = 0
  for (let i = close; i >= 0; i -= 1) {
    const char = text[i] ?? ''
    if (CLOSERS.includes(char)) depth += 1
    else if (OPENERS.includes(char)) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return 0
}

/** An expression with `await`, a trailing `;` and wrapping parentheses left off. */
function bare(text: string): string {
  let t = text.trim().replace(/;$/, '').trim().replace(/^await\s+/, '')
  while (t.startsWith('(') && matchClose(t, 0) === t.length - 1) t = t.slice(1, -1).trim()
  return t
}

function isPath(text: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[\s*\d+\s*\])*$/.test(text) && NAME.test(text.split(/[.[?\s]/)[0] ?? '')
}

function escape(text: string): string {
  return text.replace(/[$]/g, '\\$')
}

/**
 * The script with every string, template and regex body and every comment
 * blanked (quotes and newlines kept), so brackets and names read as code.
 */
export function mask(src: string): string {
  const out = src.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' '
  }
  const quoted = (at: number): number => {
    const quote = src[at]
    for (let i = at + 1; i < src.length; i += 1) {
      if (src[i] === '\\') i += 1
      else if (src[i] === quote || (src[i] === '\n' && quote !== '`')) return i
    }
    return src.length
  }
  // A template's `${...}` holds code that may hold more templates.
  const template = (at: number): number => {
    for (let i = at + 1; i < src.length; i += 1) {
      if (src[i] === '\\') i += 1
      else if (src[i] === '`') return i
      else if (src[i] === '$' && src[i + 1] === '{') i = code(i + 2, true)
    }
    return src.length
  }
  const code = (from: number, isNested: boolean): number => {
    let depth = 0
    let last = ''
    for (let i = from; i < src.length; i += 1) {
      const char = src[i] ?? ''
      if (char === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i)
        blank(i, end === -1 ? src.length : end)
        i = end === -1 ? src.length : end - 1
        continue
      }
      if (char === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        blank(i, end === -1 ? src.length : end + 2)
        i = end === -1 ? src.length : end + 1
        continue
      }
      if (char === '"' || char === "'") {
        const end = quoted(i)
        blank(i + 1, end)
        i = end
        last = 'x'
        continue
      }
      if (char === '`') {
        const end = template(i)
        blank(i + 1, end)
        i = end
        last = 'x'
        continue
      }
      if (char === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /(?<![\w$])(return|typeof|case|do|else|in|of|yield|await)$/.test(src.slice(from, i).trimEnd()))) {
        let inClass = false
        let end = i + 1
        for (; end < src.length && src[end] !== '\n'; end += 1) {
          if (src[end] === '\\') end += 1
          else if (src[end] === '[') inClass = true
          else if (src[end] === ']') inClass = false
          else if (src[end] === '/' && !inClass) break
        }
        blank(i + 1, end)
        i = end
        last = 'x'
        continue
      }
      if (isNested && char === '{') depth += 1
      if (isNested && char === '}') {
        if (depth === 0) return i
        depth -= 1
      }
      if (!/\s/.test(char)) last = char
    }
    return src.length
  }
  code(0, false)
  return out.join('')
}
