import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { resolvePrefs } from './schema.js'
import type { Prefs } from './schema.js'

export function prefsFiles(env: NodeJS.ProcessEnv, root: string, home: string = os.homedir()) {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return {
    global: path.join(configHome, 'hece', 'preferences.yaml'),
    project: path.join(root, '.hece', 'preferences.yaml'),
  }
}

function readYaml(file: string): { raw: unknown; error?: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { raw: undefined }
  }
  try {
    return { raw: YAML.parse(text) }
  } catch (err) {
    return { raw: undefined, error: `${file}: invalid YAML (${(err as Error).message.split('\n')[0]})` }
  }
}

export function loadPrefs(env: NodeJS.ProcessEnv, root: string, home?: string): { prefs: Prefs; errors: string[] } {
  const files = prefsFiles(env, root, home)
  const g = readYaml(files.global)
  const p = readYaml(files.project)
  const { prefs, errors } = resolvePrefs([
    { raw: g.raw, source: files.global },
    { raw: p.raw, source: files.project },
  ])
  return { prefs, errors: [g.error, p.error, ...errors].filter((x): x is string => Boolean(x)) }
}
