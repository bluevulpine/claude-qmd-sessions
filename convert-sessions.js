#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const CLAUDE_PROJECTS = path.join(process.env.HOME, '.claude', 'projects')

// Cowork / agent-mode sessions: the Desktop app runs Claude Code in a VM that
// writes standard JSONL transcripts to a nested .claude/projects tree under each
// local_<uuid> session directory. Same format as CLAUDE_PROJECTS, so we sweep
// those roots too (bulk mode only) and group them under a single "cowork" project.
const COWORK_ROOT = path.join(process.env.HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
const COWORK_PROJECT = 'cowork'

function safeReaddir (dir) {
  try { return fs.readdirSync(dir) } catch (e) { return [] }
}

function isDirectory (p) {
  try { return fs.statSync(p).isDirectory() } catch (e) { return false }
}

// True if the source transcript is newer than its converted output (or if
// either can't be stat'd). Used to re-convert in bulk mode when a session has
// grown since it was last exported — e.g. long or resumed cowork sessions,
// which have no SessionEnd hook to force a --session overwrite.
function outIsStale (sourceFile, outFile) {
  try {
    return fs.statSync(sourceFile).mtimeMs > fs.statSync(outFile).mtimeMs
  } catch (e) {
    return true
  }
}

function slugify (s) {
  if (!s) return ''
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

// Discover cowork transcript roots. Layout:
//   local-agent-mode-sessions/<spaceId>/<cliSessionId>/local_<uuid>/.claude/projects
// The human-readable title lives in the sibling config file local_<uuid>.json.
function findCoworkProjectRoots () {
  const roots = []
  if (!isDirectory(COWORK_ROOT)) return roots
  for (const space of safeReaddir(COWORK_ROOT)) {
    const spacePath = path.join(COWORK_ROOT, space)
    if (!isDirectory(spacePath)) continue
    for (const cli of safeReaddir(spacePath)) {
      const cliPath = path.join(spacePath, cli)
      if (!isDirectory(cliPath)) continue
      for (const entry of safeReaddir(cliPath)) {
        if (entry.indexOf('local_') !== 0) continue
        const localDir = path.join(cliPath, entry)
        if (!isDirectory(localDir)) continue
        const projRoot = path.join(localDir, '.claude', 'projects')
        if (!isDirectory(projRoot)) continue
        // Title from sibling config file, if present
        let titleHint = ''
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(cliPath, entry + '.json'), 'utf8'))
          if (cfg && cfg.title) titleHint = slugify(cfg.title)
        } catch (e) { /* no config / unreadable — fall back to transcript title */ }
        roots.push({ root: projRoot, titleHint: titleHint })
      }
    }
  }
  return roots
}

// Parse args: node convert-sessions.js [output-dir] [--session <id>]
let OUTPUT_DIR = null
let SESSION_ID = null

for (let a = 2; a < process.argv.length; a++) {
  if (process.argv[a] === '--session' && process.argv[a + 1]) {
    SESSION_ID = process.argv[a + 1]
    a++
  } else if (!OUTPUT_DIR) {
    OUTPUT_DIR = process.argv[a]
  }
}

if (!OUTPUT_DIR) {
  console.error('Usage: node convert-sessions.js <output-directory> [--session <session-id>]')
  process.exit(1)
}

function projectName (cwd, dirName) {
  // Derive project name from the real cwd path (last 2 segments joined by -)
  if (cwd) {
    const segments = cwd.split('/').filter(function (s) { return s.length > 0 })
    if (segments.length >= 2) return segments[segments.length - 2] + '-' + segments[segments.length - 1]
    if (segments.length === 1) return segments[0]
  }
  // Fallback: use directory name minus leading dashes
  if (dirName) {
    const cleaned = dirName.replace(/^-+/, '')
    if (cleaned) return cleaned
  }
  return 'misc'
}

