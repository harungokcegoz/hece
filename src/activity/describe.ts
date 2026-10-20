import path from 'node:path'
import { HeceEvent } from '../state/store.js'
import { FlowState } from '../flow/types.js'

export type LineKind = 'note' | 'action' | 'alert' | 'milestone'

export interface ActivityLine {
  kind: LineKind
  text: string
  slice: number | null
}

export interface DescribeContext {
  root: string
  flow: FlowState
}

// housekeeping the user doesn't need to see
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'Skill', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode',
  'BashOutput', 'KillShell', 'KillBash', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
])

export function relPath(root: string, p: string): string {
  if (!p) return 'a file'
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p)
  const rel = path.relative(root, abs)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(p)
}

// Split a shell line into segments on && || ; | and newlines, ignoring separators inside quotes.
function splitSegments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else if (c === quote) quote = ''
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i]
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
    } else if (c === ';' || c === '|' || c === '\n') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function tokenize(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < segment.length) {
      cur += segment[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

const WRAPPERS = new Set(['sudo', 'env', 'npx', 'time', 'command'])
const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'tsx'])
const SHELLS = new Set(['sh', 'bash', 'zsh'])
const INLINE_FLAGS = new Set(['-e', '-c', '-p', '-pe', '--eval', '--print'])
// interpreter flags whose next argument is a value, not the script
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--env-file', '-m'])

const nonFlags = (args: string[]): string[] => args.filter((a) => !a.startsWith('-'))

function describeGit(args: string[]): string {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  switch (sub) {
    case 'push':
      return rest.some((a) => a.startsWith('--force') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+\S/.test(a))
        ? 'force-pushing to a remote'
        : 'pushing to a remote'
    case 'reset':
      return rest.includes('--hard') ? 'discarding local changes' : 'using git'
    case 'clean':
      return 'removing untracked files'
    case 'commit':
      return 'committing the changes'
    case 'status':
    case 'diff':
    case 'log':
    case 'show':
      return 'checking what changed in git'
    default:
      return 'using git'
  }
}

function describePackageManager(args: string[]): string {
  const [sub, ...rest] = nonFlags(args)
  switch (sub) {
    case 'i':
    case 'install':
    case 'add':
    case 'ci':
      return 'installing packages'
    case 'test':
      return 'running the tests'
    case 'publish':
      return 'publishing a package'
    case 'run': {
      const name = rest[0]
      if (!name) return 'running a command'
      if (name === 'test') return 'running the tests'
      if (name === 'lint' || name === 'typecheck' || name === 'format') return 'checking code style and types'
      if (name === 'build') return 'building the project'
      return `running the ${name} script`
    }
    default:
      return 'running a command'
  }
}

function describeInterpreter(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (INLINE_FLAGS.has(a)) return 'running inline code'
    if (a === '-m' && /^(pytest|unittest)$/.test(args[i + 1] ?? '')) return 'running the tests'
    if (VALUE_FLAGS.has(a)) {
      i++
      continue
    }
    if (!a.startsWith('-')) return `running ${path.basename(a)}`
  }
  return 'running a command'
}

function describeSegment(segment: string): string | null {
  const tokens = tokenize(segment)
  // drop leading VAR=value and wrapper programs (with their own flags)
  while (tokens.length) {
    if (/^\w+=/.test(tokens[0])) tokens.shift()
    else if (WRAPPERS.has(tokens[0])) {
      tokens.shift()
      while (tokens.length && tokens[0].startsWith('-')) tokens.shift()
    } else break
  }
  if (!tokens.length || /^(cd|export|set)$/.test(tokens[0])) return null
  const prog = path.basename(tokens[0])
  const args = tokens.slice(1)
  const [sub] = nonFlags(args)

  if (SHELLS.has(prog)) return 'running a shell script'
  if (prog === 'git') return describeGit(args)
  const BUN_PM_SUBS = ['i', 'install', 'add', 'ci', 'test', 'run', 'publish']
  if (PKG_MANAGERS.has(prog) && (prog !== 'bun' || (sub !== undefined && BUN_PM_SUBS.includes(sub)))) {
    return describePackageManager(args)
  }
  if (prog === 'deno' && sub === 'run') return describePackageManager(args)
  if (/^pip3?$/.test(prog) && sub === 'install') return 'installing packages'
  if (prog === 'cargo' && sub === 'add') return 'installing packages'
  if (prog === 'brew' && sub === 'install') return 'installing packages'
  if (/^(vitest|jest|mocha|pytest)$/.test(prog)) return 'running the tests'
  if ((prog === 'go' || prog === 'cargo') && sub === 'test') return 'running the tests'
  if (/^(eslint|prettier)$/.test(prog)) return 'checking code style and types'
  if (prog === 'tsc' || ((prog === 'cargo' || prog === 'go') && sub === 'build')) return 'building the project'
  if (prog === 'make') return !sub || sub === 'build' || sub === 'all' ? 'building the project' : 'running a make task'
  if (prog === 'find') {
    const del = args.includes('-delete') || args.some((a, i) => /^-exec(dir)?$/.test(a) && path.basename(args[i + 1] ?? '') === 'rm')
    return del ? 'deleting files' : 'looking around the files'
  }
  if (/^(ls|tree|cat|head|tail|wc|grep|rg|pwd)$/.test(prog)) return 'looking around the files'
  if (/^(mkdir|touch|cp|mv)$/.test(prog)) return 'arranging files'
  if (prog === 'rm') return 'deleting files'
  if (/^(curl|wget)$/.test(prog)) return 'calling a URL'
  if (INTERPRETERS.has(prog)) return describeInterpreter(args)
  return 'running a command'
}

