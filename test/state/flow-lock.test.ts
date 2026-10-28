import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CLI, tmpProject, seedFlow, testEnv } from '../helpers.js'
import { handleHook } from '../../src/hooks/handle.js'
import { createServer } from '../../src/mcp/server.js'
import { statePaths } from '../../src/state/paths.js'
import { readJson, readEvents, writeJsonAtomic } from '../../src/state/store.js'
import { emptyFlow, FlowState } from '../../src/flow/types.js'
import { setPlan, addDecision } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'

let root: string
let lock: string
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }], { guards: true }, 1)
const flow = () => readJson<FlowState>(statePaths(root).flow, emptyFlow())
const events = () => readEvents(statePaths(root).events)
const typed = { hook_event_name: 'UserPromptSubmit', session_id: 'main', prompt: 'continue' }
const ctx = (extra: Record<string, unknown> = {}) => ({
  root, configDir: path.join(root, '.config-test', 'hece'), prefs: presetDefaults('involved'), prefsErrors: [] as string[], now: 100, ...extra,
})
/** a lock held by this (live) process, as another writer would hold it */
const holdLock = () => {
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:test`)
}
const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25))
  expect(ok()).toBe(true)
}

beforeEach(() => {
  root = tmpProject()
  lock = statePaths(root).flowLock
})
afterEach(() => fs.rmSync(lock, { recursive: true, force: true }))

describe('flow.json lock', () => {
  it('a hook write that started before an MCP write lands does not lose it', async () => {
    seedFlow(root, { ...plan, mainSessionId: 'main' })
    holdLock() // the "MCP server" is mid-update
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'hook'], { env: testEnv(root), stdio: ['pipe', 'ignore', 'ignore'] })
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.stdin.end(JSON.stringify(typed))
    // the hook has read flow.json and is now waiting for the lock: setIdle runs after the read, before the approval
    await waitFor(() => fs.existsSync(statePaths(root).agent))
    writeJsonAtomic(statePaths(root).flow, addDecision({ ...plan, mainSessionId: 'main' }, { title: 'T', choice: 'c', why: 'w' }, 5))
    fs.rmSync(lock, { recursive: true })
    expect(await exited).toBe(0)
    expect(flow().plan!.approved).toBe(true)
    expect(flow().decisions).toHaveLength(1)
  })

  it('the hook says so and exits normally when the lock stays busy; the flow is untouched', () => {
    seedFlow(root, { ...plan, mainSessionId: 'main' })
    holdLock()
    const r = handleHook(typed, ctx({ lockTimeoutMs: 80 }))
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/could not record.*approv/i)
    expect(flow().plan!.approved).toBe(false)
    expect(events().map((e) => e.event)).toContain('hook_error')
    expect(events().map((e) => e.event)).not.toContain('approved')
  })

  it('the hook says the mode was not recorded when the lock stays busy', () => {
    seedFlow(root, { ...plan, mainSessionId: 'main', plan: { ...plan.plan!, approved: true } })
    holdLock()
    const pick = { hook_event_name: 'PostToolUse', session_id: 'main', tool_name: 'AskUserQuestion', tool_response: { questions: [{ question: 'M?', header: 'h', options: [{ label: 'One by one', description: '' }, { label: 'Parallel', description: '' }], multiSelect: false }], answers: { 'M?': 'Parallel' } } }
    const r = handleHook(pick, ctx({ lockTimeoutMs: 80 }))
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/could not record the mode/i)
    expect(flow().plan!.mode).toBeUndefined()
  })

  it('does not change what an edit guard decides when the lock is busy', () => {
    seedFlow(root, plan)
    holdLock()
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts' } }, ctx({ lockTimeoutMs: 80 }))
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('writes no lock in a project without a flow', () => {
    handleHook(typed, ctx({ lockTimeoutMs: 80 }))
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
  })

  it('releases the lock after each hook write', () => {
    seedFlow(root, { ...plan, mainSessionId: 'main' })
    handleHook(typed, ctx())
    expect(fs.existsSync(lock)).toBe(false)
    expect(flow().plan!.approved).toBe(true)
  })

  async function connect(extra: { lockTimeoutMs?: number } = {}): Promise<Client> {
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createServer({ root, env: testEnv(root), ...extra }).connect(a)
    const c = new Client({ name: 't', version: '0' })
    await c.connect(b)
    return c
  }

  it('MCP mutate returns an error the agent sees when the lock stays busy, and writes nothing', async () => {
    seedFlow(root, plan)
    holdLock()
    const c = await connect({ lockTimeoutMs: 80 })
    const r = (await c.callTool({ name: 'flow_add_decision', arguments: { title: 't', choice: 'c', why: 'w' } })) as { isError?: boolean; content: { text: string }[] }
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/busy/i)
    expect(flow().decisions).toHaveLength(0)
  })

  it('MCP mutate applies to what is on disk, not to an older read', async () => {
    seedFlow(root, plan)
    const c = await connect()
    writeJsonAtomic(statePaths(root).flow, { ...plan, mainSessionId: 'main' })
    const r = (await c.callTool({ name: 'flow_add_decision', arguments: { title: 't', choice: 'c', why: 'w' } })) as { isError?: boolean }
    expect(r.isError).toBeFalsy()
    expect(flow().mainSessionId).toBe('main')
    expect(flow().decisions).toHaveLength(1)
    expect(fs.existsSync(lock)).toBe(false)
  })
})
