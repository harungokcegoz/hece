import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CLI, tmpProject, testEnv, runCli } from '../helpers.js'
import { TOOL_NAMES } from '../../src/mcp/server.js'

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

  it('runs discuss → plan → slices, with guards enforced across MCP and hooks', async () => {
    const root = tmpProject()
    const c = await connect(root)
    expect((await call(c, 'flow_set_phase', { phase: 'discuss' })).text).toContain('▸ Discussion')
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

    expect(approveAsHuman(root).stdout).toContain('approved slice 1')
    expect((await call(c, 'flow_start_slice', { n: 2 })).text).toContain('▸ 2. Login')
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
})
