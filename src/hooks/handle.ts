import fs from 'node:fs'
import { statePaths } from '../state/paths.js'
import { readJson, writeJsonAtomic, appendEvent } from '../state/store.js'
import { FlowState, BuildMode, emptyFlow } from '../flow/types.js'
import { withDirLock } from '../util/dirlock.js'
import { renderFlow } from '../flow/render.js'
import { approve, requestRedo, clearCheckPending, chooseMode } from '../flow/flow.js'
import { Prefs } from '../prefs/schema.js'
import { describeCommand } from '../activity/describe.js'
import { EDIT_TOOLS, decideTool, isContinueIntent, parseRedo, pickerMode, pickerApproved, pickerRedo } from '../guards/guards.js'

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
  /** how long to wait for the flow.json lock (tests shorten it) */
  lockTimeoutMs?: number
  /** Claude was launched by `hece` (HECE_SESSION=1): say so at session start even before a flow exists */
  heceSession?: boolean
}

export interface SessionRecord {
  sessionId: string
  source: string
  at: number
}

export const HECE_SESSION_CONTEXT =
  'hece: this is a hece session. hece is active from the start: for any request to build, design or brainstorm something, use the hece flow skill and call flow_set_phase(discuss) to start the flow, even if the user does not say "hece". Use superpowers:brainstorming inside the discuss phase.'

