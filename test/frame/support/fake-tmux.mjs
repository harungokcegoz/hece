// A stateful fake tmux for the frame-fit interleaving test. State lives in $FAKE_TMUX_STATE.
// Each command is atomic (own mkdir lock); split-window is slow on purpose so races show up.
import fs from 'node:fs'

const state = process.env.FAKE_TMUX_STATE
const guard = state + '.guard'
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const argv = process.argv.slice(2)
// drop the -L name -f /dev/null -u prefix
let i = 0
while (argv[i] === '-L' || argv[i] === '-f') i += 2
if (argv[i] === '-u') i += 1
const [cmd, ...rest] = argv.slice(i)

for (;;) {
  try {
    fs.mkdirSync(guard)
    break
  } catch {
    sleep(2)
  }
}
try {
  const s = JSON.parse(fs.readFileSync(state, 'utf8'))
  const save = () => fs.writeFileSync(state, JSON.stringify(s))
  const opt = (flag) => rest[rest.indexOf(flag) + 1]
  if (cmd === 'display') {
    process.stdout.write('220\n')
  } else if (cmd === 'list-panes') {
    process.stdout.write(s.panes.map((p) => `${p.id} ${p.role}`).join('\n') + '\n')
  } else if (cmd === 'split-window') {
    sleep(150)
    const id = `%${s.next++}`
    s.panes.push({ id, role: '' })
    save()
    process.stdout.write(id + '\n')
  } else if (cmd === 'set' && rest[0] === '-p') {
    const p = s.panes.find((p) => p.id === opt('-t'))
    if (p) p.role = rest[rest.length - 1]
    save()
  } else if (cmd === 'kill-pane') {
    s.panes = s.panes.filter((p) => p.id !== opt('-t'))
    save()
  }
} finally {
  fs.rmdirSync(guard)
}
