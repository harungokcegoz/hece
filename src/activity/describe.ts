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

// Drops here-document bodies (and the <<WORD operator itself): what a heredoc says is data, not a command.
// Quote- and arithmetic-aware: a quoted << or an arithmetic shift is not a heredoc.
// An unterminated heredoc swallows the rest of the text.
function stripHeredocs(command: string): string {
  const pending: Array<{ word: string; tabs: boolean }> = []
  let out = ''
  let quote = ''
  let arithmeticDepth = 0
  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      out += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) out += command[++i]
      else if (c === quote) quote = ''
      i++
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      out += c + command[++i]
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (command.startsWith('$((', i)) {
      arithmeticDepth += 2
      out += '$(('
      i += 3
      continue
    }
    if (arithmeticDepth > 0) {
      if (c === '(') arithmeticDepth++
      else if (c === ')') arithmeticDepth--
      out += c
      i++
      continue
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][^\s;&|<>()]*))/.exec(command.slice(i))
      if (m) {
        pending.push({ word: m[2] ?? m[3] ?? m[4] ?? '', tabs: m[1] === '-' })
        i += m[0].length
        continue
      }
    }
    if (c === '\n' && pending.length) {
      out += c
      i++
      for (const h of pending) {
        // skip body lines up to and including the one that is exactly the delimiter
        while (i < command.length) {
          let end = command.indexOf('\n', i)
          if (end === -1) end = command.length
          const line = command.slice(i, end)
          i = Math.min(end + 1, command.length)
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.word) break
        }
      }
      pending.length = 0
      continue
    }
    out += c
    i++
  }
  return out
}

// Skip comparison/arithmetic syntax before looking for shell operators inside it.
// Recognize [[ after control/negation keywords, while leaving ordinary arguments alone.
function expressionEnd(text: string, start: number, prefix: string): number {
  const test = text.startsWith('[[', start)
    && /^\s*(?:(?:!|if|elif|while|until|then|else|do)\s+)*$/.test(prefix)
    && /\s/.test(text[start + 2] ?? '')
  const expansion = text.startsWith('$((', start)
  if (!test && !expansion && !text.startsWith('((', start)) return start
  let depth = 2
  let quote = ''
  let wordStart = true
  for (let i = start + (expansion ? 3 : 2); i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '\\') {
      wordStart = false
      i++
    } else if (c === '"' || c === "'") {
      wordStart = false
      quote = c
    } else if (test) {
      // ]] must be its own shell token, not part of an unquoted comparison word.
      if (wordStart && text.startsWith(']]', i) && (i + 2 === text.length || /[\s;&|<>()]/.test(text[i + 2]))) return i + 2
      wordStart = /[\s;&|<>()]/.test(c)
    } else {
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i + 1
    }
  }
  return text.length
}

interface Redirects {
  /** the segment without its >, >> and >| redirections */
  rest: string
  /** raw (unquoted) file targets; /dev/null and fd copies like 2>&1 are left out */
  targets: string[]
  /** an explicit >| overwrite keeps an informative program description alongside the write */
  clobber: boolean
}

// Finds unquoted >, >> and >| redirections. `2>&1` and `>/dev/null` do not count as writing a file.
function extractRedirects(segment: string): Redirects {
  const targets: string[] = []
  let rest = ''
  let clobber = false
  let quote = ''
  let i = 0
  while (i < segment.length) {
    const c = segment[i]
    if (quote) {
      rest += c
      if (c === '\\' && quote === '"' && i + 1 < segment.length) rest += segment[++i]
      else if (c === quote) quote = ''
      i++
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      rest += c + segment[++i]
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      rest += c
      i++
      continue
    }
    const end = expressionEnd(segment, i, rest)
    if (end > i) {
      rest += segment.slice(i, end)
      i = end
      continue
    }
    if (c === '>' && segment[i + 1] !== '(') {
      // also eat an fd number in front (2>file) and a leading & (&>file)
      rest = rest.replace(/(?:^|(?<=\s))(?:\d+|&)$/, '')
      i++
      if (segment[i] === '>') i++
      if (segment[i] === '|') {
        clobber = true
        i++
      }
      const dup = segment[i] === '&' && /[\d-]/.test(segment[i + 1] ?? '')
      if (segment[i] === '&') i++
      while (i < segment.length && /[ \t]/.test(segment[i])) i++
      let word = ''
      let wq = ''
      for (; i < segment.length; i++) {
        const d = segment[i]
        if (wq) {
          if (d === wq) wq = ''
          else if (d === '\\' && wq === '"' && i + 1 < segment.length) word += segment[++i]
          else word += d
        } else if (d === '"' || d === "'") wq = d
        else if (d === '\\' && i + 1 < segment.length) word += segment[++i]
        else if (/[\s;|&<>()]/.test(d)) break
        else word += d
      }
      if (!dup && word && !/^\/dev\/(null|stdout|stderr)$/.test(word)) targets.push(word)
      rest += ' '
      continue
    }
    rest += c
    i++
  }
  return { rest, targets, clobber }
}

