export const meta = {
  name: 'document',
  description: 'Write README, API docs, ADR and CHANGELOG for a tdd-flow feature from the actual diff, each fact-checked against the code',
  whenToUse: 'After implementation. args: feature slug (optional) or {feature, targets: ["readme","api","adr","changelog"]}',
  phases: [
    { title: 'Survey', detail: 'diff, public surface, doc conventions, targets' },
    { title: 'Write', detail: 'one doc-writer per target' },
    { title: 'Verify', detail: 'fact-check each doc against code, fix' },
    { title: 'Commit', detail: 'docs commit' },
  ],
}

const opt = typeof args === 'string' ? { feature: args } : (args || {})
const A = (type) => 'tdd-flow:' + type
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
const COMMIT = { type: 'object', required: ['committed'], properties: { committed: { type: 'boolean' }, nothingToCommit: { type: 'boolean' }, sha: str, reason: str, unexpected: strs } }
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, (typeof args === 'object' && args && args.models) || {})
// Agent limits. Override per run with args {maxAgents, maxParallel} (positive integers).
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const MAX_AGENTS = posInt(opt.maxAgents, 15)
const MAX_PARALLEL = posInt(opt.maxParallel, 2)
const LIMIT = `tdd-flow: agent limit (${MAX_AGENTS}) reached`
let spawned = 0, active = 0, limitHit = false
const waiting = []
// Every agent call goes through run(): at most MAX_PARALLEL at once, started in request order,
// and at most MAX_AGENTS per run.
async function run(prompt, o) {
  if (spawned >= MAX_AGENTS) { limitHit = true; throw new Error(LIMIT) }
  spawned++
  if (active < MAX_PARALLEL) active++
  else await new Promise(r => waiting.push(r))
  try { return await agent(prompt, o) } finally { if (waiting.length) waiting.shift()(); else active-- }
}

const SURVEY = {
  type: 'object',
  required: ['slug', 'base', 'diffSummary', 'targets'],
  properties: {
    slug: str, base: str, diffSummary: str, publicSurface: strs, conventions: str,
    targets: { type: 'array', items: { type: 'object', required: ['kind', 'file', 'why'], properties: {
      kind: { type: 'string', enum: ['readme', 'api', 'adr', 'changelog'] }, file: str, why: str,
    } } },
  },
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

const WROTE = { type: 'object', required: ['files', 'summary'], properties: { files: strs, summary: str, unverified: strs } }
const CHECK = {
  type: 'object',
  required: ['ok', 'problems'],
  properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'object', required: ['where', 'claim', 'reality'], properties: { where: str, claim: str, reality: str } } } },
}

