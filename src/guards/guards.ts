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

// AskUserQuestion's result is { questions: [...], answers: { "<question>": string | string[] } }.
// `questions` echoes every option label (including "Continue"), so only `answers` may be read.
// A plain string result uses the `"question"="Continue"` text form.
export function pickerApproved(toolResponse: unknown): boolean {
  if (typeof toolResponse === 'string') return /="continue"/i.test(toolResponse)
  if (toolResponse === null || typeof toolResponse !== 'object') return false
  const answers = (toolResponse as { answers?: unknown }).answers
  if (answers === null || typeof answers !== 'object') return false
  return Object.values(answers).some((a) =>
    (Array.isArray(a) ? a : [a]).some((v) => typeof v === 'string' && v.trim().toLowerCase() === 'continue'))
}
