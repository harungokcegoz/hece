import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { emptyFlow } from '../../src/flow/types.js'
import { CLI, tmpProject, testEnv, runCli, seedFlow } from '../helpers.js'
import { TOOL_NAMES } from '../../src/mcp/server.js'
import { readEvents, readJson } from '../../src/state/store.js'
import { statePaths } from '../../src/state/paths.js'

let client: Client | undefined
afterEach(async () => {
  await client?.close()
  client = undefined
})

async function connect(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', CLI, 'mcp'],
    env: testEnv(root),
  })
  client = new Client({ name: 'hece-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean }
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const r = (await c.callTool({ name, arguments: args })) as CallResult
    return { text: r.content.map((x) => x.text ?? '').join(''), isError: r.isError === true }
  } catch (err) {
    // some SDK versions throw on schema validation instead of returning isError
    return { text: (err as Error).message, isError: true }
  }
}
const approveAsHuman = (root: string) =>
  runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'continue', session_id: 's' }) })

describe('hece mcp', () => {
  it('lists exactly the hece tools, with no approve tool', async () => {
    const c = await connect(tmpProject())
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([...TOOL_NAMES].sort())
    expect(names.some((n) => n.includes('approve'))).toBe(false)
  })

  it.each([
    ['without state/', 'notes/\n', 'notes/\nstate/\n'],
    ['without a trailing newline', 'notes/', 'notes/\nstate/\n'],
    ['empty', '', 'state/\n'],
    ['with state/ already', 'notes/\nstate/\n', 'notes/\nstate/\n'],
    ['with /state already', '/state\nnotes/\n', '/state\nnotes/\n'],
    ['with state/ only in a comment', '# state/\n', '# state/\nstate/\n'],
  ])('keeps state/ ignored when .hece/.gitignore exists %s', async (_name, before, after) => {
    const root = tmpProject()
    fs.mkdirSync(path.join(root, '.hece'), { recursive: true })
    const file = path.join(root, '.hece', '.gitignore')
    fs.writeFileSync(file, before)
    const c = await connect(root)
    expect((await call(c, 'flow_set_phase', { phase: 'discuss' })).isError).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(after)
  })

  it('runs discuss → plan → slices, with guards enforced across MCP and hooks', async () => {
    const root = tmpProject()
    const c = await connect(root)
    const start = runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }) })
    expect(start.status).toBe(0)
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
    const discussion = await call(c, 'flow_set_phase', { phase: 'discuss' })
    expect(discussion.text).toContain('▸ Discussion')
    expect(discussion.isError).toBe(false)
    const created = runCli(['hook'], { root, stdin: JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'mcp__plugin_hece_hece__flow_set_phase',
      tool_input: { phase: 'discuss' }, tool_response: [{ type: 'text', text: discussion.text }],
    }) })
    expect(created.status).toBe(0)
    expect(readJson<{ mainSessionId?: string }>(statePaths(root).flow, {}).mainSessionId).toBe('s')
    expect(fs.readFileSync(path.join(root, '.hece', '.gitignore'), 'utf8')).toBe('state/\n')
    expect((await call(c, 'flow_add_decision', { title: 'Auth', choice: 'JWT', why: 'stateless' })).text).toContain('(1 decision)')
    const plan = await call(c, 'flow_set_plan', {
      slices: [
        { title: 'Token model', files: ['src/token.ts'], kind: 'teaching' },
        { title: 'Login', files: ['src/login.ts'], kind: 'routine', model: 'sonnet' },
      ],
    })
    expect(plan.text).toContain('waiting for approval')

    const early = await call(c, 'flow_start_slice', { n: 1 })
    expect(early).toEqual({ text: 'hece: the plan is waiting for the user to approve it', isError: true })

    expect(approveAsHuman(root).stdout).toContain('approved the plan')
    expect((await call(c, 'flow_start_slice', { n: 1 })).text).toContain('▸ 1. Token model')
    expect((await call(c, 'flow_finish_slice', { n: 1, summary: 'Token type', connects_to: 'login uses it' })).text)
      .toContain('■ 1. Token model  ← waiting for you')
    expect(await call(c, 'flow_start_slice', { n: 2 })).toEqual({ text: 'hece: slice 1 is waiting for the user', isError: true })
    // the agent cannot end the stop by calling other tools either
    expect(await call(c, 'flow_start_slice', { n: 1 })).toEqual({ text: 'hece: slice 1 is waiting for the user', isError: true })
    expect(await call(c, 'flow_set_phase', { phase: 'done' })).toEqual({ text: 'hece: slice 1 is waiting for the user', isError: true })
    expect((await call(c, 'flow_set_plan', { slices: [{ title: 'Other', files: [], kind: 'routine' }] })).text)
      .toBe('hece: slice 1 is waiting for the user; propose the plan change after they respond')

    expect(approveAsHuman(root).stdout).toContain('approved slice 1')
    expect((await call(c, 'flow_start_slice', { n: 2 })).text).toContain('▸ 2. Login')
  })

  it('flow_check_question marks a check question as pending only while a slice waits', async () => {
    const root = tmpProject()
    const c = await connect(root)
    await call(c, 'flow_set_phase', { phase: 'discuss' })
    runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }) })
    await call(c, 'flow_set_plan', { slices: [{ title: 'A', files: [], kind: 'teaching' }] })
    expect((await call(c, 'flow_check_question')).isError).toBe(true)
    expect(approveAsHuman(root).stdout).toContain('approved the plan')
    await call(c, 'flow_start_slice', { n: 1 })
    await call(c, 'flow_finish_slice', { n: 1, summary: 's', connects_to: 'c' })
    expect((await call(c, 'flow_check_question')).isError).toBe(false)
    expect(readJson<{ checkPending?: boolean }>(statePaths(root).flow, {}).checkPending).toBe(true)
  })

  it('rejects invalid input via the schema', async () => {
    const c = await connect(tmpProject())
    expect((await call(c, 'flow_set_phase', { phase: 'ship' })).isError).toBe(true)
    expect((await call(c, 'flow_start_slice', { n: 0 })).isError).toBe(true)
  })

  it('returns effective prefs and errors', async () => {
    const c = await connect(tmpProject())
    const r = JSON.parse((await call(c, 'prefs_get')).text)
    expect(r.prefs.preset).toBe('involved')
    expect(r.errors).toEqual([])
  })

  it('flow_get includes recorded sessions', async () => {
    const root = tmpProject()
    const c = await connect(root)
    await call(c, 'flow_set_phase', { phase: 'discuss' })
    runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup' }) })
    expect((await call(c, 'flow_get')).text).toContain('"sessionId": "abc"')
  })

  it('activity_note records a plain-language note under the current slice', async () => {
    const root = tmpProject()
    const c = await connect(root)
    expect(await call(c, 'activity_note', { text: 'reading the code' })).toEqual({ text: 'no hece flow; nothing recorded', isError: false })
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
    await call(c, 'flow_set_phase', { phase: 'discuss' })
    expect((await call(c, 'activity_note', { text: '  checking   how login works ' })).text).toBe('noted')
    const notes = readEvents(statePaths(root).events).filter((e) => e.event === 'note')
    expect(notes).toEqual([expect.objectContaining({ event: 'note', text: 'checking how login works', slice: null })])
  })

  it('activity_note tags the working slice, or none while several work', async () => {
    const root = tmpProject()
    const c = await connect(root)
    const sl = (n: number, status: string) => ({ n, title: 't', files: [], kind: 'routine', status })
    const base = { ...emptyFlow(), phase: 'build', currentSlice: 1 }
    const seed = (statuses: string[]) => seedFlow(root, { ...base, plan: { approved: true, changed: false, mode: 'parallel', slices: statuses.map((s, i) => sl(i + 1, s)) } } as never)
    seed(['working', 'working'])
    await call(c, 'activity_note', { text: 'a' })
    seed(['todo', 'working'])
    await call(c, 'activity_note', { text: 'b' })
    expect(readEvents(statePaths(root).events).filter((e) => e.event === 'note').map((e) => e.slice)).toEqual([null, 2])
  })

  it('activity_note never tells the agent to start a flow', async () => {
    const c = await connect(tmpProject())
    const tool = (await c.listTools()).tools.find((t) => t.name === 'activity_note')!
    expect(tool.description).toBe(
      "During a hece flow, tell the user in one plain sentence what you're about to do and why (shown in hece's Activity panel). No code, no file contents. Outside a flow it does nothing.",
    )
  })

  it('activity_note cleans the text before storing it', async () => {
    const root = tmpProject()
    const c = await connect(root)
    await call(c, 'flow_set_phase', { phase: 'discuss' })
    const key = 'sk_live_' + 'AbCdEfGh12345678'.repeat(2)
    const text = `reading\u0007 the\u202E code\u0085 now\u2066\u2069\n\tand key ${key} done`
    expect((await call(c, 'activity_note', { text })).text).toBe('noted')
    const notes = readEvents(statePaths(root).events).filter((e) => e.event === 'note')
    expect(notes[0].text).toBe('reading the code now and key [hidden] done')
  })
})
