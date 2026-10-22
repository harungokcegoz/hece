import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FlowState } from '../flow/types.js'
import { Prefs } from '../prefs/schema.js'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export type GuardDecision = { allow: true } | { allow: false; reason: string }

const deny = (reason: string): GuardDecision => ({ allow: false, reason })

export interface ProtectedDirs {
  root: string
  configDir: string
}

// Resolves symlinks in the longest existing prefix, so a link or `..` cannot dodge the check.
// The native realpath also returns the on-disk letter case of that prefix.
function realish(p: string): string {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return p
      rest.unshift(path.basename(cur))
      cur = parent
    }
  }
}

// macOS and Windows filesystems are case-insensitive, so `.HECE` is the same directory as `.hece`
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

const isInside = (dir: string, file: string): boolean => {
  const rel = CASE_INSENSITIVE ? path.relative(dir.toLowerCase(), file.toLowerCase()) : path.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function touchesHeceFiles(input: Record<string, unknown> | undefined, protect: ProtectedDirs): boolean {
  const raw = input?.file_path ?? input?.notebook_path
  if (typeof raw !== 'string' || raw === '') return false
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw
  const target = realish(path.resolve(protect.root, expanded))
  return [path.join(protect.root, '.hece'), protect.configDir].some((d) => isInside(realish(path.resolve(d)), target))
}

export function decideTool(
  flow: FlowState,
  prefs: Prefs,
  tool: { name: string; input?: Record<string, unknown> },
  protect: ProtectedDirs,
): GuardDecision {
  if (!prefs.guards || !EDIT_TOOLS.has(tool.name)) return { allow: true }
  if (touchesHeceFiles(tool.input, protect)) {
    return deny('hece: preferences and flow state are changed by the user, not the agent')
  }
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
// `questions` echoes every option label (including "Continue"), so only `answers` may be read, and only
// the answer to the approval question. Any other shape (such as a string the agent could imitate) yields none.
const normalizeLabel = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')

// The answer to the approval question: the one question whose first option is `Continue`. Other questions in
// the same picker are ignored, and two such questions are ambiguous, so there is no approval answer.
function approvalAnswers(toolResponse: unknown): string[] {
  if (toolResponse === null || typeof toolResponse !== 'object') return []
  const { questions, answers } = toolResponse as { questions?: unknown; answers?: unknown }
  if (!Array.isArray(questions) || answers === null || typeof answers !== 'object') return []
  const approval = questions.filter((q) => {
    const options = (q as { options?: unknown } | null)?.options
    return Array.isArray(options) && normalizeLabel((options[0] as { label?: unknown } | undefined)?.label) === 'continue'
  })
  if (approval.length !== 1) return []
  const text = (approval[0] as { question?: unknown }).question
  if (typeof text !== 'string' || !Object.prototype.hasOwnProperty.call(answers, text)) return []
  const answer = (answers as Record<string, unknown>)[text]
  return (Array.isArray(answer) ? answer : [answer]).map(normalizeLabel)
}

export function pickerApproved(toolResponse: unknown): boolean {
  return approvalAnswers(toolResponse).includes('continue')
}

// Redo follows the same rule as approval, so a check question or an unrelated question offering "Redo" cannot trigger it.
export function pickerRedo(toolResponse: unknown): boolean {
  return approvalAnswers(toolResponse).includes('redo')
}
