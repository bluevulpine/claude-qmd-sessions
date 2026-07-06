#!/usr/bin/env node

// ============================================================================
// Scheduled maintenance for the qmd claude-sessions index.
//
// Converts ALL sessions (Claude Code terminal sessions + Desktop cowork/agent
// transcripts) to markdown, then runs `qmd update` + `qmd embed`. Designed to
// run from a launchd agent so the index stays fresh even on days you only use
// the Desktop app (whose cowork sessions the Claude Code hooks never see).
//
// Idempotent: convert-sessions.js skips already-converted files, and `qmd embed`
// only vectorizes new/changed hashes, so idle runs are cheap. The embed step is
// pgrep-gated to avoid colliding with an embed triggered by a live session hook.
// ============================================================================

const path = require('path')
const cp = require('child_process')
const { readConfig, isEmbedRunning, qmdAvailable } = require('./lib.js')

function expandTilde (p) {
  if (!p) return p
  if (p === '~') return process.env.HOME
  if (p.indexOf('~/') === 0) return path.join(process.env.HOME, p.slice(2))
  return p
}

function log (msg) {
  process.stdout.write('[' + new Date().toISOString() + '] ' + msg + '\n')
}

function main () {
  const cfg = readConfig()
  if (!cfg || !cfg.outputDir) {
    log('No config.json / outputDir configured; aborting.')
    process.exit(1)
  }
  const outDir = expandTilde(cfg.outputDir)

  log('Converting sessions (incl. cowork) -> ' + outDir)
  try {
    const out = cp.execFileSync('node', [path.join(__dirname, 'convert-sessions.js'), outDir], { encoding: 'utf8', timeout: 600000 })
    if (out) process.stdout.write(out)
  } catch (e) {
    log('Conversion failed: ' + (e.message || e))
    process.exit(1)
  }

  if (!qmdAvailable()) {
    log('qmd not on PATH; skipping index update.')
    process.exit(0)
  }

  // A running embed holds a long write transaction / checkpoint on the SQLite
  // index. `qmd update` is also a writer, and qmd's lock wait does not time out,
  // so starting an update against an in-flight embed can block indefinitely.
  // If any embed is running (from a live-session hook or another run), skip this
  // whole cycle — the next scheduled run brings the index current.
  if (isEmbedRunning()) {
    log('An embed is already running; skipping this cycle to avoid index lock contention.')
    process.exit(0)
  }

  log('qmd update')
  try {
    cp.execSync('qmd update', { stdio: 'inherit', timeout: 180000 })
  } catch (e) {
    // Bounded update timed out — almost always transient lock contention. qmd
    // spawns a detached grandchild, so the execSync timeout alone leaves it alive
    // holding the SQLite write lock (which would block the next cycle). Kill any
    // lingering update process, then skip (not a hard failure).
    try { cp.execSync('pkill -9 -f "qmd.*update"', { stdio: 'ignore' }) } catch (e2) {}
    log('qmd update did not complete (index likely busy); cleaned up and skipping: ' + (e.message || e))
    process.exit(0)
  }

  if (isEmbedRunning()) {
    log('An embed started while updating; skipping embed (next run will catch up).')
    process.exit(0)
  }

  log('qmd embed')
  try {
    cp.execSync('qmd embed', { stdio: 'inherit', timeout: 1800000 })
  } catch (e) {
    log('qmd embed failed: ' + (e.message || e))
    process.exit(1)
  }

  log('Done.')
}

main()
