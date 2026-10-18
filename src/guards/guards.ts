import { FlowState } from '../flow/types.js'
import { Prefs } from '../prefs/schema.js'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export type GuardDecision = { allow: true } | { allow: false; reason: string }

const deny = (reason: string): GuardDecision => ({ allow: false, reason })

export function decideTool(flow: FlowState, prefs: Prefs, toolName: string): GuardDecision {
  if (!prefs.guards || !EDIT_TOOLS.has(toolName)) return { allow: true }
  if (flow.phase === 'idle') return { allow: true }
  if (flow.phase === 'discuss') return deny('hece: no code edits during discussion; agree on a plan first')
  // done is not a free pass: a stopped slice or an unapproved new plan still blocks edits
  if (!flow.plan) return flow.phase === 'done' ? { allow: true } : deny('hece: no code edits before there is a plan')
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

const normalize = (text: string): string => text.trim().toLowerCase().replace(/[.!\s]+$/u, '')

export function isContinueIntent(text: string): boolean {
  return CONTINUE_WORDS.has(normalize(text))
}

export function isRedoIntent(text: string): boolean {
  return normalize(text) === 'redo'
}

// AskUserQuestion's result is { questions: [...], answers: { "<question>": string | string[] } }.
// `questions` echoes every option label (including "Continue"), so only `answers` may be read.
// Any other shape (such as a string the agent could imitate) yields no answers.
function pickerAnswers(toolResponse: unknown): string[] {
  if (toolResponse === null || typeof toolResponse !== 'object') return []
  const answers = (toolResponse as { answers?: unknown }).answers
  if (answers === null || typeof answers !== 'object') return []
  return Object.values(answers)
    .flatMap((a) => (Array.isArray(a) ? a : [a]))
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
}

export function pickerApproved(toolResponse: unknown): boolean {
  return pickerAnswers(toolResponse).includes('continue')
}

export function pickerRedo(toolResponse: unknown): boolean {
  return pickerAnswers(toolResponse).includes('redo')
}
