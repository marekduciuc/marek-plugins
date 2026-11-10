#!/usr/bin/env node
// Reads Claude Code session transcripts (~/.claude/projects/**/*.jsonl) for the review-run skill: locates a
// session by id, job name or spec slug, prints a summary of its key events, or shows a condensed, filtered view.
// Stdlib only. Transcripts are read line by line, so a multi-megabyte file never lands in memory as one string.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const JOBS = path.join(HOME, '.claude', 'jobs');
const USAGE = `usage:
  transcript.cjs locate <session-id | job name | spec slug>   find the transcript file(s) and workflow dirs
  transcript.cjs summary <file.jsonl>                          key events with line numbers (questions, run-report, PRs, ...)
  transcript.cjs show <file.jsonl> [--grep <regex>] [--from <line>] [--to <line>] [--max <chars>] [--lines <n>] [--role user|assistant|tool|result]
  transcript.cjs agents <file.jsonl | session-dir>             the subagents and tdd-flow workflow runs of a session (what started each, their transcript files)`;

function arg(flag, def) { const i = process.argv.indexOf(flag); return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def; }
const fmtTime = (ts) => (ts ? String(ts).slice(0, 19).replace('T', ' ') : '');
const one = (s, max) => { const f = String(s).replace(/\s*\n\s*/g, ' | '); return f.length > max ? `${f.slice(0, max)} [+${f.length - max} chars]` : f; };

/** Every content block of a transcript line, flattened: {role, type, text}. */
function blocks(j) {
  const m = j.message;
  if (!m) return [];
  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const out = [];
  for (const b of parts) {
    if (b.type === 'text') out.push({ role: m.role, type: m.role === 'user' ? 'user' : 'assistant', text: b.text || '' });
    else if (b.type === 'tool_use') out.push({ role: m.role, type: 'tool', name: b.name, text: JSON.stringify(b.input), input: b.input });
    else if (b.type === 'tool_result') out.push({ role: m.role, type: 'result', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
  }
  return out;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    fn(j, n);
  }
  return n;
}

// ---------- locate ----------
function sessionDirs() {
  return fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).map((d) => path.join(PROJECTS, d)).filter((d) => fs.statSync(d).isDirectory()) : [];
}
function describe(file) {
  const st = fs.statSync(file);
  const wf = path.join(file.replace(/\.jsonl$/, ''), 'subagents', 'workflows');
  const n = fs.existsSync(wf) ? fs.readdirSync(wf).filter((d) => d.startsWith('wf_')).length : 0;
  return `${file}\n    ${(st.size / 1e6).toFixed(1)} MB, last write ${fmtTime(st.mtime.toISOString())}, ${n} workflow run(s)`;
}
function locate(q) {
  const hits = new Set();
  const notes = [];
  // Background jobs (claude --bg): state.json names the transcript and the job name.
  if (fs.existsSync(JOBS)) {
    for (const id of fs.readdirSync(JOBS)) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(JOBS, id, 'state.json'), 'utf8')); } catch { continue; }
      const flags = Array.isArray(s.respawnFlags) ? s.respawnFlags : [];
      const name = flags[flags.indexOf('-n') + 1] || '';
      const p = s.linkScanPath || '';
      if (id.startsWith(q) || name === q || p.includes(q)) {
        if (p && fs.existsSync(p)) hits.add(p);
        notes.push(`job ${id} "${name}": ${s.state || '?'}${s.detail ? ` - ${one(s.detail, 160)}` : ''}`);
      }
    }
  }
  // The autopilot's run file of a spec slug names the session it started (the id may be short).
  const ids = new Set([q]);
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (common.status === 0) {
    const runFile = path.resolve(common.stdout.trim(), 'tdd-flow', 'runs', `${q}.json`);
    try { const r = JSON.parse(fs.readFileSync(runFile, 'utf8')); if (r.session) { ids.add(r.session); notes.push(`run file ${runFile}: ${r.status}, session ${r.session}${r.prUrl ? `, ${r.prUrl}` : ''}`); } } catch { /* no run file here */ }
  }
  // Live and recent sessions as `claude agents` lists them; the transcript is found by its uuid below.
  const a = spawnSync(process.env.TDD_FLOW_CLAUDE_BIN || 'claude', ['agents', '--json', '--all'], { encoding: 'utf8' });
  if (a.status === 0) {
    let list = [];
    try { list = JSON.parse(a.stdout); } catch { /* not json */ }
    for (const s of list) {
      const sid = s.sessionId || '';
      const match = [...ids].some((id) => sid.startsWith(id) || (s.id || '').startsWith(id)) || s.name === q || (s.cwd || '').includes(q);
      if (!match) continue;
      if (sid) ids.add(sid);
      notes.push(`session ${sid.slice(0, 8)} "${s.name || ''}" (${s.kind}, ${s.state || s.status || '?'}) in ${s.cwd}`);
    }
  }
  // The transcript store: `~/.claude/projects/*/<uuid>.jsonl` by id prefix (the folder name encodes the cwd, which
  // may be a worktree that is gone by now), or every transcript of a folder whose name carries the slug.
  for (const d of sessionDirs()) {
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) if ([...ids].some((id) => f.startsWith(id))) hits.add(path.join(d, f));
    if (path.basename(d).includes(q.replace(/[/.]/g, '-'))) for (const f of files) hits.add(path.join(d, f));
  }
  const sorted = [...hits].sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
  if (!sorted.length) {
    // After cleanup the job dir, run file and session entry are gone. The main session that started the run still
    // mentions the job name (`claude --bg -n <name> "/tdd-flow:implement-spec <slug>"`), so look for the text itself.
    const all = sessionDirs().flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)));
    const g = spawnSync('grep', ['-l', '-F', '--', q, ...all], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const found = (g.stdout || '').split('\n').filter(Boolean).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs).slice(0, 10);
    console.log(`no transcript is named after "${q}" (a job or run file that cleanup removed?).`);
    if (found.length) console.log(`transcripts that mention it, newest first; try \`show <file> --grep "${q}"\` to find the slug or session id:\n${found.map(describe).join('\n')}`);
    if (notes.length) console.log(notes.join('\n'));
    return 1;
  }
  console.log(sorted.map(describe).join('\n'));
  // The session that started a worktree run (the autopilot, the analysis) lives in the main checkout's folder,
  // whose name is the worktree folder's name without `--claude-worktrees-<slug>`. List its transcripts that mention the query.
  const parents = new Set(sorted.map((f) => path.dirname(f)).filter((d) => /--claude-worktrees-/.test(d)).map((d) => d.replace(/--claude-worktrees-.*$/, '')));
  for (const d of parents) {
    if (!fs.existsSync(d)) continue;
    const g = spawnSync('grep', ['-l', '-F', '--', q, ...fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f))], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const found = (g.stdout || '').split('\n').filter(Boolean).filter((f) => !hits.has(f)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
    if (found.length) console.log(`\nmain-checkout sessions that mention "${q}" (the autopilot or analysis that started the run):\n${found.map(describe).join('\n')}`);
  }
  if (notes.length) console.log(`\n${notes.join('\n')}`);
  return 0;
}

