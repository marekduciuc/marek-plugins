export const meta = {
  name: 'simplify',
  description: 'Find code that does not need to exist (duplicates, dead code, single-use abstractions, reinvented helpers, speculative options, pass-through layers) in a branch diff or across the codebase, each finding checked by a sceptic',
  whenToUse: 'mode "diff" (implement-spec, before the PR review): {mode: "diff", base} returns refactor proposals for tdd-implement {refactors}. mode "codebase" (simplify-codebase skill): {mode: "codebase", paths?, maxAreas?, maxPerSpec?} writes draft refactor specs per area',
  phases: [
    { title: 'Scope', detail: 'codebase mode: split tracked source files into areas' },
    { title: 'Scan', detail: 'one simplifier per scope' },
    { title: 'Verify', detail: 'a sceptic on the strong model tries to refute each finding' },
    { title: 'Write', detail: 'codebase mode: draft specs of [refactor] tasks, at most maxPerSpec each' },
  ],
}

const opt = typeof args === 'string' ? { mode: args } : (args || {})
const A = (type) => 'tdd-flow:' + type
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
const int = { type: 'integer' }
const MODE = opt.mode === 'codebase' ? 'codebase' : 'diff'
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, opt.models || {})
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const MAX_FINDINGS = posInt(opt.maxFindings, 8)
const MAX_PER_SPEC = posInt(opt.maxPerSpec, 8)
const MAX_AREAS = posInt(opt.maxAreas, 12)
// Agent limits. Override per run with args {maxAgents, maxParallel} (positive integers).
const MAX_AGENTS = posInt(opt.maxAgents, MODE === 'codebase' ? 3 * MAX_AREAS + 6 : 6)
const MAX_PARALLEL = posInt(opt.maxParallel, 3)
const LIMIT = `tdd-flow: agent limit (${MAX_AGENTS}) reached`
let spawned = 0, active = 0
const waiting = []
// Every agent call goes through run(): at most MAX_PARALLEL at once, started in request order,
// and at most MAX_AGENTS per run.
async function run(prompt, o) {
  if (spawned >= MAX_AGENTS) throw new Error(LIMIT)
  spawned++
  if (active < MAX_PARALLEL) active++
  else await new Promise(r => waiting.push(r))
  try { return await agent(prompt, o) } finally { if (waiting.length) waiting.shift()(); else active-- }
}

const TAGS = ['duplicate', 'dead-code', 'single-use-abstraction', 'reinvented', 'speculative', 'pass-through']
const FINDINGS = {
  type: 'object',
  required: ['lean', 'findings'],
  properties: {
    lean: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'object', required: ['tag', 'title', 'files', 'where', 'issue', 'proposal', 'risk'], properties: {
      tag: { type: 'string', enum: TAGS }, title: str, files: strs, where: str, issue: str, proposal: str, gain: int,
      risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    } } },
  },
}
const VERDICTS = {
  type: 'object',
  required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', required: ['index', 'keep', 'reason'], properties: { index: int, keep: { type: 'boolean' }, reason: str } } } },
}
const AREAS = {
  type: 'object',
  required: ['areas', 'files', 'noTestSuite'],
  properties: {
    areas: { type: 'array', items: { type: 'object', required: ['area', 'include', 'files'], properties: { area: str, include: strs, files: int, bytes: int } } },
    files: int, noTestSuite: { type: 'boolean' },
  },
}
const SPECS = {
  type: 'object',
  required: ['specs', 'total'],
  properties: { specs: { type: 'array', items: { type: 'object', required: ['slug', 'tasks'], properties: { slug: str, dir: str, tasks: int, acIds: strs } } }, total: int },
}

// Deterministic steps run in the plugin's CLI (bin/tdd-flow) through the script-runner agent (haiku, Bash only)
// instead of a reasoning agent. Returns {ok, result} or {ok: false, error, fallback}. Identical in every workflow
// (scripts cannot import; tests/cli.test.cjs checks the copies match).
// The relay agent retypes the JSON and can drop array items: the CLI prints `shape` (sizes of the result's arrays),
// cli() recomputes it over the schema's paths, plus an optional o.check(result) -> problem, and on a mismatch has the
// worker model relay the saved output again (`tdd-flow replay`, the command does not run twice). A relay that still
// fails returns `relayFailed: true`: the command may have run, so the caller must not treat it as a CLI error.
const cliSchema = (schema) => ({ type: 'object', required: ['ok', 'shape'], properties: {
  ok: { type: 'boolean' }, shape: str, error: str, fallback: { type: 'boolean' }, again: { type: 'boolean' }, result: schema } })
