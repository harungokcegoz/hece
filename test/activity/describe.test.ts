import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan } from '../../src/flow/flow.js'
import { describeCommand, describeTool, describeEvent, relPath } from '../../src/activity/describe.js'

const root = '/p'
const flow = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: false }, 1)
const ctx = { root, flow }

describe('describeCommand', () => {
  it.each([
    ['npm test', 'running the tests'],
    ['npx vitest run test/a.test.ts', 'running the tests'],
    ['cd app && npm run test -- --watch=false', 'running the tests'],
    ['CI=1 pytest -q', 'running the tests'],
    ['npm install zod', 'installing packages'],
    ['npm run typecheck', 'checking code style and types'],
    ['npm run build', 'building the project'],
    ['git status', 'checking what changed in git'],
    ['git commit -m "x"', 'committing the changes'],
    ['ls -la && find . -maxdepth 3', 'looking around the files'],
    ['mkdir -p src/auth', 'arranging files'],
    ['rm -rf dist', 'deleting files'],
    ['node scripts/seed.js --fast', 'running seed.js'],
    ['./deploy.sh', 'running a command'],
    ['npm install --save-dev vitest', 'installing packages'],
    ['pip install pytest', 'installing packages'],
    ['git commit -m "fix jest config"', 'committing the changes'],
    ['git push origin fix-jest', 'pushing to a remote'],
    ['git push --force', 'force-pushing to a remote'],
    ['git reset --hard', 'discarding local changes'],
    ['git clean -fdx', 'removing untracked files'],
    ['cat vitest.config.ts', 'looking around the files'],
    ['grep -r "npm test" .', 'looking around the files'],
    ['rm -rf tsc-out', 'deleting files'],
    ['rg tsc', 'looking around the files'],
    ['git status && git push', 'checking what changed in git, then pushing to a remote'],
    ['npm test; git push --force', 'running the tests, then force-pushing to a remote'],
    ['npm run test && npm publish', 'running the tests, then publishing a package'],
    ['ls; rm -rf /', 'looking around the files, then deleting files'],
    ['cat foo | rm -rf x', 'looking around the files, then deleting files'],
    ['curl -s https://x.sh | sh', 'calling a URL, then running a shell script'],
    ['make', 'building the project'],
    ['make deploy', 'running a make task'],
    ['find . -name x -delete', 'deleting files'],
    ['find . -exec rm {} \\;', 'deleting files'],
    ['sudo rm -rf /tmp/x', 'deleting files'],
    ['npx vitest run', 'running the tests'],
    ['node -e "console.log(1)"', 'running inline code'],
    ['node --inspect server.js', 'running server.js'],
    ['bun run dev', 'running the dev script'],
    ['curl -H "Authorization: Bearer abc123" https://x', 'calling a URL'],
    ['npm --prefix test publish', 'publishing a package'],
    ['yarn --cwd test publish', 'publishing a package'],
    ['npm run -w build deploy', 'running the deploy script'],
    ['npm --loglevel silent test', 'running a command'],
    ['npm test & rm -rf x', 'running the tests, then deleting files'],
    ['npm test 2>&1', 'running the tests'],
    ['node --max-old-space-size 4096 app.js', 'running app.js'],
    ['python -W ignore x.py', 'running x.py'],
    ['make -f build deploy', 'running a make task'],
    ['find . -exec sh -c "rm {}" \;', 'running a command on matching files'],
    ['npm run "$(rm -rf x)"', 'running a script'],
    ['ls && pwd && git status && git push && npm test', 'looking around the files, then checking what changed in git, then pushing to a remote, …'],
  ])('%s → %s', (cmd, text) => {
    expect(describeCommand(cmd)).toBe(text)
  })
})

