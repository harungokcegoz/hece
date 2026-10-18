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
  return { version: 1, phase: 'idle', decisions: [], plan: null, currentSlice: null, review: null, updatedAt: 0 }
}
