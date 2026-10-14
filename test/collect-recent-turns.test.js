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