// Split on shell separators outside quotes and comparison/arithmetic expressions; >| is a redirect.
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
    const end = expressionEnd(command, i, cur)
    if (end > i) {
      cur += command.slice(i, end)
      i = end - 1
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '>|') {
      cur += two
      i++
    } else if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
    } else if (c === ';' || c === '|' || c === '\n') {
      out.push(cur)
      cur = ''
    } else if (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && command[i + 1] !== '>') {
      // a bare & (background job) separates commands; >&, <&, &> and 2>&1 are redirects
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
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--env-file', '-m', '-I', '--watch-path', '-W'])

const nonFlags = (args: string[]): string[] => args.filter((a) => !a.startsWith('-'))

function describeGit(args: string[]): string {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  // --dry-run, or -n alone or inside a short-flag cluster (-fdn)
  // Anything after a bare -- is a path, not a flag.
  const flags = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  const dryRun = flags.some((a) => a === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))
  switch (sub) {
    case 'push':
      if (dryRun) return 'previewing a push'
      return rest.some((a) => a.startsWith('--force') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+\S/.test(a))
        ? 'force-pushing to a remote'
        : 'pushing to a remote'
    case 'reset':
      return rest.includes('--hard') ? 'discarding local changes' : 'using git'
    case 'clean':
      return dryRun ? 'previewing a git clean' : 'removing untracked files'
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

// flags of package managers that take a value; the value must not be read as the subcommand
const PM_VALUE_FLAGS = new Set(['--prefix', '-w', '--workspace', '--filter', '--cwd', '-C', '--dir'])

// Skips known value flags; `clean` is false when some other flag comes first, since then we can't tell the subcommand.
function parsePm(args: string[]): { sub: string | undefined; rest: string[]; clean: boolean } {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (!PM_VALUE_FLAGS.has(args[i].split('=')[0])) return { sub: undefined, rest: [], clean: false }
    i += args[i].includes('=') ? 1 : 2
  }
  return { sub: args[i], rest: args.slice(i + 1), clean: true }
}

function describePackageManager(args: string[]): string {
  const { sub, rest, clean } = parsePm(args)
  if (!clean) return 'running a command'
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
      // find the script name, skipping known value flags; an unknown flag makes the name unreliable
      let unsure = false
      let name: string | undefined
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]
        if (!a.startsWith('-')) {
          name = a
          break
        }
        if (PM_VALUE_FLAGS.has(a.split('=')[0])) {
          if (!a.includes('=')) i++
        } else unsure = true
      }
      if (!name) return 'running a command'
      if (unsure || !/^[A-Za-z0-9:._-]{1,30}$/.test(name)) return 'running a script'
      if (name === 'test') return 'running the tests'
      if (name === 'lint' || name === 'typecheck' || name === 'format') return 'checking code style and types'
      if (name === 'build') return 'building the project'
      return `running the ${name} script`
    }
    default:
      return 'running a command'
  }
}

const looksLikeFile = (a: string): boolean => a.includes('/') || /\.[A-Za-z0-9]+$/.test(a)

function describeInterpreter(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (INLINE_FLAGS.has(a)) return 'running inline code'
    if (a === '-m' && /^(pytest|unittest)$/.test(args[i + 1] ?? '')) return 'running the tests'
    if (VALUE_FLAGS.has(a)) {
      i++
      continue
    }
    if (!a.startsWith('-') && looksLikeFile(a)) return `running ${path.basename(a)}`
  }
  return 'running a command'
}

// what a program does when that says little, a write to a file says more
const VAGUE = new Set(['running a command', 'looking around the files'])