function stripSystemTags (text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function extractText (content) {
  if (typeof content === 'string') return stripSystemTags(content)
  if (!Array.isArray(content)) return ''

  const texts = []
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block && block.type === 'text' && block.text) {
      const cleaned = stripSystemTags(block.text)
      if (cleaned) texts.push(cleaned)
    }
  }
  return texts.join('\n\n')
}

// Extract metadata from the first 32KB of a JSONL file using regex.
// Works on truncated JSON lines — fields are near the start of each line,
// so regex finds them even when the line is cut off mid-content.
function peekFields (filePath) {
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(32768)
  const bytesRead = fs.readSync(fd, buf, 0, 32768, 0)
  fs.closeSync(fd)

  const text = buf.toString('utf8', 0, bytesRead)
  let m
  let sessionId = ''
  let slug = ''
  let date = ''
  let cwd = ''

  m = /"sessionId":"([^"]+)"/.exec(text)
  if (m) sessionId = m[1]

  m = /"slug":"([^"]+)"/.exec(text)
  if (m) slug = m[1]

  m = /"timestamp":"([^"]+)"/.exec(text)
  if (m) date = m[1].slice(0, 10)

  m = /"cwd":"([^"]+)"/.exec(text)
  if (m) cwd = m[1]

  let aiTitle = ''
  m = /"aiTitle":"([^"]+)"/.exec(text)
  if (m) aiTitle = m[1]

  return { sessionId, slug, date, cwd, aiTitle }
}

function peekSessionId (filePath) {
  return peekFields(filePath).sessionId || null
}

function processJsonl (filePath, isSubagent) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split('\n')

  const userLabel = isSubagent ? 'Task' : 'User'
  const assistantLabel = isSubagent ? 'Subagent' : 'Claude'

  const meta = { slug: '', date: '', branch: '', sessionId: '', agentId: '' }
  const turns = []

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue

    let obj
    try { obj = JSON.parse(lines[i]) } catch (e) { continue }

    if (!meta.sessionId && obj.sessionId) meta.sessionId = obj.sessionId
    if (!meta.slug && obj.slug) meta.slug = obj.slug
    if (!meta.branch && obj.gitBranch) meta.branch = obj.gitBranch
    if (!meta.date && obj.timestamp) meta.date = obj.timestamp.slice(0, 10)
    if (!meta.agentId && obj.agentId) meta.agentId = obj.agentId

    let text
    if (obj.type === 'user') {
      text = extractText(obj.message && obj.message.content)
      if (text) turns.push({ role: userLabel, text })
    } else if (obj.type === 'assistant') {
      text = extractText(obj.message && obj.message.content)
      if (text) turns.push({ role: assistantLabel, text })
    }
  }

  return { meta, turns }
}

function buildSessionMarkdown (data, project) {
  const m = data.meta
  let out = '# Session: ' + (m.slug || 'untitled') + '\n\n'
  out += '**Date:** ' + (m.date || 'unknown') + '  \n'
  out += '**Project:** ' + project + '  \n'
  out += '**Branch:** ' + (m.branch || 'unknown') + '  \n'
  out += '**Session ID:** ' + (m.sessionId || 'unknown') + '\n\n'
  out += '---\n\n'

  for (let i = 0; i < data.turns.length; i++) {
    const turn = data.turns[i]
    out += '## ' + turn.role + '\n\n'
    out += turn.text + '\n\n'
  }

  return out
}

function buildSubagentMarkdown (data, project, parentSlug) {
  const m = data.meta
  let out = '# Subagent: ' + (m.agentId || 'unknown') + '\n\n'
  out += '**Date:** ' + (m.date || 'unknown') + '  \n'
  out += '**Project:** ' + project + '  \n'
  out += '**Branch:** ' + (m.branch || 'unknown') + '  \n'
  out += '**Parent Session:** ' + (parentSlug || 'unknown') + '  \n'
  out += '**Session ID:** ' + (m.sessionId || 'unknown') + '  \n'
  out += '**Agent ID:** ' + (m.agentId || 'unknown') + '\n\n'
  out += '---\n\n'

  for (let i = 0; i < data.turns.length; i++) {
    const turn = data.turns[i]
    out += '## ' + turn.role + '\n\n'
    out += turn.text + '\n\n'
  }

  return out
}

