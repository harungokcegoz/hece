import fs from 'node:fs'
import { statePaths } from '../state/paths.js'
import { readJson, writeJsonAtomic, appendEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { approve, requestRedo } from '../flow/flow.js'
import { Prefs } from '../prefs/schema.js'
import { EDIT_TOOLS, decideTool, isContinueIntent, isRedoIntent, pickerApproved, pickerRedo } from '../guards/guards.js'

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  source?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
}

export interface HookContext {
  root: string
  prefs: Prefs
  prefsErrors: string[]
  now: number
}

export interface SessionRecord {
  sessionId: string
  source: string
  at: number
}

const PICKER_TOOL = 'AskUserQuestion'

const oneLine = (raw: string): string => {
  const s = raw.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

export function summarizeTool(name: string, input?: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (name === 'Bash') return oneLine(str(input?.command))
  return oneLine(str(input?.file_path) || str(input?.notebook_path) || str(input?.pattern) || str(input?.path))
}

export function handleHook(p: HookPayload, ctx: HookContext): { stdout: string } {
  const paths = statePaths(ctx.root)
  // hooks fire in every project once the plugin is installed; stay silent where no hece flow exists
  if (!fs.existsSync(paths.flow)) return { stdout: '' }

  const none = { stdout: '' }
  const ev = (event: string, extra: Record<string, unknown> = {}) =>
    appendEvent(paths.events, { at: ctx.now, event, session: p.session_id, ...extra })
  const setIdle = (idle: boolean) => writeJsonAtomic(paths.agent, { idle, at: ctx.now })
  const deny = (reason: string) => ({
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  })

  let flow: FlowState
  try {
    flow = readJson<FlowState>(paths.flow, emptyFlow())
  } catch (err) {
    // an unreadable flow must not silently switch the guards off
    ev('hook_error', { message: (err as Error).message })
    if (p.hook_event_name === 'PreToolUse' && EDIT_TOOLS.has(p.tool_name ?? '') && ctx.prefs.guards) {
      return deny('hece: .hece/state/flow.json is unreadable; run hece status')
    }
    return none
  }

  const recordRedo = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', via: string) => {
    const { state, requested } = requestRedo(flow, ctx.now)
    if (requested === null) return none
    writeJsonAtomic(paths.flow, state)
    ev('redo_requested', { n: requested, via })
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: `hece: the user asked to redo slice ${requested}` },
      }),
    }
  }

  const recordApproval = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', via: string) => {
    const { state, approved } = approve(flow, ctx.now)
    if (!approved) return none
    writeJsonAtomic(paths.flow, state)
    const text = approved.what === 'plan' ? 'hece: the user approved the plan' : `hece: the user approved slice ${approved.n}`
    ev('approved', { what: approved.what, n: approved.what === 'slice' ? approved.n : undefined, via })
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) }
  }

  switch (p.hook_event_name) {
    case 'SessionStart': {
      if (p.session_id) {
        const sessions = readJson<SessionRecord[]>(paths.sessions, [])
        sessions.push({ sessionId: p.session_id, source: p.source ?? 'unknown', at: ctx.now })
        writeJsonAtomic(paths.sessions, sessions)
      }
      ev('session_start', { source: p.source })
      for (const message of ctx.prefsErrors) ev('prefs_error', { message })
      return none
    }
    case 'UserPromptSubmit': {
      setIdle(false)
      ev('prompt', { text: oneLine(p.prompt ?? '') })
      if (p.prompt && isRedoIntent(p.prompt)) return recordRedo('UserPromptSubmit', 'typed')
      return p.prompt && isContinueIntent(p.prompt) ? recordApproval('UserPromptSubmit', 'typed') : none
    }
    case 'PreToolUse': {
      setIdle(false)
      const name = p.tool_name ?? ''
      const target = summarizeTool(name, p.tool_input)
      const d = decideTool(flow, ctx.prefs, name)
      if (!d.allow) {
        ev('blocked', { tool: name, target, reason: d.reason })
        return deny(d.reason)
      }
      ev('tool', { tool: name, target, slice: flow.currentSlice })
      return none
    }
    case 'PostToolUse': {
      if (p.tool_name !== PICKER_TOOL) return none
      // redo wins if both were somehow selected: it is the answer that does not advance the flow
      if (pickerRedo(p.tool_response)) return recordRedo('PostToolUse', 'picker')
      return pickerApproved(p.tool_response) ? recordApproval('PostToolUse', 'picker') : none
    }
    case 'Stop':
      setIdle(true)
      ev('turn_done')
      return none
    default:
      return none
  }
}