function shapeOf(v, p = '', out = []) {
  if (Array.isArray(v)) {
    if (v.length) out.push(`${p}=${v.length}`)
    v.forEach((x, i) => shapeOf(x, p ? `${p}.${i}` : `${i}`, out))
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) shapeOf(v[k], p ? `${p}.${k}` : k, out)
  }
  return out
}
const inSchema = (schema, p) => !!p.split('.').reduce((s, seg) => s && (/^\d+$/.test(seg) ? s.items : s.properties && s.properties[seg]), schema)
function relayProblem(r, schema, check) {
  if (typeof r.shape !== 'string') return 'no shape in the relayed output'
  if (r.ok && (!r.result || typeof r.result !== 'object')) return 'no result in the relayed output'
  const pick = (entries) => entries.filter(e => inSchema(schema, e.slice(0, e.lastIndexOf('='))))
  const want = pick(r.shape.split(' ').filter(Boolean)), got = pick(shapeOf(r.result || {}))
  const missing = want.filter(e => !got.includes(e)), extra = got.filter(e => !want.includes(e))
  if (missing.length || extra.length) return `array sizes differ (CLI: ${missing.join(' ') || '-'}; relayed: ${extra.join(' ') || '-'})`
  return r.ok && r.result && check ? check(r.result) : ''
}
let relays = 0
async function cli(cmd, input, schema, o = {}) {
  const id = `${cmd}-${++relays}`, label = o.label || cmd
  const relay = (command, stdin, model, lbl) => run(
    `Run with the Bash tool (timeout 600000):\n\ntdd-flow ${command} <<'TDD_FLOW_JSON'\n${JSON.stringify(stdin)}\nTDD_FLOW_JSON\n\n` +
    (o.repeat && command === cmd ? `While the printed JSON has "again": true, run the identical command again (at most ${o.repeat} runs).\n` : '') +
    'Return the printed JSON object as your structured output, every field and array item exactly as printed.',
    { agentType: A('script-runner'), model, effort: 'low', schema: cliSchema(schema), label: lbl, phase: o.phase, ...(o.stallMs ? { stallMs: o.stallMs } : {}) },
    o.final)
  let r = await relay(cmd, { ...input, _relay: id }, o.model || M.light, label)
  if (!r) return { ok: false, relayFailed: true, error: 'script-runner agent failed' }
  let problem = relayProblem(r, schema, o.check)
  if (problem) {
    log(`${label}: ${problem} - relaying the saved output again on ${M.worker}`)
    r = await relay('replay', { id }, M.worker, `${label} (relay retry)`)
    problem = r ? relayProblem(r, schema, o.check) : 'script-runner agent failed'
    if (problem) return { ok: false, relayFailed: true, error: `the output of tdd-flow ${cmd} was not relayed completely: ${problem}` }
  }
  return r
}

// ---------- helpers ----------
// One proposal as tdd-implement {refactors} takes it.
const asProposal = (f) => `${f.tag}: ${f.where} - ${f.issue}. Proposal: ${f.proposal}`
const byGain = (a, b) => (b.gain || 0) - (a.gain || 0)

async function scan(scope, label) {
  return run(
    `Find code that does not need to exist. ${scope}\nUse git ls-files and git grep; never search .claude/worktrees/. ` +
    'Return each finding with one tag, the files it touches, the evidence and a behaviour-preserving proposal; return lean = true and no findings when there is nothing worth removing.',
    { agentType: A('simplifier'), model: M.worker, schema: FINDINGS, label, phase: 'Scan' })
}

// A sceptic on the strong model tries to refute every finding; one without a verdict counts as refuted.
async function verify(findings, scope, label) {
  const v = await run(
    `Try to refute each proposed simplification below. ${scope}\n` +
    'Check each one in the code yourself (git grep, never .claude/worktrees/): is the code really unneeded (callers in code, tests, config, templates; use through strings, reflection, dependency injection or routing), ' +
    'does the proposal keep behaviour (edge cases, error paths, ordering, null/empty input), does it stay inside the scope, and does it remove more than it adds? ' +
    'keep = true only if the finding survives all of that; when unsure, keep = false. Give the reason in one line. Do not edit files.\n\n' +
    findings.map((f, i) => `[${i}] ${f.tag} (risk ${f.risk}) ${f.where}\n  files: ${f.files.join(', ')}\n  issue: ${f.issue}\n  proposal: ${f.proposal}`).join('\n'),
    { agentType: A('code-reviewer'), model: M.strong, schema: VERDICTS, label, phase: 'Verify' })
  const kept = [], dropped = []
  findings.forEach((f, i) => {
    const verdict = v && v.verdicts.find(x => x.index === i)
    if (verdict && verdict.keep) kept.push(f)
    else dropped.push({ finding: asProposal(f), reason: verdict ? verdict.reason : 'not verified' })
  })
  return { kept, dropped }
}

// ---------- diff mode: proposals for the PR of one spec ----------
if (MODE === 'diff') {
  if (!opt.base) throw new Error('tdd-flow simplify: mode "diff" needs {base}')
  const scope = `Scope: only code that \`git diff ${opt.base}...HEAD -- . ':(exclude).tdd-flow'\` adds or changes. Propose changes only to files in that diff.`
  phase('Scan')
  const found = await scan(scope, 'scan diff')
  if (!found) throw new Error('tdd-flow simplify: the simplifier agent failed')
  if (!found.findings.length) return { mode: MODE, lean: true, findings: [], details: [], dropped: [] }
  phase('Verify')
  const { kept, dropped } = await verify(found.findings, scope, 'verify diff')
  const ok = []
  for (const f of kept.sort(byGain)) {
    if (f.risk === 'high') dropped.push({ finding: asProposal(f), reason: 'risk high: left for a person' })
    else if (ok.length >= MAX_FINDINGS) dropped.push({ finding: asProposal(f), reason: `over the limit of ${MAX_FINDINGS} per PR` })
    else ok.push(f)
  }
  return { mode: MODE, lean: !ok.length, findings: ok.map(asProposal), details: ok, dropped }
}

