export const meta = {
  name: 'analyze-requirements',
  description: 'Turn an issue, spec file or text into a testable spec (Given/When/Then ACs) and ordered task list, cross-checked by critics',
  whenToUse: 'Start of a feature: pass an issue number/URL (GitHub, Azure DevOps, Jira), a path to a spec file, or the requirement text',
  phases: [
    { title: 'Context', detail: 'detect stack, fetch requirement' },
    { title: 'Draft', detail: '3 analysts from different angles' },
    { title: 'Synthesize', detail: 'merge drafts into spec.md + tasks.md' },
    { title: 'Critique', detail: 'testability, completeness and existing-tests critics, then revise' },
  ],
}

// ---------- input ----------
const input = typeof args === 'string' ? args : args && args.input
const opt = (typeof args === 'object' && args) || {}
if (!input) throw new Error('tdd-flow: pass the requirement as args (issue id/url, file path, or text).')

const A = (type) => 'tdd-flow:' + type
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, (typeof args === 'object' && args && args.models) || {})
// Agent limits. Override per run with args {maxAgents, maxParallel} (positive integers).
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const MAX_AGENTS = posInt(opt.maxAgents, 12)
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

const STACK = {
  type: 'object',
  required: ['language', 'testAll', 'testSingle', 'tracker', 'defaultBranch'],
  properties: {
    language: str, testAll: str, testSingle: str, lint: str, tracker: str,
    trackerCliReady: { type: 'boolean' }, defaultBranch: str, ci: str, baseline: str, testsNeed: str,
  },
}
// stack-detector must say what the tests need: the CLI writes it into stack.md if the agent left the line out.
const DETECTED = { ...STACK, required: [...STACK.required, 'testsNeed'] }
const FILLED = { type: 'object', required: ['added'], properties: { added: { type: 'boolean' }, reason: str } }
const REQ = {
  type: 'object',
  required: ['ok', 'title', 'text', 'source', 'slug'],
  properties: {
    ok: { type: 'boolean' }, title: str, text: str, source: str,
    issueId: str, slug: str, problem: str,
  },
}
const CONTEXT = {
  type: 'object', required: ['kind'],
  properties: { kind: { type: 'string', enum: ['issue', 'file', 'text'] }, note: str, stack: STACK, req: REQ },
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

const DRAFT = {
  type: 'object',
  required: ['acceptanceCriteria', 'edgeCases', 'openQuestions', 'tasks'],
  properties: {
    codeContext: strs,
    acceptanceCriteria: { type: 'array', items: { type: 'object', required: ['name', 'given', 'when', 'then'], properties: { name: str, given: str, when: str, then: str, verify: str } } },
    edgeCases: strs, nonFunctional: strs, outOfScope: strs,
    openQuestions: { type: 'array', items: { type: 'object', required: ['question', 'assumption'], properties: { question: str, assumption: str } } },
    tasks: { type: 'array', items: { type: 'object', required: ['title', 'covers'], properties: { title: str, covers: strs, kind: { type: 'string', enum: ['tdd', 'setup'] } } } },
  },
}
const SPEC = {
  type: 'object',
  required: ['specPath', 'tasksPath', 'acCount', 'tasks', 'openQuestions'],
  properties: {
    specPath: str, tasksPath: str, acCount: { type: 'number' },
    tasks: strs, openQuestions: strs, assumptions: strs,
  },
}
const CRIT = {
  type: 'object',
  required: ['issues'],
  properties: { issues: { type: 'array', items: { type: 'object', required: ['severity', 'where', 'problem', 'fix'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: str, problem: str, fix: str } } } },
}

try {
  // ---------- Context ----------
  phase('Context')
  // The CLI reads an existing .tdd-flow/stack.md and fetches GitHub issues and spec files. Text input needs no fetch.
  // Agents run only for what it could not get: stack detection on the first run, other trackers (Azure DevOps, Jira).
  const cx = await cli('context', { input }, CONTEXT, { label: 'context', phase: 'Context' })
  const known = cx.ok ? cx.result : { kind: 'unknown' }
  if (!cx.ok) log(`context: ${cx.error} - using the agents`)
  else if (known.note) log(`context: ${known.note} - fetching with an agent`)
  const firstLine = input.split('\n').find(l => l.trim()) || input
  const title = firstLine.trim().replace(/\s+/g, ' ').slice(0, 80)
  const textReq = known.kind === 'text' && {
    ok: true, title, text: input, source: 'prompt',
    slug: title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'feature',
  }
  const stackKnown = known.stack && !/^(unknown)?$/i.test(known.stack.testAll || '') ? known.stack : null
  const [stack, req] = await parallel([
    () => stackKnown || run(
      'Detect this repository\'s stack. If .tdd-flow/stack.md already exists, read it and return its values without re-detecting. Otherwise detect and write .tdd-flow/stack.md. Return testsNeed as the `tests need` value (none, docker (...), database (...) or services (...)).',
      { agentType: A('stack-detector'), schema: DETECTED, label: 'stack-detector', effort: 'low' })
      .then(async (s) => {
        if (!s) return s
        const f = await cli('stack-fill', { testsNeed: s.testsNeed }, FILLED, { label: 'stack-fill', phase: 'Context' })
        if (!f.ok) log(`stack-fill: ${f.error}`)
        else if (f.result.added) log(`stack.md: added tests need: ${s.testsNeed}`)
        return s
      }),
    () => known.req || textReq || run(
      `Fetch the raw requirement for a software feature. Input: """${input}"""\n` +
      '- If it is an issue number or URL: detect the tracker from `git remote -v` and installed CLIs. GitHub: `gh issue view <id> --json number,title,body,labels,comments`. Azure DevOps: `az boards work-item show --id <id> -o json`. Jira: a connected Jira MCP tool if available, else the `jira` CLI.\n' +
      '- If it is an existing file path: read the file.\n' +
      '- Otherwise the input itself is the requirement text.\n' +
      'Return the full requirement text (include relevant comments), a title, the source (URL/path/"prompt"), the issue id if any, and a kebab-case slug like "142-csv-export" (max 40 chars). ' +
      'If a CLI is missing or not authenticated, set ok=false and put the exact login/install command in problem.',
      { schema: REQ, model: M.light, label: 'fetch-requirement', effort: 'low' }),
  ])
  if (limitHit) throw new Error(LIMIT)
  if (!stack || !req) throw new Error('tdd-flow: context step failed (see /workflows for the agent output).')
  if (!req.ok) throw new Error('tdd-flow: could not fetch the requirement. ' + (req.problem || ''))
  const dir = `.tdd-flow/features/${req.slug}`
  log(`Feature ${req.slug} - stack: ${stack.language}, tests: ${stack.testAll}`)

  // ---------- Draft (3 independent angles) ----------
  phase('Draft')
  const ANGLES = [
    { key: 'behaviour', lens: 'BEHAVIOUR-FIRST: focus on user goals and the observable happy-path behaviour that proves each goal.' },
    { key: 'risk', lens: 'RISK-FIRST: focus on edge cases, invalid input, error paths, limits, permissions, backward compatibility and security.' },
    { key: 'scope', lens: 'MINIMAL-SCOPE: find the smallest shippable slice, state what is explicitly out of scope, and order tasks so each builds on a passing previous one.' },
  ]
  const drafts = (await parallel(ANGLES.map(a => () => run(
    `Analyse this requirement and draft a spec. Angle: ${a.lens}\n\n` +
    `Title: ${req.title}\nSource: ${req.source}\nRequirement:\n"""${req.text}"""\n\n` +
    `Stack: ${stack.language}; tests via \`${stack.testAll}\`.\n` +
    'Explore the codebase to ground the draft in real modules, entry points and existing tests. Every acceptance criterion must be verifiable by an automated test. ' +
    'Exception: config, infrastructure or scaffolding work that no test can describe (docker-compose, Dockerfile, CI, manifests, installing the test framework) goes into tasks with kind "setup" (see "Task kinds" in your instructions); give each of their criteria a verify command. All other tasks are kind "tdd". Do NOT write any files - return the draft only.',
    { agentType: A('requirements-analyst'), model: M.worker, schema: DRAFT, label: `analyst:${a.key}`, phase: 'Draft' },
  )))).filter(Boolean)
  if (limitHit) throw new Error(LIMIT)
  if (!drafts.length) throw new Error('tdd-flow: all analyst drafts failed.')

  // ---------- Synthesize ----------
  phase('Synthesize')
  const synthPrompt = (extra) =>
    `Merge these ${drafts.length} independent spec drafts for "${req.title}" into ONE spec.\n` +
    'Do NOT simply take the union. Include an AC only if the requirement asks for it or it is an edge case a careful engineer would consider necessary; move speculative behaviour (unicode, performance, input types, limits not mentioned) to Open questions with an assumption instead of new ACs. ' +
    'Keep scope proportional: a small function needs roughly 3-6 ACs and 1-3 tasks; group closely related ACs into one task. Drop duplicates, keep ACs sharp and testable, number them AC-1.., EC-1.., Q-1.., T-1... Order tasks so each builds on the previous.\n' +
    `Write ${dir}/spec.md using your spec template (title line: # ${req.title}, Status: draft, Source: ${req.source}, Slug: ${req.slug}).\n` +
    `Write ${dir}/tasks.md as a checklist: "- [ ] T-1 <title> (AC-1, AC-2)"; end the line of a setup task with " [setup]". Every criterion of a setup task needs a "- **Verify:** \`<command>\`" line in spec.md (or "- **Verify (manual):**" only when no automatic check exists). In a repo with no test suite, put the setup task that installs the test framework before the first tdd task.\n` +
    `Create or overwrite .tdd-flow/state.json as {"feature": "${req.slug}", "phase": "IDLE", "task": "T-1"}.\n` +
    'If .tdd-flow/ is not in .gitignore, do not change .gitignore - just mention it in assumptions.\n' +
    (extra || '') +
    `\nRaw requirement:\n"""${req.text}"""\n\nDrafts:\n${JSON.stringify(drafts, null, 1)}`
  let spec = await run(synthPrompt(), { agentType: A('requirements-analyst'), model: M.strong, schema: SPEC, label: 'synthesize' })
  if (!spec) throw new Error('tdd-flow: synthesis failed.')

  // ---------- Critique ----------
  phase('Critique')
  const CRITICS = [
    { key: 'testability', ask: 'Check every AC: is it unambiguous, observable, and automatable with the repo\'s test framework? Flag vague words ("fast", "user-friendly"), hidden multiple behaviours in one AC, and tasks too big for a few red-green cycles. Setup tasks ([setup] in tasks.md) are checked by verify commands instead of tests: flag a setup criterion without a Verify line or with a command that cannot tell pass from fail, and flag a setup task that contains logic a test could check (it must be a tdd task).' },
    { key: 'completeness', ask: 'Compare the spec against the RAW requirement below. Flag anything required but missing, anything in the spec NOT supported by the requirement (invented scope), and edge cases a careful engineer would expect.' },
    {
      key: 'existing-tests',
      ask: `Stack: ${stack.language}; tests via \`${stack.testAll}\`. For every AC or task that changes, renames or removes something an existing test can observe (visible text, a glyph, markup, an attribute, a class name, a route, an API field, an error message, a behaviour), search the existing test files (git grep) for assertions on the OLD value. ` +
        'Report a hit only when the test asserts the old value on the same element, component, endpoint or function the AC changes, not every file that contains the word. ' +
        'A hit is a blocker unless the spec keeps the old value or already names that test (file:line) as one to update. Give where = the test file:line, problem = the assertion and the AC that changes it, fix = name the test in the AC and its task, or ask which wins when a criterion says existing tests stay unchanged.',
    },
  ]
  const crits = (await parallel(CRITICS.map(c => () => run(
    `You are a skeptical reviewer of ${dir}/spec.md. ${c.ask}\nOnly report real problems; do not edit files.\n\nRaw requirement:\n"""${req.text}"""`,
    { schema: CRIT, model: M.worker, label: `critic:${c.key}`, phase: 'Critique', agentType: A('code-reviewer') },
  )))).map((c, i) => c && { ...c, key: CRITICS[i].key }).filter(Boolean)
  if (limitHit) throw new Error(LIMIT)
  const serious = crits.flatMap(c => c.issues).filter(i => i.severity !== 'minor')
  const minor = crits.flatMap(c => c.issues).filter(i => i.severity === 'minor')
  // Existing tests that assert what the spec changes: shown at the approval gate, since revise runs only once.
  const testHits = crits.filter(c => c.key === 'existing-tests').flatMap(c => c.issues).filter(i => i.severity !== 'minor')
  if (testHits.length) log(`Existing tests assert what the spec changes: ${testHits.map(i => i.where).join(', ')}`)
  if (serious.length) {
    log(`Critics raised ${serious.length} blocker/major issue(s) - revising the spec`)
    const revised = await run(
      `Revise ${dir}/spec.md and ${dir}/tasks.md to fix these review issues. Where an issue needs information only the user has, add it to Open questions with your assumption instead of guessing.\n` +
      'An existing test that asserts what the spec changes: if no criterion says existing tests stay unchanged, name the test (file:line) and its new assertion in the AC and in the task that makes the change, so the test-writer updates it in RED. If a criterion says they stay unchanged, the spec contradicts itself: add an Open question (which wins), with your assumption; do not resolve it silently.\n' +
      JSON.stringify(serious, null, 1),
      { agentType: A('requirements-analyst'), model: M.strong, schema: SPEC, label: 'revise', phase: 'Critique' })
    if (revised) spec = revised
  } else {
    log('Critics found no blocker/major issues')
  }
  if (minor.length) log(`${minor.length} minor critique note(s) not applied - see the critic agents in /workflows`)

  return {
    status: 'spec_draft_ready',
    slug: req.slug,
    source: req.source,
    specPath: spec.specPath,
    tasksPath: spec.tasksPath,
    acceptanceCriteria: spec.acCount,
    tasks: spec.tasks,
    openQuestions: spec.openQuestions,
    assumptions: spec.assumptions || [],
    critiqueFixesApplied: serious.length,
    existingTestsChanged: testHits.map(i => `${i.where}: ${i.problem}`),
    next: 'GATE: show the user the spec summary, including existingTestsChanged (existing tests the spec changes). Print the open questions in chat as a numbered list, then ask them one at a time and update spec.md after each answer (/tdd-flow:resolve-questions <slug>). After they approve, set "Status: approved" in spec.md, then run /tdd-flow:tdd-implement.',
  }
} catch (e) {
  if (!limitHit) throw e
  return {
    status: 'agent_limit',
    agentsUsed: spawned,
    next: `Stopped at the agent limit (${MAX_AGENTS} agents per run). Rerun with a higher {maxAgents}. Resuming this run replays its finished agents, and they still count toward the limit.`,
  }
}