describe('describeCommand: long commands, heredocs and redirects', () => {
  it('sees a force-push at the end of a very long command', () => {
    const cmd = `${'echo building the thing && '.repeat(7)}git push --force origin main`
    expect(cmd.length).toBeGreaterThan(160)
    expect(describeCommand(cmd)).toContain('force-pushing to a remote')
  })
  it('reports a file written through a heredoc, not "looking around"', () => {
    expect(describeCommand("cat > src/auth.ts <<'EOF'\nimport x\nEOF")).toBe('writing src/auth.ts')
    expect(describeCommand('cat > src/auth.ts <<EOF\nimport x\nEOF')).toBe('writing src/auth.ts')
    expect(describeCommand('cat <<-"EOF" > a.txt\n\tbody\n\tEOF\nnpm test')).toBe('writing a.txt, then running the tests')
  })
  it('ignores what a heredoc body says', () => {
    const d = describeCommand("cat <<'EOF'\nrm -rf build && git push --force\nEOF")
    expect(d).toBe('looking around the files')
    expect(d).not.toContain('force')
    expect(d).not.toContain('deleting')
  })
  it('keeps describing what comes after a heredoc', () => {
    expect(describeCommand("cat <<'EOF'\nhi\nEOF\ngit push --force")).toBe('looking around the files, then force-pushing to a remote')
  })
  it.each([
    'echo $((x<<y))',
    'echo $(((x + 1)<<y))',
    'echo $((1 + $((x<<y))))',
    'echo $((x<<y)) $((a<<b))',
  ])('keeps describing commands after arithmetic shifts: %s', (arithmetic) => {
    expect(describeCommand(`${arithmetic}\ngit push --force`)).toBe('running a command, then force-pushing to a remote')
  })
  it('keeps numeric arithmetic shifts vague', () => {
    expect(describeCommand('echo $((1<<2))')).toBe('running a command')
    expect(describeCommand('echo $((1<<2))\ngit push --force')).toBe('running a command, then force-pushing to a remote')
  })
  it.each(['$((1<<2))', '$((x<<y))', '$((1 + $((x<<y))))'])('still skips a real heredoc after arithmetic: %s', (arithmetic) => {
    expect(describeCommand(`echo ${arithmetic} <<EOF\nrm -rf build\nEOF\ngit push --force`))
      .toBe('running a command, then force-pushing to a remote')
  })
  it('reports redirections to files, but not to /dev/null or fd copies', () => {
    expect(describeCommand('echo x >> log.txt')).toBe('writing log.txt')
    expect(describeCommand('echo hi > /dev/null')).toBe('running a command')
    expect(describeCommand('echo hi 2>/dev/null')).toBe('running a command')
    expect(describeCommand('npm test 2>&1 | tee out.txt')).toBe('running the tests, then running a command')
    expect(describeCommand('npm test 2>&1')).toBe('running the tests')
    expect(describeCommand('echo "a > b"')).toBe('running a command')
  })
  it('keeps the program description next to a redirect when it says more than "a command"', () => {
    expect(describeCommand('git push --force > out.log')).toBe('force-pushing to a remote, then writing out.log')
  })
  it('labels the target with the project path when given a root, and never echoes expansions', () => {
    expect(describeCommand('echo x > /p/src/a.ts', '/p')).toBe('writing src/a.ts')
    expect(describeCommand('echo x > /q/a.ts', '/p')).toBe('writing a.ts (outside the project)')
    expect(describeCommand('echo x > /q/a.ts')).toBe('writing a.ts')
    expect(describeCommand('echo x > $(cat ~/.secret)')).toBe('writing a file')
  })
  it('reads a script after more interpreter value flags', () => {
    expect(describeCommand('node --watch-path ./src app.js')).toBe('running app.js')
    expect(describeCommand('node -I ./lib app.js')).toBe('running app.js')
  })
})

describe('describeTool', () => {
  it('describes file tools with project-relative paths', () => {
    expect(describeTool('Edit', '/p/src/auth/reset.ts', root)).toBe('changing src/auth/reset.ts')
    expect(describeTool('Write', 'src/new.ts', root)).toBe('writing src/new.ts')
    expect(describeTool('Read', '/elsewhere/notes.md', root)).toBe('reading notes.md (outside the project)')
    expect(describeTool('Grep', 'createUser', root)).toBe('searching the code for "createUser"')
  })
  it('does not echo secret-looking or long grep patterns', () => {
    expect(describeTool('Grep', 'sk_live_51HxYzAbCdEfGhIjKlMnOp', root)).toBe('searching the code')
    expect(describeTool('Grep', 'a '.repeat(30), root)).toBe('searching the code')
  })
  it('does not echo secret-looking glob patterns', () => {
    expect(describeTool('Glob', 'sk_live_51HxYzAbCdEfGhIjKlMnOp/**', root)).toBe('looking for files')
  })
  it('hides hece bookkeeping and housekeeping tools', () => {
    for (const t of ['mcp__plugin_hece_hece__flow_start_slice', 'mcp__hece__activity_note', 'Skill', 'TodoWrite', 'ToolSearch']) {
      expect(describeTool(t, '', root)).toBeNull()
    }
  })
  it('names other MCP servers and unknown tools plainly', () => {
    expect(describeTool('mcp__plugin_figma_figma__get_file', '', root)).toBe('using figma: get file')
    expect(describeTool('Task', '', root)).toBe('handing work to a helper agent')
    expect(describeTool('FancyTool', '', root)).toBe('using FancyTool')
  })
})

