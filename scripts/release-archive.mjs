#!/usr/bin/env node
// Builds hece-<version>.tgz: the compiled CLI plus production node_modules, so
// an unpacked copy runs with no install or build. Usage:
//   npm run release:archive [-- <output-dir>]   (default: ./release)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(process.argv[2] ?? path.join(root, 'release'))
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal})`)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-archive-'))
try {
  run('npm', ['run', 'build'], root)
  const bundle = path.join(work, 'hece')
  fs.mkdirSync(bundle)
  for (const entry of ['dist', 'skills', 'hooks', '.claude-plugin', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
    fs.cpSync(path.join(root, entry), path.join(bundle, entry), { recursive: true })
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], bundle)
  fs.chmodSync(path.join(bundle, 'dist', 'cli.js'), 0o755)
  fs.mkdirSync(output, { recursive: true })
  const archive = path.join(output, `hece-${version}.tgz`)
  fs.rmSync(archive, { force: true })
  run('tar', ['-czf', archive, '-C', work, 'hece'], work)
  console.log(`${archive} (${(fs.statSync(archive).size / 1024).toFixed(0)} KiB)`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
