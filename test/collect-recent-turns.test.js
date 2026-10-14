// Run: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const lib = require('../lib')

function turn (who, n) { return '## ' + who + '\n\nturn ' + n + '\n\n' }

test('collectRecentTurns never reads an iCloud-evicted (dataless) export', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-sessions-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  const evicted = path.join(proj, '2026-10-02-evicted.md')
  const resident = path.join(proj, '2026-10-01-resident.md')
  fs.writeFileSync(evicted, turn('User', 'E1') + turn('Claude', 'E2'))
  fs.writeFileSync(resident, turn('User', 'R1') + turn('Claude', 'R2'))

  // An evicted file on APFS/iCloud has its full size but zero allocated
  // blocks; a read on it blocks in the kernel until iCloud downloads it.
  const realStat = fs.statSync
  const realRead = fs.readFileSync
  const reads = []
  fs.statSync = function (p) {
    const st = realStat.apply(fs, arguments)
    if (p === evicted) Object.defineProperty(st, 'blocks', { value: 0 })
    return st
  }
  fs.readFileSync = function (p) { reads.push(p); return realRead.apply(fs, arguments) }
  let out
  try {
    out = lib.collectRecentTurns(root, '/x/proj')
  } finally {
    fs.statSync = realStat
    fs.readFileSync = realRead
    fs.rmSync(root, { recursive: true, force: true })
  }
  assert.ok(!reads.includes(evicted), 'evicted file was read: ' + reads.join(','))
  assert.ok(out && out.includes('turn R1'), 'resident turns missing from output')
  assert.ok(!out.includes('turn E1'), 'evicted content leaked into output')
})

function mkRoot (layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-sessions-'))
  Object.keys(layout).forEach(function (dir) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    Object.keys(layout[dir]).forEach(function (file) {
      fs.writeFileSync(path.join(root, dir, file), layout[dir][file])
    })
  })
  return root
}

test('with no matching project, other projects are read newest-first by date, not by directory name', () => {
  const root = mkRoot({
    'zzz-old-project': { '2026-01-01-old.md': turn('User', 'OLD1') + turn('Claude', 'OLD2') },
    'aaa-new-project': { '2026-10-01-new.md': turn('User', 'NEW1') + turn('Claude', 'NEW2') }
  })
  try {
    const out = lib.collectRecentTurns(root, '/nowhere/unmatched', 2)
    assert.ok(out.includes('turn NEW1'), 'newest session should be read first, got: ' + out)
    assert.ok(!out.includes('turn OLD1'), 'oldest session was read first')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a fresh .claude/worktrees/<name> cwd falls back to its parent repo project', () => {
  const root = mkRoot({
    'Repositories-flux-talos': { '2026-09-01-parent.md': turn('User', 'PARENT1') + turn('Claude', 'PARENT2') },
    'other-project': { '2026-10-01-other.md': turn('User', 'OTHER1') + turn('Claude', 'OTHER2') }
  })
  try {
    const out = lib.collectRecentTurns(root, '/Users/me/Repositories/flux-talos/.claude/worktrees/new-feature', 2)
    assert.ok(out.includes('turn PARENT1'), 'parent repo session should win, got: ' + out)
    assert.ok(!out.includes('turn OTHER1'), 'unrelated newer project was read first')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
