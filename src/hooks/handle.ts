import fs from 'node:fs'
import { statePaths } from '../state/paths.js'
import { readJson, writeJsonAtomic, appendEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { renderFlow } from '../flow/render.js'
import { approve, requestRedo } from '../flow/flow.js'
import { Prefs } from '../prefs/schema.js'
import { describeCommand } from '../activity/describe.js'
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
  configDir: string
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
const NON_FORK_SOURCES = new Set(['startup', 'resume', 'clear', 'compact'])
const FLOW_PHASE_TOOLS = new Set(['mcp__plugin_hece_hece__flow_set_phase', 'mcp__hece__flow_set_phase'])
const hasSessionId = (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0

/** The captured MCP success response must describe this pristine, newly created discussion exactly. */
function createdDiscussion(p: HookPayload, flow: FlowState, prefs: Prefs): boolean {
  if (p.hook_event_name !== 'PostToolUse' || !FLOW_PHASE_TOOLS.has(p.tool_name ?? '') || p.tool_input?.phase !== 'discuss') return false
  if (flow.phase !== 'discuss' || flow.plan !== null || flow.currentSlice !== null || flow.review !== null || !Array.isArray(flow.decisions) || flow.decisions.length !== 0) return false
  const response = p.tool_response
  return Array.isArray(response) && response.length === 1 && response[0]?.type === 'text' && response[0]?.text === renderFlow(flow, { guards: prefs.guards })
}

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
    const raw: unknown = readJson<unknown>(paths.flow, emptyFlow())
    if (raw === null || typeof raw !== 'object' || typeof (raw as { phase?: unknown }).phase !== 'string') {
      throw new Error(`hece: ${paths.flow} is not a hece flow`)
    }
    flow = raw as FlowState
  } catch (err) {
    // an unreadable flow must not silently switch the guards off
    ev('hook_error', { message: (err as Error).message })
    if (p.hook_event_name === 'PreToolUse' && EDIT_TOOLS.has(p.tool_name ?? '') && ctx.prefs.guards) {
      return deny('hece: .hece/state/flow.json is unreadable; run hece status')
    }
    return none
  }

  let sessions: SessionRecord[] = []
  let sessionsReadable = true
  try {
    const recorded = readJson<unknown>(paths.sessions, [])
    if (!Array.isArray(recorded) || recorded.some(s => !s || typeof s !== 'object' || !hasSessionId(s.sessionId) || typeof s.source !== 'string')) {
      throw new Error('invalid recorded sessions')
    }
    sessions = recorded as SessionRecord[]
  } catch {
    // Broken ownership metadata must not prevent the independent edit guards from running.
    sessionsReadable = false
    ev('hook_error', { message: 'hece: .hece/state/sessions.json is unreadable; run hece status' })
  }
  const forkIds = new Set(sessions.filter(s => s.source === 'fork').map(s => s.sessionId))
  if (p.hook_event_name === 'SessionStart' && p.source === 'fork' && hasSessionId(p.session_id)) forkIds.add(p.session_id)
  const bindMain = (id: string) => {
    flow = { ...flow, mainSessionId: id }
    writeJsonAtomic(paths.flow, flow)
  }
  const bindRecordedMain = () => {
    if (!sessionsReadable || hasSessionId(flow.mainSessionId)) return
    const main = sessions.find(s => hasSessionId(s.sessionId) && NON_FORK_SOURCES.has(s.source) && !forkIds.has(s.sessionId))
    if (main) bindMain(main.sessionId)
  }
  // Older flows may already have trustworthy SessionStart records. Approval payloads never claim ownership.
  // Defer metadata writes outside PreToolUse, so a migration I/O error cannot bypass edit guards.
  if (p.hook_event_name !== 'PreToolUse') bindRecordedMain()
  // SessionStart before the first flow writes nothing. The successful creator result bridges that gap;
  // no other tool, prompt or picker can claim an unowned flow, and recorded forks remain ineligible.
  if (sessionsReadable && !hasSessionId(flow.mainSessionId) && hasSessionId(p.session_id) && p.source !== 'fork' && !forkIds.has(p.session_id) && createdDiscussion(p, flow, ctx.prefs)) {
    bindMain(p.session_id)
  }

  const fromMain = (via: string): boolean => {
    const reason = !sessionsReadable ? 'unreadable_sessions'
      : !hasSessionId(flow.mainSessionId) ? 'missing_main_session'
      : !hasSessionId(p.session_id) ? 'missing_session'
      : p.session_id !== flow.mainSessionId || p.source === 'fork' || forkIds.has(p.session_id) ? 'not_main_session'
      : null
    if (reason === null) return true
    ev('ignored_approval', { via, reason })
    return false
  }

  const recordRedo = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', via: string) => {
    if (!fromMain(via)) return none
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
    if (!fromMain(via)) return none
    const { state, approved } = approve(flow, ctx.now)
    if (!approved) return none
    writeJsonAtomic(paths.flow, state)
    const text = approved.what === 'plan' ? 'hece: the user approved the plan' : `hece: the user approved slice ${approved.n}`
    ev('approved', { what: approved.what, n: approved.what === 'slice' ? approved.n : undefined, via })
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) }
  }

  switch (p.hook_event_name) {
    case 'SessionStart': {
      if (sessionsReadable && hasSessionId(p.session_id)) {
        sessions.push({ sessionId: p.session_id, source: p.source ?? 'unknown', at: ctx.now })
        writeJsonAtomic(paths.sessions, sessions)
        bindRecordedMain()
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
      // describe the whole command: `target` is squashed and cut, so a late force-push or a heredoc would be missed
      const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : ''
      const desc = name === 'Bash' ? { desc: describeCommand(command, ctx.root) } : {}
      const d = decideTool(flow, ctx.prefs, { name, input: p.tool_input }, { root: ctx.root, configDir: ctx.configDir })
      if (!d.allow) {
        ev('blocked', { tool: name, target, ...desc, reason: d.reason })
        return deny(d.reason)
      }
      ev('tool', { tool: name, target, ...desc, slice: flow.currentSlice })
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
