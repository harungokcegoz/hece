import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HookPayload, handleHook } from './handle.js'
import { resolveRoot, statePaths } from '../state/paths.js'
import { appendEvent, writeJsonAtomic } from '../state/store.js'
import { loadPrefs } from '../prefs/load.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// HECE_CAPTURE=1 saves each payload (home dir replaced by ~) for building test fixtures.
function capture(root: string, text: string, p: HookPayload): void {
  const name = [p.hook_event_name, p.tool_name].filter(Boolean).join('-') || 'unknown'
  const sanitized = JSON.parse(text.split(os.homedir()).join('~'))
  writeJsonAtomic(path.join(statePaths(root).captures, `${name}.json`), sanitized)
}

export async function runHook(): Promise<void> {
  const text = await readStdin()
  let payload: HookPayload = {}
  try {
    payload = JSON.parse(text) as HookPayload
  } catch {
    // handled below as hook_error
  }
  const root = resolveRoot(process.env, payload.cwd)
  try {
    if (typeof payload.hook_event_name !== 'string') throw new Error('hook received no valid JSON payload')
    if (process.env.HECE_CAPTURE === '1') capture(root, text, payload)
    const { prefs, errors } = loadPrefs(process.env, root)
    const res = handleHook(payload, { root, prefs, prefsErrors: errors, now: Date.now() })
    if (res.stdout) process.stdout.write(res.stdout)
  } catch (err) {
    const paths = statePaths(root)
    if (fs.existsSync(paths.flow)) {
      try {
        appendEvent(paths.events, { at: Date.now(), event: 'hook_error', message: (err as Error).message })
      } catch {
        // nothing more we can do without breaking the agent
      }
    }
    process.stderr.write(`hece hook: ${(err as Error).message}\n`)
  }
  process.exitCode = 0
}
