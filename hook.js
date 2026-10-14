#!/usr/bin/env node

// PreCompact + SessionEnd + SessionStart hook
// PreCompact/SessionEnd: converts session to markdown and updates qmd index.
// SessionStart (compact/resume/clear): converts session, extracts last turns to stdout, updates qmd index.

const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const lib = require('./lib')

const SCRIPT_PATH = path.join(__dirname, 'convert-sessions.js')
const TIMING_LOG = path.join(__dirname, 'timing.log')

// Per-step timing, appended as each step finishes so a run killed by the
// hook timeout still shows the last step it completed.
const T0 = Date.now()
let timingId = 'pid' + process.pid
function mark (step) {
  try {
    fs.appendFileSync(TIMING_LOG, new Date().toISOString() + ' ' + timingId + ' +' + (Date.now() - T0) + 'ms ' + step + '\n')
  } catch (e) {}
}
mark('start')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (chunk) { input += chunk })
process.stdin.on('end', function () {
  mark('stdin-end')
  let data
  try { data = JSON.parse(input) } catch (e) { process.exit(0) }

  const sessionId = data.session_id
  if (!sessionId) process.exit(0)

  const config = lib.readConfig()
  if (!config) process.exit(0)
  if (!config.outputDir) process.exit(0)

  const eventName = data.hook_event_name
  timingId = String(sessionId).slice(0, 8) + ' ' + eventName + ':' + (data.source || '-')
  mark('config-read embedRunning=' + lib.isEmbedRunning())

  if (eventName === 'SessionStart') {
    handleSessionStart(data, config, sessionId)
  } else {
    handlePreCompactOrEnd(config, sessionId)
  }
})

function convertSession (config, sessionId) {
  const convertCmd = 'node ' + JSON.stringify(SCRIPT_PATH) + ' ' + JSON.stringify(config.outputDir) + ' --session ' + JSON.stringify(sessionId)
  try {
    // Child stdout goes to stderr: on SessionStart our stdout must be pure JSON.
    cp.execSync(convertCmd, {
      stdio: ['ignore', process.stderr, process.stderr],
      timeout: 60000
    })
    return true
  } catch (e) {
    return false
  }
}

function updateQmd () {
  if (!lib.qmdAvailable()) return
  try {
    const collections = cp.execSync('qmd collection list', { encoding: 'utf8', timeout: 10000 })
    if (collections.indexOf('claude-sessions') === -1) return
  } catch (e) {
    return
  }
  if (lib.isEmbedRunning()) return
  // update+embed can run for minutes; Claude Code cancels hooks at ~60s.
  // Detach so the hook exits as soon as the transcript conversion is done —
  // the scheduled launchd refresh is the backstop if this run dies early.
  try {
    cp.spawn('/bin/sh', ['-c', 'qmd update && qmd embed'],
      { detached: true, stdio: 'ignore' }).unref()
  } catch (e) {}
}

function handleSessionStart (data, config, sessionId) {
  const source = data.source
  const cwd = data.cwd || process.cwd()

  var contextBuf = ''
  var statusLines = []

  // CLAUDE.md is not re-injected here: Claude Code already loads the global
  // and project CLAUDE.md itself, so doing it again duplicated ~18KB of context.

  // For compact/resume/clear: convert session and load recent turns
  if (source === 'compact' || source === 'resume' || source === 'clear') {
    convertSession(config, sessionId)
    mark('convert-session')

    const context = lib.collectRecentTurns(config.outputDir, cwd)
    mark('collect-recent-turns')
    if (context) {
      contextBuf += context
      var match = context.match(/~(\d+) exchanges from (\d+) session/)
      if (match) {
        statusLines.push('[qmd-sessions] Loaded ' + match[1] + ' exchanges from ' + match[2] + ' session' + (match[2] !== '1' ? 's' : ''))
      }
    } else {
      statusLines.push('[qmd-sessions] No recent session context found')
    }
  } else if (source === 'startup' && config.loadContextOnStartup) {
    const context = lib.collectRecentTurns(config.outputDir, cwd)
    mark('collect-recent-turns')
    if (context) {
      contextBuf += context
      var match = context.match(/~(\d+) exchanges from (\d+) session/)
      if (match) {
        statusLines.push('[qmd-sessions] Loaded ' + match[1] + ' exchanges from ' + match[2] + ' session' + (match[2] !== '1' ? 's' : ''))
      }
    } else {
      statusLines.push('[qmd-sessions] No recent session context found')
    }
  } else if (source === 'startup') {
    statusLines.push('[qmd-sessions] loadContextOnStartup disabled, skipping context load')
  }

  // Output JSON with systemMessage (user-visible) and additionalContext (Claude context)
  var output = {
    systemMessage: statusLines.join('\n'),
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextBuf
    }
  }
  process.stdout.write(JSON.stringify(output))
  mark('done')
}

function handlePreCompactOrEnd (config, sessionId) {
  convertSession(config, sessionId)
  mark('convert-session')
  updateQmd()
  mark('done')
}