const MAX_SESSIONS = 50
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
  if (!fs.existsSync(paths.flow)) {
    // the one exception: a session hece launched is told hece is active. Nothing is written.
    if (ctx.heceSession && p.hook_event_name === 'SessionStart') {
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: HECE_SESSION_CONTEXT } }) }
    }
    return { stdout: '' }
  }

  const none = { stdout: '' }
  const ev = (event: string, extra: Record<string, unknown> = {}) =>
    appendEvent(paths.events, { at: ctx.now, event, session: p.session_id, ...extra })
  const setIdle = (idle: boolean) => writeJsonAtomic(paths.agent, { idle, at: ctx.now })
  const deny = (reason: string) => ({
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  })

  const loadFlow = (): FlowState => {
    const raw: unknown = readJson<unknown>(paths.flow, emptyFlow())
    if (raw === null || typeof raw !== 'object' || typeof (raw as { phase?: unknown }).phase !== 'string') {
      throw new Error(`hece: ${paths.flow} is not a hece flow`)
    }
    return raw as FlowState
  }
  let flow: FlowState
  try {
    flow = loadFlow()
  } catch (err) {
    // an unreadable flow must not silently switch the guards off
    ev('hook_error', { message: (err as Error).message })
    if (p.hook_event_name === 'PreToolUse' && EDIT_TOOLS.has(p.tool_name ?? '') && (ctx.prefs.guards.stops || ctx.prefs.guards.files)) {
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
  // Every read-modify-write of flow.json runs under one lock next to it and starts from what is on disk now,
  // so a concurrent MCP write is never overwritten with an older copy. `flow` is refreshed inside the lock.
  // When the lock cannot be had, the change is not made: the event says so and the caller reports it.
  const updateFlow = (change: () => FlowState | null): { ran: boolean; wrote: boolean } => {
    const r = withDirLock(paths.flowLock, () => {
      flow = loadFlow()
      const next = change()
      if (next === null) return false
      flow = next
      writeJsonAtomic(paths.flow, flow)
      return true
    }, { timeoutMs: ctx.lockTimeoutMs })
    if (!r.ran) ev('hook_error', { message: 'hece: flow.json is busy; the change was not recorded' })
    return { ran: r.ran, wrote: r.ran && r.value }
  }
  const notRecorded = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', what: string) => ({
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: `hece: could not record ${what} (flow.json is busy); ask the user to answer again` },
    }),
  })
  const bindMain = (id: string) => {
    updateFlow(() => (hasSessionId(flow.mainSessionId) ? null : { ...flow, mainSessionId: id }))
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

  const mainReason = (): string | null =>
    !sessionsReadable ? 'unreadable_sessions'
      : !hasSessionId(flow.mainSessionId) ? 'missing_main_session'
      : !hasSessionId(p.session_id) ? 'missing_session'
      : p.session_id !== flow.mainSessionId || p.source === 'fork' || forkIds.has(p.session_id) ? 'not_main_session'
      : null
  const fromMain = (via: string): boolean => {
    const reason = mainReason()
    if (reason === null) return true
    ev('ignored_approval', { via, reason })
    return false
  }

  // The user's next answer in the main session belongs to the open check question: it is never an approval.
  const consumeCheckAnswer = (via: string): boolean => {
    if (!flow.checkPending || mainReason() !== null) return false
    const r = updateFlow(() => (flow.checkPending ? clearCheckPending(flow, ctx.now) : null))
    if (r.wrote) ev('check_answered', { via })
    return true
  }

  const say = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', additionalContext: string) => ({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  })

  const recordRedo = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', via: string, ns: number[] = []) => {
    let requested: number[] = []
    let waiting: number[] = []
    const r = updateFlow(() => {
      if (!fromMain(via)) return null
      const res = requestRedo(flow, ctx.now, ns)
      requested = res.requested
      waiting = res.waiting
      return requested.length === 0 ? null : res.state
    })
    if (!r.ran) return notRecorded(hookEventName, 'the redo request')
    if (requested.length === 0) {
      return waiting.length > 0 && r.ran && mainReason() === null
        ? say(hookEventName, `hece: say which slices to redo, e.g. redo 1 3 (waiting: ${waiting.join(', ')})`)
        : none
    }
    ev('redo_requested', { n: requested[0], ns: requested, via })
    return say(hookEventName, `hece: the user asked to redo slice${requested.length > 1 ? 's' : ''} ${requested.join(', ')}`)
  }

  const recordMode = (via: string, mode: BuildMode) => {
    const r = updateFlow(() => (fromMain(via) ? chooseMode(flow, mode, ctx.now) : null))
    if (!r.ran) return notRecorded('PostToolUse', 'the mode')
    if (!r.wrote) {
      // a main-session answer that came too late: tell the agent what the mode is, so it can't drift
      const started = flow.plan?.slices.some(x => x.status !== 'todo')
      return started && mainReason() === null ? say('PostToolUse', `hece: the mode is already ${flow.plan?.mode === 'parallel' ? 'parallel' : 'one by one'}; it can't change mid-build`) : none
    }
    ev('mode_chosen', { mode, via })
    return say('PostToolUse', `hece: the user chose ${mode === 'parallel' ? 'parallel' : 'one by one'}`)
  }

  const recordApproval = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', via: string) => {
    let approved = null as ReturnType<typeof approve>['approved']
    const r = updateFlow(() => {
      if (!fromMain(via)) return null
      const res = approve(flow, ctx.now)
      approved = res.approved
      return res.approved ? res.state : null
    })
    if (!r.ran) return notRecorded(hookEventName, 'the approval')
    const running = flow.plan?.approved && flow.plan.mode === 'parallel' && flow.plan.slices.some(x => x.status === 'todo' || x.status === 'working')
    if (!approved) return running && mainReason() === null ? say(hookEventName, 'hece: slices are still running; the user can approve once the batch is done') : none
    const text =
      approved.what === 'plan' ? 'hece: the user approved the plan'
      : approved.what === 'slices' ? `hece: the user approved slices ${approved.ns.join(', ')}`
      : `hece: the user approved slice ${approved.n}`
    ev('approved', { what: approved.what, n: approved.what === 'slice' ? approved.n : undefined, ns: approved.what === 'slices' ? approved.ns : undefined, via })
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) }
  }

  switch (p.hook_event_name) {
    case 'SessionStart': {
      if (sessionsReadable && hasSessionId(p.session_id)) {
        sessions.push({ sessionId: p.session_id, source: p.source ?? 'unknown', at: ctx.now })
        // keep the file bounded: only recent sessions matter for ownership checks
        writeJsonAtomic(paths.sessions, sessions.slice(-MAX_SESSIONS))
        bindRecordedMain()
      }
      ev('session_start', { source: p.source })
      for (const message of ctx.prefsErrors) ev('prefs_error', { message })
      return none
    }
    case 'UserPromptSubmit': {
      setIdle(false)
      ev('prompt', { text: oneLine(p.prompt ?? '') })
      const wasCheckAnswer = consumeCheckAnswer('typed')
      const redo = p.prompt ? parseRedo(p.prompt) : null
      if (redo) return recordRedo('UserPromptSubmit', 'typed', redo)
      if (wasCheckAnswer) return none
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
      const working = flow.plan?.slices.filter(x => x.status === 'working') ?? []
      ev('tool', { tool: name, target, ...desc, slice: working.length === 1 ? working[0].n : working.length > 1 ? null : flow.currentSlice })
      return none
    }
    case 'PostToolUse': {
      if (p.tool_name !== PICKER_TOOL) return none
      const wasCheckAnswer = consumeCheckAnswer('picker')
      // redo wins if both were somehow selected: it is the answer that does not advance the flow
      if (pickerRedo(p.tool_response)) return recordRedo('PostToolUse', 'picker')
      if (wasCheckAnswer) return none
      if (pickerApproved(p.tool_response)) return recordApproval('PostToolUse', 'picker')
      const mode = pickerMode(p.tool_response)
      return mode ? recordMode('picker', mode) : none
    }
    case 'Stop':
      setIdle(true)
      ev('turn_done')
      return none
    default:
      return none
  }
}