try {
  // ---------- Survey ----------
  phase('Survey')
  const survey = await run(
    'Survey documentation needs for a tdd-flow feature.\n' +
    `Feature slug: ${opt.feature ? '"' + opt.feature + '"' : 'read "feature" from .tdd-flow/state.json'}; spec at .tdd-flow/features/<slug>/spec.md (may be missing - then work from the diff).\n` +
    'Base = default branch from .tdd-flow/stack.md (or `git symbolic-ref refs/remotes/origin/HEAD`, else main/master). Diff = `git diff <base>...HEAD`.\n' +
    'Find existing doc conventions: README*, docs/, CHANGELOG*, docs/adr or adr/, doc-comment style in source.\n' +
    'Choose targets: api+readme if public surface changed (API, CLI flags, config, file formats); adr if there is a significant design choice (new dependency, pattern, data model change, trade-off); changelog for any user-visible change. ' +
    'For each target give the exact file to create/update (for api: the main source file or doc page). Do not edit anything.',
    { schema: SURVEY, model: M.worker, label: 'survey', effort: 'low' })
  if (!survey) throw new Error('tdd-flow: documentation survey failed.')
  let targets = survey.targets
  if (opt.targets && opt.targets.length) targets = targets.filter(t => opt.targets.includes(t.kind))
  if (!targets.length) return { status: 'nothing_to_document', slug: survey.slug, note: survey.diffSummary }
  log(`Doc targets: ${targets.map(t => `${t.kind} (${t.file})`).join(', ')}`)

  const ctx = `Feature ${survey.slug}. Spec: .tdd-flow/features/${survey.slug}/spec.md. Diff: \`git diff ${survey.base}...HEAD\`.\n` +
    `Diff summary: ${survey.diffSummary}\nPublic surface: ${(survey.publicSurface || []).join('; ')}\nConventions: ${survey.conventions || 'none found'}`

  // ---------- Write -> Verify -> Fix (pipelined per target; targets are distinct files) ----------
  const results = await pipeline(targets,
    t => run(
      `${ctx}\n\nProduce ONLY the "${t.kind}" documentation target, in ${t.file}. Why: ${t.why}. Do not touch other doc targets' files.`,
      { agentType: A('doc-writer'), schema: WROTE, label: `write:${t.kind}`, phase: 'Write' }),
    (wrote, t) => wrote && run(
      `Fact-check the ${t.kind} documentation just written in ${wrote.files.join(', ')} against the actual code (${ctx.split('\n')[0]}).\n` +
      'Try to REFUTE every concrete claim: names, signatures, parameters, defaults, file paths, commands, examples. Run or compile examples where feasible (or match them to passing tests). Report only claims that are false or unverifiable. Do not edit files.',
      { schema: CHECK, model: M.worker, label: `verify:${t.kind}`, phase: 'Verify', agentType: A('code-reviewer') })
      .then(check => ({ wrote, check })),
    (r, t) => {
      if (!r || !r.check || r.check.ok || !r.check.problems.length) return r
      return run(
        `${ctx}\n\nFix these inaccuracies in the ${t.kind} documentation (${r.wrote.files.join(', ')}). Make the docs match the code; never change production logic.\n${JSON.stringify(r.check.problems, null, 1)}`,
        { agentType: A('doc-writer'), schema: WROTE, label: `fix:${t.kind}`, phase: 'Verify' })
        .then(fixed => ({ ...r, fixed }))
    },
  )
  if (limitHit) throw new Error(LIMIT)
  const ok = results.filter(Boolean)
  const dropped = targets.length - ok.length
  if (dropped) log(`${dropped} doc target(s) failed - see /workflows`)

  // ---------- Commit ----------
  phase('Commit')
  const files = [...new Set(ok.flatMap(r => [...r.wrote.files, ...((r.fixed && r.fixed.files) || [])]))]
  const touchedSource = targets.some(t => t.kind === 'api')
  // Doc comments in source files: the CLI runs the full suite first and does not commit if it fails.
  const committed = await cli('commit', { message: `docs(${survey.slug}): update documentation`, files, runTests: touchedSource }, COMMIT, { label: 'commit' })
  const commit = committed.ok ? committed.result : null
  if (!commit || (!commit.committed && !commit.nothingToCommit)) {
    return { status: 'commit_failed', slug: survey.slug, reason: commit ? commit.reason : committed.error, next: 'Show the reason to the user, resolve it, then rerun /tdd-flow:document.' }
  }

  return {
    status: 'documented',
    slug: survey.slug,
    targets: ok.map(r => ({ files: r.wrote.files, summary: (r.fixed || r.wrote).summary, factCheckIssuesFixed: r.check ? r.check.problems.length : 0 })),
    commit: commit.sha || '',
    next: 'Run /tdd-flow:deploy to open the PR and run CI.',
  }
} catch (e) {
  if (!limitHit) throw e
  return {
    status: 'agent_limit',
    agentsUsed: spawned,
    next: `Stopped at the agent limit (${MAX_AGENTS} agents per run). Rerun with a higher {maxAgents}. Resuming this run replays its finished agents, and they still count toward the limit.`,
  }
}
