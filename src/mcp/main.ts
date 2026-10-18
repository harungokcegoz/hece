import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { resolveRoot } from '../state/paths.js'

export async function runMcp(): Promise<void> {
  const server = createServer({ root: resolveRoot(process.env), env: process.env })
  await server.connect(new StdioServerTransport())
}
