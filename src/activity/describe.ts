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

const COMMAND_RULES: [RegExp, string][] = [
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest)\b|\bgo\s+test\b|\bcargo\s+test\b/, 'running the tests'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bcargo\s+add\b|\bbrew\s+install\b/, 'installing packages'],
  [/\b(npm|pnpm|yarn|bun)\s+run\s+(lint|typecheck|format)\b|\b(eslint|prettier)\b/, 'checking code style and types'],
  [/\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\b(cargo|go)\s+build\b|^make\b/, 'building the project'],
  [/^git\s+commit\b/, 'committing the changes'],
  [/^git\s+(status|diff|log|show)\b/, 'checking what changed in git'],
  [/^git\b/, 'using git'],
  [/^(ls|find|tree|cat|head|tail|wc|grep|rg|pwd)\b/, 'looking around the files'],
  [/^(mkdir|touch|cp|mv)\b/, 'arranging files'],
  [/^rm\b/, 'deleting files'],
  [/^(curl|wget)\b/, 'calling a URL'],
]

// the part of a shell line that matters: skip `cd …`, `export …` and leading VAR=value
function mainCommand(command: string): string {
  const segments = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)
  const seg = segments.find((s) => s && !/^(cd|export|set)\b/.test(s)) ?? ''
  return seg.replace(/^(\w+=\S*\s+)+/, '')
}

export function describeCommand(command: string): string {
  const cmd = mainCommand(command)
  for (const [re, text] of COMMAND_RULES) if (re.test(cmd)) return text
  const run = cmd.match(/^(?:node|python3?|ruby|deno|bun|tsx)\s+(?:run\s+)?(\S+)/)
  if (run) return `running ${path.basename(run[1])}`
  return 'running a command'
}

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
      return `changing ${relPath(root, target)}`
    case 'Write':
      return `writing ${relPath(root, target)}`
    case 'NotebookEdit':
      return `changing notebook ${relPath(root, target)}`
    case 'Read':
      return `reading ${relPath(root, target)}`
    case 'Grep':
      return target ? `searching the code for "${target}"` : 'searching the code'
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

function describeFlow(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null {
  const n = num(ev.n)
  switch (ev.tool) {
    case 'flow_set_phase':
      return { kind: 'milestone', text: `phase: ${str(ev.phase)}`, slice: null }
    case 'flow_add_decision':
      return { kind: 'milestone', text: `decided: ${str(ev.title)}`, slice: null }
    case 'flow_set_plan':
      return { kind: 'milestone', text: `plan proposed: ${num(ev.slices)} slices, waiting for your approval`, slice: null }
    case 'flow_start_slice':
      return { kind: 'milestone', text: `started slice ${n}: ${sliceTitle(ctx.flow, n)}`, slice: n }
    case 'flow_finish_slice':
      return { kind: 'milestone', text: `slice ${n} done, waiting for you`, slice: n }
    case 'flow_report_review':
      return { kind: 'milestone', text: `review: ${num(ev.important)} important, ${num(ev.minor)} minor`, slice: null }
    default:
      return null
  }
}

export function describeEvent(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null {
  switch (ev.event) {
    case 'note':
      return { kind: 'note', text: `Now: ${str(ev.text)}`, slice: num(ev.slice) }
    case 'tool': {
      const text = describeTool(str(ev.tool), str(ev.target), ctx.root)
      return text ? { kind: 'action', text, slice: num(ev.slice) } : null
    }
    case 'blocked':
      return {
        kind: 'alert',
        text: `hece stopped an edit to ${relPath(ctx.root, str(ev.target))}: ${str(ev.reason).replace(/^hece:\s*/, '')}`,
        slice: null,
      }
    case 'approved':
      return ev.what === 'plan'
        ? { kind: 'milestone', text: 'you approved the plan', slice: null }
        : { kind: 'milestone', text: `you approved slice ${num(ev.n)}`, slice: num(ev.n) }
    case 'redo_requested':
      return { kind: 'milestone', text: `you asked to redo slice ${num(ev.n)}`, slice: num(ev.n) }
    case 'hook_error':
    case 'prefs_error':
      return { kind: 'alert', text: `hece problem: ${str(ev.message)}`, slice: null }
    case 'flow':
      return describeFlow(ev, ctx)
    default:
      return null
  }
}
