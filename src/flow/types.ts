export type Phase = 'idle' | 'discuss' | 'plan' | 'build' | 'review' | 'recap' | 'done'
export const PHASES: readonly Phase[] = ['idle', 'discuss', 'plan', 'build', 'review', 'recap', 'done']
export type SliceKind = 'routine' | 'teaching'
export type SliceStatus = 'todo' | 'working' | 'stopped' | 'approved'

export interface Decision {
  title: string
  choice: string
  why: string
  at: number
}

export interface Slice {
  n: number
  title: string
  files: string[]
  kind: SliceKind
  model?: string
  status: SliceStatus
  summary?: string
  connectsTo?: string
  // set only by the human-facing hook (typed "redo" or picked Redo); lets a stopped slice restart
  redoRequested?: boolean
}

export interface Plan {
  slices: Slice[]
  approved: boolean
  changed: boolean
}

export interface ReviewSummary {
  important: number
  minor: number
  at: number
}

export interface FlowState {
  version: 1
  phase: Phase
  /** Absent in older state; only this session may approve or request a redo. */
  mainSessionId?: string | null
  /** Set by flow_check_question; the user's next answer in the main session is the check answer, never an approval. */
  checkPending?: boolean
  decisions: Decision[]
  plan: Plan | null
  currentSlice: number | null
  review: ReviewSummary | null
  updatedAt: number
}

export interface SliceInput {
  title: string
  files: string[]
  kind: SliceKind
  model?: string
}

export function emptyFlow(): FlowState {
  return { version: 1, phase: 'idle', mainSessionId: null, decisions: [], plan: null, currentSlice: null, review: null, updatedAt: 0 }
}