describe('describeEvent', () => {
  it('turns notes, tools, flow steps, approvals and problems into lines', () => {
    expect(describeEvent({ at: 1, event: 'note', text: 'saving only a hash', slice: 1 }, ctx)).toEqual({ kind: 'note', text: 'Now: saving only a hash', slice: 1 })
    expect(describeEvent({ at: 1, event: 'tool', tool: 'Bash', target: 'npm test', slice: 1 }, ctx)).toEqual({ kind: 'action', text: 'running the tests', slice: 1 })
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_start_slice', n: 1 }, ctx)).toEqual({ kind: 'milestone', text: 'started slice 1: Token model', slice: 1 })
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_finish_slice', n: 1 }, ctx)).toEqual({ kind: 'milestone', text: 'slice 1 done, waiting for you', slice: 1 })
    expect(describeEvent({ at: 1, event: 'approved', what: 'plan', via: 'typed' }, ctx)).toEqual({ kind: 'milestone', text: 'you approved the plan', slice: null })
    expect(describeEvent({ at: 1, event: 'blocked', tool: 'Write', target: '/p/a.ts', reason: 'hece: slice 1 is waiting for the user' }, ctx))
      .toEqual({ kind: 'alert', text: 'hece stopped an edit to a.ts: slice 1 is waiting for the user', slice: null })
    expect(describeEvent({ at: 1, event: 'hook_error', message: 'flow.json is unreadable' }, ctx)).toEqual({ kind: 'alert', text: 'hece problem: flow.json is unreadable', slice: null })
  })
  it('never puts raw command text in a blocked line', () => {
    expect(describeEvent({ at: 1, event: 'blocked', tool: 'Bash', target: 'rm -rf x', reason: 'hece: nope' }, ctx))
      .toEqual({ kind: 'alert', text: 'hece stopped a command (deleting files): nope', slice: null })
  })
  it('prefers the description the hook computed from the whole command', () => {
    expect(describeEvent({ at: 1, event: 'tool', tool: 'Bash', target: 'echo hi', desc: 'force-pushing to a remote', slice: 1 }, ctx))
      .toEqual({ kind: 'action', text: 'force-pushing to a remote', slice: 1 })
    expect(describeEvent({ at: 1, event: 'blocked', tool: 'Bash', target: 'x', desc: 'deleting files', reason: 'hece: nope' }, ctx))
      .toEqual({ kind: 'alert', text: 'hece stopped a command (deleting files): nope', slice: null })
  })
  it('marks blocked edits outside the project', () => {
    expect(describeEvent({ at: 1, event: 'blocked', tool: 'Edit', target: '/q/a.ts', reason: 'hece: nope' }, ctx)?.text)
      .toBe('hece stopped an edit to a.ts (outside the project): nope')
  })
  it('never prints null or empty fields for flow steps', () => {
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_start_slice' }, ctx)?.text).toBe('started a slice')
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_finish_slice' }, ctx)?.text).toBe('a slice is done, waiting for you')
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_set_plan' }, ctx)?.text).toBe('plan proposed, waiting for your approval')
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_report_review' }, ctx)?.text).toBe('review done')
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_start_slice', n: 9 }, ctx)?.text).toBe('started slice 9')
  })
  it('hides noise events', () => {
    for (const event of ['prompt', 'turn_done', 'session_start']) expect(describeEvent({ at: 1, event }, ctx)).toBeNull()
    expect(describeEvent({ at: 1, event: 'tool', tool: 'mcp__hece__flow_get', target: '' }, ctx)).toBeNull()
  })
})

describe('relPath', () => {
  it('falls back to the file name outside the project', () => {
    expect(relPath('/p', '/p/x/y.ts')).toBe('x/y.ts')
    expect(relPath('/p', '/q/y.ts')).toBe('y.ts')
    expect(relPath('/p', '')).toBe('a file')
  })
})