function convertSession (dirPath, file, project, titleHint) {
  const sessionFile = path.join(dirPath, file)

  // Quick metadata peek to build output path (and skip check in bulk mode)
  const fileId = file.replace('.jsonl', '').slice(0, 8)
  const meta = peekFields(sessionFile)
  const slug = meta.slug || titleHint || slugify(meta.aiTitle) || file.replace('.jsonl', '')
  const date = meta.date || 'unknown'
  const outDir = path.join(OUTPUT_DIR, project)
  const outFile = path.join(outDir, date + '-' + slug + '-' + fileId + '.md')

  // In --session mode, always overwrite (session is still growing)
  // In bulk mode, skip only if the output exists and is at least as new as the
  // source; re-convert when the transcript has grown since the last export
  if (!SESSION_ID && fs.existsSync(outFile) && !outIsStale(sessionFile, outFile)) return 'skipped'

  // Full parse only when we need to write
  const data = processJsonl(sessionFile, false)

  if (data.turns.length === 0) return 'empty'

  // Ensure the H1 title reflects the resolved slug (cowork sessions have no
  // native slug — this carries the config/aiTitle title into the body too).
  if (!data.meta.slug) data.meta.slug = slug

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, buildSessionMarkdown(data, project), 'utf8')

  const isOwnFile = file.replace('.jsonl', '') === data.meta.sessionId
  return isOwnFile ? 'session' : 'continuation'
}

function convertSubagents (dirPath, sessionDirName, project) {
  const subDir = path.join(dirPath, sessionDirName, 'subagents')
  if (!fs.existsSync(subDir)) return { subagents: 0, empty: 0, skipped: 0 }

  const outDir = path.join(OUTPUT_DIR, project)
  const result = { subagents: 0, empty: 0, skipped: 0 }

  // Find parent session slug (partial read via peekFields)
  let parentSlug = sessionDirName.slice(0, 8)
  const parentJsonl = path.join(dirPath, sessionDirName + '.jsonl')
  if (fs.existsSync(parentJsonl)) {
    const parentFields = peekFields(parentJsonl)
    if (parentFields.slug) parentSlug = parentFields.slug
  }

  const agentFiles = fs.readdirSync(subDir).filter(function (f) {
    return f.endsWith('.jsonl') && f.indexOf('compact') === -1
  })

  for (let af = 0; af < agentFiles.length; af++) {
    const agentFile = path.join(subDir, agentFiles[af])
    const agentData = processJsonl(agentFile, true)

    if (agentData.turns.length === 0) {
      result.empty++
      continue
    }

    const agentShortId = agentFiles[af].replace('.jsonl', '').replace('agent-', '').slice(0, 12)
    const agentDate = agentData.meta.date || 'unknown'
    const outFile = path.join(outDir, agentDate + '-' + parentSlug + '-sub-' + agentShortId + '.md')

    // In --session mode, always overwrite; in bulk mode, skip only if up to date
    if (!SESSION_ID && fs.existsSync(outFile) && !outIsStale(agentFile, outFile)) {
      result.skipped++
      continue
    }

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(outFile, buildSubagentMarkdown(agentData, project, parentSlug), 'utf8')
    result.subagents++
  }

  return result
}

