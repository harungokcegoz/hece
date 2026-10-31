import type { Prefs } from './schema.js'

export interface Vendor {
  label: string
  bin: string
  supported: boolean
  models: readonly string[]
  efforts: readonly string[]
}

export const VENDORS: Record<Prefs['agent'], Vendor> = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    supported: true,
    models: ['opus', 'sonnet', 'haiku', 'fable'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: { label: 'Codex', bin: 'codex', supported: false, models: [], efforts: [] },
  gemini: { label: 'Gemini CLI', bin: 'gemini', supported: false, models: [], efforts: [] },
  opencode: { label: 'OpenCode', bin: 'opencode', supported: false, models: [], efforts: [] },
}
