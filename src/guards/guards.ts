import { FlowState } from '../flow/types.js'
import { Prefs } from '../prefs/schema.js'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export type GuardDecision = { allow: true } | { allow: false; reason: string }

const deny = (reason: string): GuardDecision => ({ allow: false, reason })

export function decideTool(flow: FlowState, prefs: Prefs, toolName: string): GuardDecision {
  if (!prefs.guards || !EDIT_TOOLS.has(toolName)) return { allow: true }
  if (flow.phase === 'idle' || flow.phase === 'done') return { allow: true }
  if (flow.phase === 'discuss') return deny('hece: no code edits during discussion; agree on a plan first')
  if (!flow.plan) return deny('hece: no code edits before there is a plan')
  if (!flow.plan.approved) {
    return deny(flow.plan.changed
      ? 'hece: the changed plan is waiting for the user to approve it'
      : 'hece: no code edits before the user approves the plan')
  }
  const stopped = flow.plan.slices.find((s) => s.status === 'stopped')
  if (stopped) return deny(`hece: slice ${stopped.n} is waiting for the user`)
  return { allow: true }
}

const CONTINUE_WORDS = new Set(['continue', 'ok', 'next', 'go', 'approve'])

export function isContinueIntent(text: string): boolean {
  return CONTINUE_WORDS.has(text.trim().toLowerCase().replace(/[.!\s]+$/u, ''))
}

// The picker's tool_response shape is not documented; accept a structured answer that is
// exactly "Continue", or the `"question"="Continue"` text form. Pinned by captured fixtures (Task 11).
export function pickerApproved(toolResponse: unknown): boolean {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(toolResponse)
  return strings.some((s) => s.trim().toLowerCase() === 'continue' || /="continue"/i.test(s))
}