// Scan one "projects root" (either ~/.claude/projects or a cowork nested root).
// forcedProject overrides the cwd-derived project name (used to group cowork).
// titleHint supplies a filename slug when the transcript has no native slug.
function scanProjectsRoot (root, forcedProject, titleHint) {
  const acc = { sessions: 0, continuations: 0, subagents: 0, skipped: 0, empty: 0 }
  for (const dirName of safeReaddir(root)) {
    const dirPath = path.join(root, dirName)
    if (!isDirectory(dirPath)) continue

    const files = safeReaddir(dirPath).filter(function (f) { return f.endsWith('.jsonl') && f.indexOf('compact') === -1 })
    const peekCwd = files.length > 0 ? peekFields(path.join(dirPath, files[0])).cwd : ''
    const project = forcedProject || projectName(peekCwd, dirName)

    for (let f = 0; f < files.length; f++) {
      const result = convertSession(dirPath, files[f], project, titleHint)
      if (result === 'session') acc.sessions++
      else if (result === 'continuation') acc.continuations++
      else if (result === 'skipped') acc.skipped++
      else if (result === 'empty') acc.empty++
    }

    const sessionDirs = safeReaddir(dirPath).filter(function (name) {
      return isDirectory(path.join(dirPath, name)) && name !== 'memory'
    })
    for (let sd = 0; sd < sessionDirs.length; sd++) {
      const subResult = convertSubagents(dirPath, sessionDirs[sd], project)
      acc.subagents += subResult.subagents
      acc.empty += subResult.empty
      acc.skipped += subResult.skipped
    }
  }
  return acc
}

function main () {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    console.error('Claude projects directory not found: ' + CLAUDE_PROJECTS)
    process.exit(1)
  }

  const dirs = fs.readdirSync(CLAUDE_PROJECTS)
  let sessions = 0
  let continuations = 0
  let subagents = 0
  let skipped = 0
  let empty = 0

  if (SESSION_ID) {
    // --- Scoped mode: convert only files for this session ID ---
    for (let d = 0; d < dirs.length; d++) {
      const dirPath = path.join(CLAUDE_PROJECTS, dirs[d])
      if (!fs.statSync(dirPath).isDirectory()) continue

      // Find JSONL files belonging to this session (skip compact files)
      const files = fs.readdirSync(dirPath).filter(function (f) { return f.endsWith('.jsonl') && f.indexOf('compact') === -1 })
      const peekCwd = files.length > 0 ? peekFields(path.join(dirPath, files[0])).cwd : ''
      const project = projectName(peekCwd, dirs[d])

      for (let f = 0; f < files.length; f++) {
        const fileSessionId = peekSessionId(path.join(dirPath, files[f]))
        if (fileSessionId !== SESSION_ID) continue

        const result = convertSession(dirPath, files[f], project)
        if (result === 'session') sessions++
        else if (result === 'continuation') continuations++
        else if (result === 'skipped') skipped++
        else if (result === 'empty') empty++
      }

      // Convert subagents for this session
      const sessionDir = path.join(dirPath, SESSION_ID)
      if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
        const subResult = convertSubagents(dirPath, SESSION_ID, project)
        subagents += subResult.subagents
        empty += subResult.empty
        skipped += subResult.skipped
      }
    }
  } else {
    // --- Full scan mode: convert all sessions ---
    const primary = scanProjectsRoot(CLAUDE_PROJECTS, null, null)
    sessions += primary.sessions
    continuations += primary.continuations
    subagents += primary.subagents
    skipped += primary.skipped
    empty += primary.empty

    // Also sweep cowork / agent-mode transcripts (Desktop app), grouped under "cowork"
    const coworkRoots = findCoworkProjectRoots()
    let coworkConverted = 0
    for (let c = 0; c < coworkRoots.length; c++) {
      const cw = scanProjectsRoot(coworkRoots[c].root, COWORK_PROJECT, coworkRoots[c].titleHint)
      sessions += cw.sessions
      continuations += cw.continuations
      subagents += cw.subagents
      skipped += cw.skipped
      empty += cw.empty
      coworkConverted += cw.sessions + cw.continuations
    }
    if (coworkRoots.length > 0) {
      console.log('Cowork: ' + coworkConverted + ' converted from ' + coworkRoots.length + ' session roots')
    }
  }

  console.log('Sessions: ' + sessions + '  Continuations: ' + continuations + '  Subagents: ' + subagents + '  Skipped: ' + skipped + '  Empty: ' + empty)
}

main()