// Describes every program in the line, in order, by program position only. Never echoes command text.
export function describeCommand(command: string): string {
  const parts: string[] = []
  for (const seg of splitSegments(command)) {
    const d = describeSegment(seg)
    if (d && !parts.includes(d)) parts.push(d)
  }
  if (!parts.length) return 'running a command'
  const text = parts.slice(0, 3).join(', then ')
  return parts.length > 3 ? `${text}, …` : text
}

function isInside(root: string, p: string): boolean {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p)
  const rel = path.relative(root, abs)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// like relPath, but says so when the file is outside the project
function fileLabel(root: string, p: string): string {
  if (!p) return 'a file'
  return isInside(root, p) ? relPath(root, p) : `${path.basename(p)} (outside the project)`
}

// a long or key-looking pattern could be a secret; don't echo it
const safePattern = (t: string): boolean => t.length <= 40 && !/[A-Za-z0-9_-]{24,}/.test(t)

export function describeTool(tool: string, target: string, root: string): string | null {
  if (HIDDEN_TOOLS.has(tool)) return null
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    if (/(^|_)hece$/.test(server)) return null
    return `using ${server.replace(/^plugin_[^_]+_/, '')}: ${name.replace(/_/g, ' ')}`
  }
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
      return `changing ${fileLabel(root, target)}`
    case 'Write':
      return `writing ${fileLabel(root, target)}`
    case 'NotebookEdit':
      return `changing notebook ${fileLabel(root, target)}`
    case 'Read':
      return `reading ${fileLabel(root, target)}`
    case 'Grep':
      return target && safePattern(target) ? `searching the code for "${target}"` : 'searching the code'
    case 'Glob':
      return target ? `looking for files matching ${target}` : 'looking for files'
    case 'Bash':
      return describeCommand(target)
    case 'Task':
    case 'Agent':
      return 'handing work to a helper agent'
    case 'WebFetch':
    case 'WebSearch':
      return 'looking something up on the web'
    case 'AskUserQuestion':
      return 'asking you a question'
    default:
      return `using ${tool}`
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const sliceTitle = (flow: FlowState, n: number | null): string =>
  n === null ? '' : (flow.plan?.slices.find((s) => s.n === n)?.title ?? '')

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const withReason = (head: string, reason: string): string => (reason ? `${head}: ${reason}` : head)

function describeFlow(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null {
  const n = num(ev.n)
  switch (ev.tool) {
    case 'flow_set_phase': {
      const phase = str(ev.phase)
      return { kind: 'milestone', text: phase ? `phase: ${phase}` : 'moved to a new phase', slice: null }
    }
    case 'flow_add_decision': {
      const title = str(ev.title)
      return { kind: 'milestone', text: title ? `decided: ${title}` : 'recorded a decision', slice: null }
    }
    case 'flow_set_plan': {
      const slices = num(ev.slices)
      return {
        kind: 'milestone',
        text: slices === null ? 'plan proposed, waiting for your approval' : `plan proposed: ${slices} slices, waiting for your approval`,
        slice: null,
      }
    }
    case 'flow_start_slice': {
      if (n === null) return { kind: 'milestone', text: 'started a slice', slice: null }
      const title = sliceTitle(ctx.flow, n)
      return { kind: 'milestone', text: title ? `started slice ${n}: ${title}` : `started slice ${n}`, slice: n }
    }
    case 'flow_finish_slice':
      return {
        kind: 'milestone',
        text: n === null ? 'a slice is done, waiting for you' : `slice ${n} done, waiting for you`,
        slice: n,
      }
    case 'flow_report_review': {
      const important = num(ev.important)
      const minor = num(ev.minor)
      return {
        kind: 'milestone',
        text: important === null || minor === null ? 'review done' : `review: ${important} important, ${minor} minor`,
        slice: null,
      }
    }
    default:
      return null
  }
}

export function describeEvent(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null {
  switch (ev.event) {
    case 'note': {
      const text = str(ev.text)
      return text ? { kind: 'note', text: `Now: ${text}`, slice: num(ev.slice) } : null
    }
    case 'tool': {
      const text = describeTool(str(ev.tool), str(ev.target), ctx.root)
      return text ? { kind: 'action', text, slice: num(ev.slice) } : null
    }
    case 'blocked': {
      const tool = str(ev.tool)
      const target = str(ev.target)
      const reason = str(ev.reason).replace(/^hece:\s*/, '')
      let head: string
      if (tool === 'Bash') head = `hece stopped a command (${describeCommand(target)})`
      else if (FILE_TOOLS.has(tool)) head = `hece stopped an edit to ${relPath(ctx.root, target)}`
      else head = `hece stopped a tool call (${describeTool(tool, target, ctx.root) ?? tool})`
      return { kind: 'alert', text: withReason(head, reason), slice: null }
    }
    case 'approved': {
      const n = num(ev.n)
      if (ev.what === 'plan') return { kind: 'milestone', text: 'you approved the plan', slice: null }
      return { kind: 'milestone', text: n === null ? 'you approved a slice' : `you approved slice ${n}`, slice: n }
    }
    case 'redo_requested': {
      const n = num(ev.n)
      return { kind: 'milestone', text: n === null ? 'you asked to redo a slice' : `you asked to redo slice ${n}`, slice: n }
    }
    case 'hook_error':
    case 'prefs_error': {
      const message = str(ev.message)
      return { kind: 'alert', text: message ? `hece problem: ${message}` : 'hece problem', slice: null }
    }
    case 'flow':
      return describeFlow(ev, ctx)
    default:
      return null
  }
}
