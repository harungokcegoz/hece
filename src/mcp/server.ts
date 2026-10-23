import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { statePaths } from '../state/paths.js'
import { withDirLock } from '../util/dirlock.js'
import { readJson, writeJsonAtomic, appendEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import * as flow from '../flow/flow.js'
import { renderFlow } from '../flow/render.js'
import { loadPrefs } from '../prefs/load.js'

export const TOOL_NAMES = [
  'flow_get',
  'flow_set_phase',
  'flow_add_decision',
  'flow_set_plan',
  'flow_start_slice',
  'flow_finish_slice',
  'flow_check_question',
  'flow_report_review',
  'prefs_get',
  'activity_note',
] as const

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

// The agent writes this text and the panel prints it to the user's terminal: no control or bidi characters,
// and nothing that looks like a key.
export function cleanNote(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[hidden]')
    .trim()
}

export function createServer(opts: { root: string; env: NodeJS.ProcessEnv; now?: () => number; lockTimeoutMs?: number }): McpServer {
  const now = opts.now ?? Date.now
  const paths = statePaths(opts.root)
  const server = new McpServer({ name: 'hece', version: '0.1.0' })
  const prefs = () => loadPrefs(opts.env, opts.root)
  const load = () => readJson<FlowState>(paths.flow, emptyFlow())

  // keep runtime state out of the user's git history; .hece/preferences.yaml stays committable
  const ensureGitignore = () => {
    const file = path.join(paths.heceDir, '.gitignore')
    if (!fs.existsSync(file)) {
      fs.mkdirSync(paths.heceDir, { recursive: true })
      fs.writeFileSync(file, 'state/\n')
      return
    }
    const text = fs.readFileSync(file, 'utf8')
    const ignored = text.split(/\r?\n/).some((line) => ['state', 'state/', '/state', '/state/'].includes(line.trim()))
    if (!ignored) fs.appendFileSync(file, (text === '' || text.endsWith('\n') ? '' : '\n') + 'state/\n')
  }

  // Read, change and write flow.json under one lock next to it (the hook takes the same one), so neither side
  // overwrites the other's update. A lock that stays busy is reported to the agent, never skipped silently.
  const mutate = (tool: string, fn: (s: FlowState) => FlowState, extra: Record<string, unknown> = {}): ToolResult => {
    try {
      fs.mkdirSync(paths.stateDir, { recursive: true })
      const r = withDirLock(paths.flowLock, () => {
        const next = fn(load())
        ensureGitignore()
        writeJsonAtomic(paths.flow, next)
        appendEvent(paths.events, { at: now(), event: 'flow', tool, ...extra })
        return next
      }, { timeoutMs: opts.lockTimeoutMs })
      if (!r.ran) return fail('hece: flow.json is busy (another hece process is writing it); nothing was changed, try again')
      return ok(renderFlow(r.value, { guards: prefs().prefs.guards }))
    } catch (err) {
      return fail((err as Error).message)
    }
  }

  server.registerTool(
    'flow_get',
    { description: 'Read the current hece flow (phase, decisions, plan, slices, review) and recorded sessions.', inputSchema: {} },
    async () => {
      try {
        const s = load()
        const sessions = readJson(paths.sessions, [])
        return ok(`${renderFlow(s, { guards: prefs().prefs.guards })}\n\n${JSON.stringify({ flow: s, sessions }, null, 2)}`)
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  )

  server.registerTool(
    'flow_set_phase',
    {
      description: 'Move the hece flow to a phase. Calling it with "discuss" starts a fresh flow (earlier decisions and plan are cleared) and creates .hece/state in the project.',
      inputSchema: { phase: z.enum(['discuss', 'plan', 'build', 'review', 'recap', 'done']) },
    },
    async ({ phase }) => mutate('flow_set_phase', (s) => flow.setPhase(s, phase, { guards: prefs().prefs.guards }, now()), { phase }),
  )

  server.registerTool(
    'flow_add_decision',
    {
      description: 'Record a decision settled with the user during discussion.',
      inputSchema: { title: z.string().min(1), choice: z.string().min(1), why: z.string().min(1) },
    },
    async (d) => mutate('flow_add_decision', (s) => flow.addDecision(s, d, now()), { title: d.title }),
  )

  server.registerTool(
    'flow_set_plan',
    {
      description:
        'Set or change the plan as ordered slices. The user must approve it before code edits; a changed plan needs approval again.',
      inputSchema: {
        slices: z
          .array(
            z.object({
              title: z.string().min(1),
              files: z.array(z.string()),
              kind: z.enum(['routine', 'teaching']),
              model: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ slices }) => mutate('flow_set_plan', (s) => flow.setPlan(s, slices, { guards: prefs().prefs.guards }, now()), { slices: slices.length }),
  )

  server.registerTool(
    'flow_start_slice',
    { description: 'Start working on slice n (1-based).', inputSchema: { n: z.number().int().min(1) } },
    async ({ n }) => mutate('flow_start_slice', (s) => flow.startSlice(s, n, { guards: prefs().prefs.guards }, now()), { n }),
  )

  server.registerTool(
    'flow_finish_slice',
    {
      description: 'Finish slice n and stop for the user. summary: what changed. connects_to: how it connects to existing code.',
      inputSchema: { n: z.number().int().min(1), summary: z.string().min(1), connects_to: z.string().min(1) },
    },
    async ({ n, summary, connects_to }) =>
      mutate('flow_finish_slice', (s) => flow.finishSlice(s, n, { summary, connectsTo: connects_to }, now()), { n }),
  )

  server.registerTool(
    'flow_check_question',
    {
      description:
        'Call right before you ask the user a check question at a slice stop. Their next answer is then read as the answer to it and never as approval.',
      inputSchema: {},
    },
    async () => mutate('flow_check_question', (s) => flow.markCheckPending(s, now())),
  )

  server.registerTool(
    'flow_report_review',
    {
      description: 'Record the final review counts and enter the review phase.',
      inputSchema: { important: z.number().int().min(0), minor: z.number().int().min(0) },
    },
    async (r) => mutate('flow_report_review', (s) => flow.reportReview(s, r, now()), r),
  )

  server.registerTool(
    'activity_note',
    {
      description:
        "During a hece flow, tell the user in one plain sentence what you're about to do and why (shown in hece's Activity panel). No code, no file contents. Outside a flow it does nothing.",
      inputSchema: { text: z.string().min(1).max(200) },
    },
    async ({ text }) => {
      try {
        // a note is passive: it never asks the agent to start a flow, and writes nothing without one
        if (!fs.existsSync(paths.flow)) return ok('no hece flow; nothing recorded')
        const s = load()
        const clean = cleanNote(text)
        if (!clean) return ok('empty note; nothing recorded')
        appendEvent(paths.events, { at: now(), event: 'note', text: clean, slice: s.currentSlice })
        return ok('noted')
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  )

  server.registerTool(
    'prefs_get',
    { description: "Read the user's effective hece preferences (global merged with project). Follow them exactly.", inputSchema: {} },
    async () => ok(JSON.stringify(prefs(), null, 2)),
  )

  return server
}