function writeLabel(target: string, root?: string): string {
  // an expansion could be anything; never echo it
  if (/[$`*?{}~]/.test(target)) return 'writing a file'
  if (root) return `writing ${fileLabel(root, target)}`
  const rel = path.normalize(target)
  return `writing ${path.isAbsolute(rel) || rel.startsWith('..') ? path.basename(target) : rel}`
}

function describeSegment(segment: string, root?: string): string[] {
  const { rest, targets, clobber } = extractRedirects(segment)
  const prog = describeProgram(rest, root)
  const descriptions = Array.isArray(prog) ? prog : prog ? [prog] : []
  const writes = [...new Set(targets.map((t) => writeLabel(t, root)))]
  if (!writes.length) return descriptions
  return [...descriptions.filter((d) => !VAGUE.has(d) || (clobber && d === 'looking around the files')), ...writes]
}

function describeTee(args: string[], root?: string): string | string[] {
  const files: string[] = []
  let options = true
  for (const arg of args) {
    if (options && arg === '--') options = false
    else if (options && arg.startsWith('-')) {
      // Unknown flags may consume a value: don't mistake that value for a file.
      if (!/^-[ai]+$/.test(arg) && arg !== '--append' && arg !== '--ignore-interrupts') return 'running a command'
    } else if (arg && !/^\/dev\/(null|stdout|stderr)$/.test(arg)) files.push(arg)
  }
  // Tokenization cannot reliably separate unquoted substitution contents from later filenames.
  if (files.some((f) => f.includes('$(') || f.includes('`'))) return 'writing a file'
  return files.length ? files.map((f) => writeLabel(f, root)) : 'running a command'
}

function describeProgram(segment: string, root?: string): string | string[] | null {
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
  if (prog === 'tee') return describeTee(args, root)
  const BUN_PM_SUBS = ['i', 'install', 'add', 'ci', 'test', 'run', 'publish']
  const pm = parsePm(args)
  if (PKG_MANAGERS.has(prog) && (prog !== 'bun' || (pm.clean && pm.sub !== undefined && BUN_PM_SUBS.includes(pm.sub)))) {
    return describePackageManager(args)
  }
  if (prog === 'deno' && pm.clean && pm.sub === 'run') return describePackageManager(args)
  if (/^pip3?$/.test(prog) && sub === 'install') return 'installing packages'
  if (prog === 'cargo' && sub === 'add') return 'installing packages'
  if (prog === 'brew' && sub === 'install') return 'installing packages'
  if (/^(vitest|jest|mocha|pytest)$/.test(prog)) return 'running the tests'
  if ((prog === 'go' || prog === 'cargo') && sub === 'test') return 'running the tests'
  if (/^(eslint|prettier)$/.test(prog)) return 'checking code style and types'
  if (prog === 'tsc' || ((prog === 'cargo' || prog === 'go') && sub === 'build')) return 'building the project'
  if (prog === 'make') {
    const target = args[0]
    return target === undefined || target === 'build' || target === 'all' ? 'building the project' : 'running a make task'
  }
  if (prog === 'find') {
    const del = args.includes('-delete') || args.some((a, i) => /^-exec(dir)?$/.test(a) && path.basename(args[i + 1] ?? '') === 'rm')
    if (del) return 'deleting files'
    return args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) ? 'running a command on matching files' : 'looking around the files'
  }
  if (/^(ls|tree|cat|head|tail|wc|grep|rg|pwd)$/.test(prog)) return 'looking around the files'
  if (/^(mkdir|touch|cp|mv)$/.test(prog)) return 'arranging files'
  if (prog === 'rm') return 'deleting files'
  if (/^(curl|wget)$/.test(prog)) return 'calling a URL'
  if (INTERPRETERS.has(prog)) return describeInterpreter(args)
  return 'running a command'
}

// Describes every program in the line, in order, by program position only. Never echoes command text.
// Heredoc bodies are skipped; `root` only decides how a redirect target is labelled.
export function describeCommand(command: string, root?: string): string {
  const parts: string[] = []
  for (const seg of splitSegments(stripHeredocs(command))) {
    for (const d of describeSegment(seg, root)) if (!parts.includes(d)) parts.push(d)
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

// Both Grep and Glob hide credential-looking patterns, even when the value is short.
const safePattern = (t: string): boolean =>
  t.length <= 40
  && !/(?:AKIA|ASIA)[A-Z0-9]{16}/i.test(t)
  && !/(?:password|token|secret|key|auth)[\w.-]*["']?\s*[:=]/i.test(t)
  // Long key/hex/base64-looking runs include base64 separators and padding.
  && !/[A-Za-z0-9+/_=-]{24,}/.test(t)

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
      return target && safePattern(target) ? `looking for files matching ${target}` : 'looking for files'
    case 'Bash':
      return describeCommand(target, root)
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
      const text = ev.tool === 'Bash' && str(ev.desc) ? str(ev.desc) : describeTool(str(ev.tool), str(ev.target), ctx.root)
      return text ? { kind: 'action', text, slice: num(ev.slice) } : null
    }
    case 'blocked': {
      const tool = str(ev.tool)
      const target = str(ev.target)
      const reason = str(ev.reason).replace(/^hece:\s*/, '')
      let head: string
      if (tool === 'Bash') head = `hece stopped a command (${str(ev.desc) || describeCommand(target, ctx.root)})`
      else if (FILE_TOOLS.has(tool)) head = `hece stopped an edit to ${fileLabel(ctx.root, target)}`
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
