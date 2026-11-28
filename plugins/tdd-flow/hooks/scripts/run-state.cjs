'use strict';
// run-state: records why an autopilot session stopped moving (a permission prompt, a question, the usage limit, an
// API error, the session ended), so the board says so instead of "stalled". It runs for a few rare hook events,
// exits at once outside a spec worktree, starts no git process, and writes only its own file:
// <main checkout>/.git/tdd-flow/waiting/<slug>.json. It never answers a permission request.
const fs = require('fs');
const path = require('path');

const WORKTREE_RE = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([A-Za-z0-9][A-Za-z0-9._-]*)(?:[\\/]|$)/;
const one = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** {kind, detail} for a hook event, or null when the event says nothing about a waiting session. */
function waitingOf(data) {
  const event = data.hook_event_name;
  // A subagent's own stop, idle prompt or end is not the session's; its permission prompt does block the run.
  if (data.agent_id && event !== 'PermissionRequest') return null;
  if (event === 'PermissionRequest') {
    const input = data.tool_input || {};
    const what = one(input.command || input.file_path || input.url || '', 80);
    return { kind: 'permission', detail: `${data.tool_name || 'a tool'}${what ? `(${what})` : ''}` };
  }
  if (event === 'Notification') {
    const kind = { permission_prompt: 'permission', elicitation_dialog: 'question', idle_prompt: 'idle' }[data.notification_type];
    return kind ? { kind, detail: one(data.message, 120) } : null;
  }
  if (event === 'StopFailure') {
    const error = one(data.error, 40) || 'unknown';
    return { kind: error === 'rate_limit' ? 'limit' : 'error', detail: error };
  }
  if (event === 'SessionEnd') return { kind: 'ended', detail: one(data.reason, 40) };
  return null;
}

/** Writes the waiting file for the spec whose worktree the session runs in. Returns the file path, or '' when nothing was written. */
function record(data, now = new Date()) {
  const m = String(data.cwd || '').match(WORKTREE_RE);
  if (!m) return '';
  const [, root, slug] = m;
  const state = path.join(root, '.git', 'tdd-flow');
  // Only a spec the autopilot runs: its run file is there. `.git` is a directory in the main checkout only.
  if (!fs.existsSync(path.join(state, 'runs', `${slug}.json`))) return '';
  const w = waitingOf(data);
  if (!w) return '';
  const dir = path.join(state, 'waiting');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  const session = String(data.session_id || '');
  // The idle prompt or the end that follows a failure says less than the failure: the same session's limit or
  // error note stays, so the board keeps the cause and the autopilot does not restart into the usage limit.
  if (w.kind === 'idle' || w.kind === 'ended') {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no earlier note */ }
    if (prev && prev.session === session && (prev.kind === 'limit' || prev.kind === 'error')) return '';
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...w, session, at: now.toISOString() }) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try { record(JSON.parse(input)); } catch { /* a status note must never disturb the session */ }
    process.exit(0);
  });
}

module.exports = { record, waitingOf };