// ---------- codebase mode: draft refactor specs per area ----------
phase('Scope')
const ar = await cli('areas', { paths: opt.paths || [], maxFiles: opt.maxFiles || null, maxBytes: opt.maxBytes || null }, AREAS, { label: 'areas', phase: 'Scope' })
if (!ar.ok) throw new Error(`tdd-flow simplify: splitting the code into areas failed. ${ar.error}`)
if (ar.result.noTestSuite) {
  return { mode: MODE, status: 'no_test_suite', specs: [],
    next: 'No test command in .tdd-flow/stack.md. Refactor tasks are checked by the test suite: set one up first (an analyze-requirements spec with a [setup] task), then scan again.' }
}
if (!ar.result.areas.length) return { mode: MODE, status: 'nothing_to_scan', specs: [], next: 'No tracked source files in the given paths.' }
const areas = ar.result.areas.slice(0, MAX_AREAS)
const notScanned = ar.result.areas.slice(MAX_AREAS).map(a => a.area)
if (notScanned.length) log(`Scanning ${areas.length} of ${ar.result.areas.length} areas (maxAreas ${MAX_AREAS}); not scanned: ${notScanned.join(', ')}`)
const scopeOf = (a) => `Scope: area ${a.area} - only these tracked paths: ${a.include.join(', ')}. Code outside it is context only (callers, other copies); do not propose changes there.`

const scanned = await pipeline(areas,
  a => scan(scopeOf(a), `scan ${a.area}`),
  (found, a) => (found && found.findings.length ? verify(found.findings, scopeOf(a), `verify ${a.area}`) : { kept: [], dropped: [], lean: !!found }))

// Barrier: findings of different areas must not touch the same files, or their PRs would conflict.
const highRisk = [], dropped = [], leanAreas = []
const owner = new Map()
const perArea = areas.map(() => [])
const all = []
scanned.forEach((r, i) => {
  if (!r) { dropped.push({ finding: `area ${areas[i].area}`, reason: 'scan or verify agent failed' }); return }
  dropped.push(...r.dropped)
  if (!r.kept.length && !r.dropped.length) leanAreas.push(areas[i].area)
  r.kept.forEach(f => all.push({ f, i }))
})
for (const { f, i } of all.sort((a, b) => byGain(a.f, b.f))) {
  const clash = f.files.map(x => owner.get(x)).find(o => o !== undefined && o !== i)
  if (f.risk === 'high') highRisk.push({ area: areas[i].area, finding: asProposal(f) })
  else if (clash !== undefined) dropped.push({ finding: asProposal(f), reason: `touches files of a finding in area ${areas[clash].area}` })
  else if (perArea[i].some(g => g.tag === f.tag && g.files.join() === f.files.join() && g.where === f.where)) dropped.push({ finding: asProposal(f), reason: 'duplicate finding' })
  else { perArea[i].push(f); f.files.forEach(x => owner.set(x, i)) }
}

// One CLI call per area, one after another: slugs are picked from what exists, so parallel writes could collide.
phase('Write')
const specs = []
for (let i = 0; i < areas.length; i++) {
  const findings = perArea[i]
  if (!findings.length) continue
  const w = await cli('simplify-spec', { area: areas[i].area, findings, maxPerSpec: MAX_PER_SPEC }, SPECS, {
    label: `spec ${areas[i].area}`, phase: 'Write',
    check: r => (r.total === findings.length && r.specs.reduce((n, s) => n + s.tasks, 0) === findings.length ? '' : `the CLI wrote ${r.total} of ${findings.length} findings`),
  })
  if (!w.ok) { dropped.push(...findings.map(f => ({ finding: asProposal(f), reason: `spec not written: ${w.error}` }))); continue }
  w.result.specs.forEach((s, k) => {
    const part = findings.slice(k * MAX_PER_SPEC, (k + 1) * MAX_PER_SPEC)
    specs.push({ slug: s.slug, area: areas[i].area, tasks: s.tasks, tags: [...new Set(part.map(f => f.tag))],
      risk: part.some(f => f.risk === 'medium') ? 'medium' : 'low' })
  })
}

return {
  mode: MODE,
  status: specs.length ? 'specs_written' : 'lean',
  specs, highRisk, dropped, notScanned, leanAreas,
  next: specs.length
    ? 'Draft specs are in .tdd-flow/features/. Review them (delete unwanted task lines and their criteria), then run /tdd-flow:simplify-codebase --implement <slug ...>.'
    : 'Nothing worth removing was confirmed.',
}
