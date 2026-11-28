'use strict';
// tdd-guard for Bash: finds the files a shell command writes (`> file`, `tee file`, `sed -i ... file`) and asks
// tdd-guard.sh about each one, so the RED-phase rules also hold for the common shell ways of changing a file.
// A backstop, not a sandbox: see "Not caught" in plugins/tdd-flow/README.md. Any error lets the command through.
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const GUARD = path.join(__dirname, 'tdd-guard.sh');
const GUARD_TIMEOUT_MS = 3000;
const MAYBE_WRITES = />|\btee\b|\bsed\b/;

/** The command without its heredoc bodies (the line that starts the heredoc stays): a body is text, not a command. */
function dropHeredocs(cmd) {
  // `<<EOF`, `<<-EOF`, `<<'E O F'`, `<<"EOF"`, `<<\EOF`; not the here-string `<<<`.
  const START = /(?<!<)<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([^\s'"<>|;&()]+))/g;
  const out = [];
  let waiting = [];
  for (const line of cmd.split('\n')) {
    if (waiting.length) {
      if (line.replace(/^\t+/, '').trimEnd() === waiting[0] || line.trim() === waiting[0]) waiting.shift();
      continue;
    }
    out.push(line);
    waiting = [...line.matchAll(START)].map((m) => m[1] ?? m[2] ?? m[3]);
  }
  return out.join('\n');
}

/** Single-quoted spans replaced by numbered placeholders, so a backtick or `$(` inside them is not taken for a substitution. */
function maskSingleQuotes(s) {
  const kept = [];
  let out = '';
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { out += c + s[++i]; continue; }
    if (c === '"') inDouble = !inDouble;
    if (c === "'" && !inDouble) {
      const close = s.indexOf("'", i + 1);
      if (close < 0) { out += s.slice(i); break; }
      kept.push(s.slice(i + 1, close));
      out += `'\u0001${kept.length - 1}\u0001'`;
      i = close;
      continue;
    }
    out += c;
  }
  return { text: out, kept };
}

/**
 * Splits a shell command into simple commands: [{words: [{text, dynamic}], redirects: [{text, dynamic}]}], with
 * {open: true} / {close: true} entries where a subshell starts and ends.
 * Quotes are honoured (a `>` inside them is text), a word is `dynamic` when it holds an expansion or a glob, and
 * `$(...)` / backtick bodies become commands of their own. Redirections that write a file land in `redirects`;
 * descriptor copies (`2>&1`), input redirections and process substitutions do not.
 */
function parse(cmd) {
  const masked = maskSingleQuotes(dropHeredocs(cmd.replace(/\\\r?\n/g, ' ')));
  let s = masked.text;
  const bodies = [];
  const SUB_RE = /\$\(([^()]*)\)|`([^`]*)`/g;
  while (SUB_RE.test(s)) {
    SUB_RE.lastIndex = 0;
    s = s.replace(SUB_RE, (_, a, b) => { bodies.push(a ?? b); return '$SUB'; });
  }
  const commands = [];
  for (const text of [s, ...bodies]) {
    let cur = { words: [], redirects: [] };
    const end = () => { if (cur.words.length || cur.redirects.length) commands.push(cur); cur = { words: [], redirects: [] }; };
    let i = 0;
    const skipSpace = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; };
    const readWord = () => {
      let out = '';
      let dynamic = false;
      let seen = false;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === "'") {
          const close = text.indexOf("'", i + 1);
          if (close < 0) { i = text.length; break; }
          out += text.slice(i + 1, close).replace(/^\u0001(\d+)\u0001$/, (_, n) => masked.kept[Number(n)]); i = close; seen = true;
        } else if (c === '"') {
          for (i++; i < text.length && text[i] !== '"'; i++) {
            if (text[i] === '\\' && i + 1 < text.length) i++;
            else if (text[i] === '$') dynamic = true;
            out += text[i];
          }
          seen = true;
        } else if (c === '\\' && i + 1 < text.length) { out += text[++i]; seen = true; }
        else if (/[\s;&|<>()]/.test(c)) break;
        else { if (c === '$' || c === '*' || c === '?') dynamic = true; out += c; seen = true; }
      }
      return seen ? { text: out, dynamic } : null;
    };
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '>' || (c === '&' && text[i + 1] === '>')) {
        // A number glued to the operator is a file descriptor (`2>file`), not an argument.
        const last = cur.words[cur.words.length - 1];
        if (last && last.glued === i && /^\d+$/.test(last.text)) cur.words.pop();
        if (c === '&') i++;
        i++;
        if (text[i] === '>' || text[i] === '|') i++;
        let isCopy = false;
        if (text[i] === '&') { isCopy = true; i++; }
        if (text[i] === '(') { i++; end(); continue; } // process substitution `>(cmd)`: its body is a command of its own
        skipSpace();
        const w = readWord();
        if (w && !(isCopy && /^(\d+|-)$/.test(w.text))) cur.redirects.push(w);
        continue;
      }
      if (c === '<') {
        while (text[i] === '<' || text[i] === '&' || text[i] === '-') i++;
        if (text[i] === '(') { i++; end(); continue; }
        skipSpace();
        readWord(); // the input file, here-string or heredoc delimiter
        continue;
      }
      if (c === '\n' || c === ';' || c === '|' || c === '&') { i++; end(); continue; }
      if (c === '(' || c === ')') { i++; end(); commands.push(c === '(' ? { open: true } : { close: true }); continue; }
      const w = readWord();
      if (!w) { i++; continue; }
      if (w.text === '{' || w.text === '}') { end(); continue; }
      cur.words.push({ ...w, glued: i });
    }
    end();
  }
  return commands;
}

/** Files `sed` edits in place: with -i / --in-place, the words after the script (the first non-option word unless -e / -f gave it). */
function sedTargets(args) {
  let inPlace = false;
  let hasScript = false;
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k].text;
    if (a === '--') {
      const rest = args.slice(k + 1);
      files.push(...(hasScript ? rest : rest.slice(1)));
      break;
    }
    // BSD sed: `-i ''` gives the backup suffix as a separate, empty word.
    if (a === '-i' && args[k + 1] && args[k + 1].text === '') { inPlace = true; k++; continue; }
    if (/^--in-place(=|$)/.test(a)) { inPlace = true; continue; }
    if (/^--(expression|file)$/.test(a)) { hasScript = true; k++; continue; }
    if (/^--/.test(a)) { if (/^--(expression|file)=/.test(a)) hasScript = true; continue; }
    if (/^-[A-Za-z]/.test(a)) {
      const flags = a.slice(1);
      const at = flags.search(/[ief]/);
      if (flags.includes('i') && (at < 0 || flags[at] === 'i' || flags.indexOf('i') < at)) inPlace = true;
      // -e and -f take the next word when nothing follows them in the cluster; after -i comes an optional suffix.
      const m = flags.match(/^[^ief]*([ef])(.*)$/);
      if (m) { hasScript = true; if (!m[2]) k++; }
      continue;
    }
    if (!hasScript) { hasScript = true; continue; }
    files.push(args[k]);
  }
  return inPlace ? files : [];
}

/** Absolute paths of the files the command writes, in the directory each write runs in (`cd <dir>` earlier in the command counts). */
function writeTargets(cmd, cwd) {
  const out = new Set();
  // null: the directory is not known (`cd -`, `cd $DIR`), so relative targets cannot be judged.
  let dir = cwd;
  const outer = [];
  for (const c of parse(cmd)) {
    if (c.open) { outer.push(dir); continue; }
    if (c.close) { if (outer.length) dir = outer.pop(); continue; }
    let words = c.words;
    // `VAR=1 sudo tee file`: assignments and wrappers in front of the command itself.
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0].text) || WRAPPERS.has(words[0].text))) words = words.slice(1);
    const name = words.length ? path.basename(words[0].text) : '';
    if (name === 'cd' || name === 'pushd') {
      const to = words.slice(1).find((w) => !/^-[A-Za-z-]*$/.test(w.text) || w.text === '-');
      dir = !to ? os.homedir() : to.dynamic || to.text === '-' || dir === null ? null : path.resolve(dir, expandHome(to.text));
      continue;
    }
    const found = [...c.redirects];
    if (name === 'tee') found.push(...words.slice(1).filter((w) => !/^-/.test(w.text)));
    if (name === 'sed' || name === 'gsed') found.push(...sedTargets(words.slice(1)));
    for (const t of found) {
      // A variable, a glob or a device cannot be judged: left to the documented gaps.
      if (!t.text || t.dynamic || t.text === '-' || /^\/dev\//.test(t.text)) continue;
      const file = expandHome(t.text);
      if (dir === null && !path.isAbsolute(file)) continue;
      out.add(path.resolve(dir || '/', file));
    }
  }
  return [...out];
}

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'exec', 'nice', 'nohup', '!']);
const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

/** Runs tdd-guard.sh for every file the command writes. Returns {code: 0 | 2, stderr}. */
function main(input, env = process.env) {
  let data;
  try { data = JSON.parse(input); } catch { return { code: 0, stderr: '' }; }
  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (!MAYBE_WRITES.test(cmd)) return { code: 0, stderr: '' };
  const cwd = data.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  for (const file of writeTargets(cmd, cwd)) {
    const r = spawnSync('bash', [GUARD], { input: JSON.stringify({ cwd, tool_input: { file_path: file } }), env, encoding: 'utf8', timeout: GUARD_TIMEOUT_MS });
    if (r.status === 2) return { code: 2, stderr: `${(r.stderr || '').trim()}\nThe shell command would write this file. The same rule holds for a file changed through the shell.\n` };
  }
  return { code: 0, stderr: '' };
}

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let r = { code: 0, stderr: '' };
    try { r = main(input); } catch { /* a bug in the backstop must not block the shell */ }
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.code);
  });
}

module.exports = { main, parse, writeTargets, sedTargets, dropHeredocs };
