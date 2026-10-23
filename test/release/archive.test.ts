import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const version = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }).version

// Opt-in: building the release runs a production install and a full build, so
// normal `npm test` stays offline and fast. Run with HECE_RELEASE_TEST=1.
it.runIf(process.env.HECE_RELEASE_TEST === '1')('the release archive runs CLI, hook and MCP without installing or building', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-release-test-'))
  let client: Client | undefined
  try {
    const output = path.join(work, 'output')
    const built = spawnSync('npm', ['run', 'release:archive', '--', output], { encoding: 'utf8', timeout: 240_000 })
    expect(built.status, built.stdout + built.stderr).toBe(0)
    const archive = path.join(output, `hece-${version}.tgz`)
    expect(fs.existsSync(archive)).toBe(true)

    const unpacked = path.join(work, 'fresh install')
    fs.mkdirSync(unpacked)
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' })
    expect(extracted.status, extracted.stderr).toBe(0)
    const bundle = path.join(unpacked, 'hece')
    const cli = path.join(bundle, 'dist', 'cli.js')
    for (const present of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'skills', 'package.json', 'README.md', 'LICENSE',
      'node_modules/yaml/package.json', 'node_modules/@modelcontextprotocol/sdk/package.json', 'node_modules/zod/package.json']) {
      expect(fs.existsSync(path.join(bundle, present)), present).toBe(true)
    }
    for (const omitted of ['src', 'test', '.git', 'node_modules/vitest', 'node_modules/typescript']) {
      expect(fs.existsSync(path.join(bundle, omitted)), omitted).toBe(false)
    }

    const project = path.join(work, 'project')
    fs.mkdirSync(project)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'CLAUDE_PROJECT_DIR' && key !== 'NODE_PATH') env[key] = value
    }
    env.HECE_ROOT = project
    env.XDG_CONFIG_HOME = path.join(work, 'config')

    const help = spawnSync(process.execPath, [cli, 'help'], { cwd: project, env, encoding: 'utf8' })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('usage: hece')

    const hook = spawnSync(process.execPath, [cli, 'hook'], {
      cwd: project, env, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: project, session_id: 'release-test', source: 'startup' }),
    })
    expect(hook.status, hook.stderr).toBe(0)
    expect(hook.stdout).toBe('')
    expect(hook.stderr).toBe('')
    expect(fs.existsSync(path.join(project, '.hece'))).toBe(false)

    client = new Client({ name: 'hece-release-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: project, env }))
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toContain('flow_set_phase')
    const flow = await client.callTool({ name: 'flow_set_phase', arguments: { phase: 'discuss' } })
    expect(flow.isError).not.toBe(true)
    expect(fs.existsSync(path.join(project, '.hece', 'state', 'flow.json'))).toBe(true)
  } finally {
    await client?.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
}, 300_000)