// ---------- summary ----------
const KEY_CLI = /^tdd-flow (run-report|set-aside|sync-base|commit|autopilot-check|worktree|cleanup|specs)\b/;
async function summary(file) {
  const events = [];
  let first = '';
  let last = '';
  let lines = 0;
  const counts = { user: 0, assistant: 0, tool: 0 };
  await eachLine(file, (j, n) => {
    if (j.timestamp) { first = first || j.timestamp; last = j.timestamp; }
    for (const b of blocks(j)) {
      lines++;
      const t = fmtTime(j.timestamp);
      if (b.type === 'user') {
        const txt = b.text.trim();
        if (/^<system-reminder>|^<task-notification>|^\[Request interrupted/.test(txt)) continue;
        if (/^<command-name>|<command-message>/.test(txt)) { events.push([n, t, 'COMMAND', one(txt.replace(/<[^>]+>/g, ' '), 160)]); continue; }
        if (/^Base directory for this skill:/.test(txt)) continue;
        if (/^This session is being continued from a previous conversation/.test(txt)) { events.push([n, t, 'COMPACTED', 'context summary replaced the earlier conversation']); continue; }
        if (/^Another Claude session sent a message/.test(txt)) { events.push([n, t, 'CROSS-SESSION', one(txt.slice(0, 400), 300)]); continue; }
        counts.user++;
        events.push([n, t, 'USER', one(txt, 240)]);
      } else if (b.type === 'assistant') {
        counts.assistant++;
      } else if (b.type === 'tool') {
        counts.tool++;
        const cmd = b.input && typeof b.input.command === 'string' ? b.input.command : '';
        if (b.name === 'AskUserQuestion') events.push([n, t, 'ASK', one(JSON.stringify((b.input.questions || []).map((q) => q.question)), 300)]);
        else if (b.name === 'Skill') events.push([n, t, 'SKILL', one(`${b.input.skill} ${b.input.args || ''}`, 200)]);
        else if (b.name === 'Workflow') events.push([n, t, 'WORKFLOW', one(`${b.input.name || ''} ${typeof b.input.args === 'string' ? b.input.args : JSON.stringify(b.input.args || '')}`, 200)]);
        else if (b.name === 'Agent' || b.name === 'Task') events.push([n, t, 'AGENT', one(`${b.input.subagent_type || ''}: ${b.input.description || ''}`, 160)]);
        else if (KEY_CLI.test(cmd)) events.push([n, t, 'CLI', one(cmd, 400)]);
        else if (/\bgh pr (create|merge)\b|\bgit push\b|\bgit merge\b|\bgit rebase\b|--force/.test(cmd)) events.push([n, t, 'GIT', one(cmd, 200)]);
      } else if (b.type === 'result') {
        const m = b.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
        if (m) events.push([n, t, 'PR', m[0]]);
        if (/"status":"(blocked|stalled|failed)"/.test(b.text)) events.push([n, t, 'RUN', one(b.text, 400)]);
        if (/^Permission to use .* has been denied|denied by|blocked by hook|PreToolUse hook/.test(b.text)) events.push([n, t, 'DENIED', one(b.text, 240)]);
      }
    }
  });
  console.log(`${file}\n${fmtTime(first)} .. ${fmtTime(last)}; ${counts.user} user message(s), ${counts.assistant} assistant text(s), ${counts.tool} tool call(s)\n`);
  // Some entries are stored twice (a replay without a timestamp right after the original); show each event once.
  let prev = '';
  for (const [n, t, k, txt] of events) {
    if (`${k}\t${txt}` === prev) continue;
    prev = `${k}\t${txt}`;
    console.log(`${n}\t${t}\t${k}\t${txt}`);
  }
  return 0;
}

// ---------- show ----------
async function show(file) {
  const re = arg('--grep') ? new RegExp(arg('--grep'), 'i') : null;
  const from = Number(arg('--from', 0));
  const to = Number(arg('--to', Infinity));
  const max = Number(arg('--max', 400));
  const role = arg('--role');
  const cap = Number(arg('--lines', 300));
  let shown = 0;
  let skipped = 0;
  await eachLine(file, (j, n) => {
    if (n < from || n > to) return;
    for (const b of blocks(j)) {
      if (role && b.type !== role) continue;
      const label = b.type === 'tool' ? `TOOL ${b.name}` : b.type.toUpperCase();
      const line = `${label}: ${b.text}`;
      if (re && !re.test(line)) continue;
      if (shown >= cap) { skipped++; continue; }
      shown++;
      console.log(`${n} ${fmtTime(j.timestamp)} ${one(line, max)}`);
    }
  });
  if (skipped) console.log(`[+${skipped} more matching block(s); narrow with --grep, --from/--to or raise --lines]`);
  return 0;
}

// ---------- agents ----------
const readMeta = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
function agents(sessionDir) {
  const base = path.join(sessionDir.replace(/\.jsonl$/, ''), 'subagents');
  if (!fs.existsSync(base)) { console.log(`no subagents under ${base}`); return 1; }
  // Subagents the session's Agent tool started: the meta file carries the description the parent gave them.
  const plain = fs.readdirSync(base).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort((x, y) => fs.statSync(path.join(base, x)).mtimeMs - fs.statSync(path.join(base, y)).mtimeMs);
  for (const f of plain) {
    const m = readMeta(path.join(base, f.replace(/\.jsonl$/, '.meta.json')));
    console.log(`${path.join(base, f)}\n  ${m.agentType || 'agent'}: ${one(m.description || '', 160)} (${(fs.statSync(path.join(base, f)).size / 1e6).toFixed(1)} MB)`);
  }
  const root = path.join(base, 'workflows');
  if (!fs.existsSync(root)) return 0;
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('wf_')).map((d) => path.join(root, d))
    .sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs);
  for (const d of dirs) {
    const agents = [];
    const journal = path.join(d, 'journal.jsonl');
    if (fs.existsSync(journal)) {
      for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'started') agents.push(`${j.label || '?'}${j.phase ? ` [${j.phase}]` : ''} -> agent-${j.agentId}.jsonl`);
      }
    }
    console.log(`${path.basename(d)}  (last write ${fmtTime(fs.statSync(d).mtime.toISOString())})\n  ${agents.join('\n  ') || 'no journal'}`);
  }
  return 0;
}

(async () => {
  const [cmd, target] = process.argv.slice(2);
  if (!cmd || !target) { console.error(USAGE); process.exit(2); }
  if (cmd !== 'locate' && !fs.existsSync(target)) { console.error(`not found: ${target}`); process.exit(2); }
  const run = { locate, summary, show, agents }[cmd];
  if (!run) { console.error(USAGE); process.exit(2); }
  process.exit(await run(target));
})();
