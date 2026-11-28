export const meta = {
  name: 'analyze-requirements',
  description: 'Turn an issue, spec file or text into a testable spec (Given/When/Then ACs) and ordered task list, cross-checked by critics',
  whenToUse: 'Start of a feature: pass an issue number/URL (GitHub, Azure DevOps, Jira), a path to a spec file, or the requirement text; or {input, size: "small"|"full", answers}',
  phases: [
    { title: 'Context', detail: 'detect stack, fetch requirement' },
    { title: 'Triage', detail: 'is the requirement clear enough, and is the change small' },
    { title: 'Draft', detail: '1 analyst for a small change, 3 from different angles otherwise' },
    { title: 'Synthesize', detail: 'write spec.md + tasks.md from the drafts' },
    { title: 'Critique', detail: 'small change: existing-tests, task-order and grounding critics, one revision; otherwise all seven critics, revise, then a second round' },
  ],
}

// ---------- input ----------
const opt = (typeof args === 'object' && args) || {}
// {feature, mode: "recheck"}: no new spec is written. The critics check an existing spec again, after the user's
// answers changed its criteria or tasks (skills/resolve-questions).
const recheck = opt.mode === 'recheck'
const input = recheck ? '' : typeof args === 'string' ? args : args && args.input
if (recheck && !opt.feature) throw new Error('tdd-flow: mode "recheck" needs {feature: "<slug>"}.')
if (!recheck && !input) throw new Error('tdd-flow: pass the requirement as args (issue id/url, file path, or text).')
// {size: "small" | "full"} overrides the triage's estimate, and a given "small" is not escalated. {answers: "<text>"}: the user's answers to the clarifying
// questions of an earlier run that returned needs_clarification; with them the workflow does not ask again.
if (opt.size !== undefined && !['small', 'full'].includes(opt.size)) throw new Error('tdd-flow: size must be "small" or "full".')
if (opt.answers !== undefined && (typeof opt.answers !== 'string' || !opt.answers.trim())) throw new Error('tdd-flow: answers must be a non-empty text (every question with its answer).')
const answers = !recheck && opt.answers ? opt.answers.trim() : ''

const A = (type) => 'tdd-flow:' + type
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, (typeof args === 'object' && args && args.models) || {})
// Agent limits. Override per run with args {maxAgents, maxParallel} (positive integers).
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
// 27: context, stack-detector, stack-fill, fetch, triage, 3 drafts and synthesis are 9 on a first run with a
// non-GitHub tracker; 7 critics, the revision, up to 7 critics again and the second revision are 16 more; the two
// spare slots cover a relay retry without losing the last revision. A small change uses about 8.
const MAX_AGENTS = posInt(opt.maxAgents, 27)
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
// Earlier decisions: `## Resolved questions` entries of the other specs (tdd-flow decisions).
const DECISIONS = { type: 'array', items: { type: 'object', required: ['slug', 'id', 'question', 'answer'],
  properties: { slug: str, title: str, id: str, question: str, answer: str, date: str, where: str } } }
// A digest of every other spec, for the cross-spec critic: it opens only the specs it suspects.
const OTHER_SPECS = { type: 'array', items: { type: 'object', required: ['slug', 'path'], properties: {
  slug: str, title: str, status: str, path: str, outOfScope: strs,
  acs: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: str, name: str } } } } } }
const CONTEXT = {
  type: 'object', required: ['kind'],
  properties: { kind: { type: 'string', enum: ['issue', 'file', 'text'] }, note: str, stack: STACK, req: REQ,
    state: { type: 'object', required: ['feature', 'specStatus'], properties: { feature: str, specStatus: str } },
    otherSpecs: OTHER_SPECS, decisions: DECISIONS,
    // Only for {feature}: the existing spec that is checked again.
    spec: { type: 'object', required: ['slug', 'title', 'status', 'source'], properties: { slug: str, title: str, status: str, source: str } } },
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
    acceptanceCriteria: { type: 'array', items: { type: 'object', required: ['name', 'given', 'when', 'then'], properties: { name: str, given: str, when: str, then: str, mustNot: str, verify: str, browserCheck: str } } },
    edgeCases: strs, nonFunctional: strs, outOfScope: strs,
    openQuestions: { type: 'array', items: { type: 'object', required: ['question', 'assumption'], properties: { question: str, assumption: str } } },
    // Questions an earlier decision of another spec answers; from = "<slug> Q-<m>".
    resolved: { type: 'array', items: { type: 'object', required: ['question', 'answer', 'from'], properties: { question: str, answer: str, from: str } } },
    tasks: { type: 'array', items: { type: 'object', required: ['title', 'covers'], properties: { title: str, covers: strs, kind: { type: 'string', enum: ['tdd', 'setup', 'ui'] } } } },
  },
}
const SPEC = {
  type: 'object',
  required: ['specPath', 'tasksPath', 'acCount', 'tasks', 'openQuestions'],
  properties: {
    specPath: str, tasksPath: str, acCount: { type: 'number' },
    tasks: strs, openQuestions: strs, assumptions: strs,
    // The last revision only: review issues it could not fix, one line each.
    deferred: strs,
  },
}
const TRIAGE = {
  type: 'object',
  required: ['clear', 'questions', 'size', 'reason', 'modules'],
  properties: { clear: { type: 'boolean' }, questions: strs, size: { type: 'string', enum: ['small', 'full'] }, reason: str, modules: strs },
}
const CRIT = {
  type: 'object',
  required: ['issues'],
  properties: { issues: { type: 'array', items: { type: 'object', required: ['severity', 'where', 'problem', 'fix', 'evidence'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: str, problem: str, fix: str, evidence: str } } } },
}

try {
  // ---------- Context ----------
  phase('Context')
  // The CLI reads an existing .tdd-flow/stack.md and fetches GitHub issues and spec files. Text input needs no fetch.
  // Agents run only for what it could not get: stack detection on the first run, other trackers (Azure DevOps, Jira).
  const cx = await cli('context', recheck ? { feature: opt.feature } : { input }, CONTEXT, { label: 'context', phase: 'Context' })
  const known = cx.ok ? cx.result : { kind: 'unknown' }
  if (recheck && !(cx.ok && known.spec)) throw new Error(`tdd-flow: cannot recheck ${opt.feature}: ${cx.error || 'the context step returned no spec'}`)
  if (!cx.ok) log(`context: ${cx.error} - using the agents`)
  else if (known.note) log(`context: ${known.note} - ${recheck ? 'no requirement text, so the completeness critic is skipped' : 'fetching with an agent'}`)
  const firstLine = input.split('\n').find(l => l.trim()) || input
  const title = firstLine.trim().replace(/\s+/g, ' ').slice(0, 80)
  const textReq = known.kind === 'text' && {
    ok: true, title, text: input, source: 'prompt',
    slug: title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'feature',
  }
  const stackKnown = known.stack && !/^(unknown)?$/i.test(known.stack.testAll || '') ? known.stack : null
  // A recheck fetches nothing with agents: the stack is in stack.md, and a requirement the CLI could not fetch
  // (prompt text, another tracker) is left out, with the completeness critic.
  const [stack, fetched] = recheck ? [
    known.stack || { language: 'see .tdd-flow/stack.md', testAll: 'see .tdd-flow/stack.md' },
    known.req || { ok: true, title: known.spec.title, text: '', source: known.spec.source },
  ] : await parallel([
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
  // The spec folder names a rechecked spec: a slug computed from a title that changed since would point elsewhere.
  const req = recheck ? { ...fetched, slug: opt.feature } : fetched
  if (!stack || !req) throw new Error('tdd-flow: context step failed (see /workflows for the agent output).')
  if (!req.ok) throw new Error('tdd-flow: could not fetch the requirement. ' + (req.problem || ''))
  const dir = `.tdd-flow/features/${req.slug}`
  log(`Feature ${req.slug} - stack: ${stack.language}, tests: ${stack.testAll}`)
  // The CLI leaves out the spec of an issue or file; a text requirement's slug is only known here.
  const otherSpecs = (known.otherSpecs || []).filter(s => s.slug !== req.slug)
  const decisions = (known.decisions || []).filter(d => d.slug !== req.slug)
  if (otherSpecs.length) log(`${otherSpecs.length} other spec(s), ${decisions.length} earlier decision(s) to check against`)
  // state.json names the feature that commands without a slug work on. A new spec takes it over only from a finished
  // or missing one; another feature still in progress keeps it, so a bare /tdd-flow:tdd-implement does not switch.
  const active = !recheck && cx.ok && known.state && known.state.feature !== req.slug && !['done', 'missing'].includes(known.state.specStatus) ? known.state : null
  if (active) log(`.tdd-flow/state.json stays on ${active.feature} (spec ${active.specStatus}); pass {feature: "${req.slug}"} to the next workflows`)
  const stateStep = active
    ? `Do not change .tdd-flow/state.json: it names feature ${active.feature}, which is still ${active.specStatus}.\n`
    : cx.ok
      ? `Create or overwrite .tdd-flow/state.json as {"feature": "${req.slug}", "phase": "IDLE", "task": "T-1"}.\n`
      : `If .tdd-flow/state.json names another feature whose spec.md Status is not done, leave it unchanged and say so in assumptions; otherwise create or overwrite it as {"feature": "${req.slug}", "phase": "IDLE", "task": "T-1"}.\n`

  const precedents = otherSpecs.length || decisions.length
    ? 'The other specs of this repo (digest: title, status, AC names, out of scope) and their earlier decisions are below. ' +
      'Do not specify differently a behaviour another spec already specifies. A question that an earlier decision answers (same subject, same behaviour) is not an open question: ' +
      'write the criteria to match the decision and return it in `resolved` with from = "<slug> Q-<m>".\n' +
      `Other specs:\n${JSON.stringify(otherSpecs)}\nEarlier decisions:\n${JSON.stringify(decisions)}\n`
    : ''
  // A recheck starts from the spec on disk; the revisions return the rest.
  let spec = { specPath: `${dir}/spec.md`, tasksPath: `${dir}/tasks.md`, acCount: 0, tasks: [], openQuestions: [] }
  // The lane: "small" (one draft, three critics, one revision) or "full". `escalated` says why a small one became full.
  let lane = 'full', sizeReason = '', escalated = ''
  if (!recheck) {
  // ---------- Triage ----------
  // One agent before any draft: a requirement too vague to specify comes back as questions (one agent instead of
  // about twenty), and a small change takes the light lane. Not needed when the caller gave both size and answers.
  if (opt.size && answers) {
    lane = opt.size
    sizeReason = 'given as size'
  } else {
    phase('Triage')
    const triage = await run(
      'Triage this requirement before a spec is written. Do not write or change any file, and read at most 10 files.\n\n' +
      `Title: ${req.title}\nSource: ${req.source}\nRequirement:\n"""${req.text}"""\n\n` +
      (answers
        ? `The user already answered clarifying questions, so set clear = true and questions = []:\n"""${answers}"""\n\n`
        : '1. Clarity. The requirement is clear when its goal and what must change are stated or follow from the code. A gap with a safe assumption is not a reason to ask: it becomes an open question in the spec. ' +
          'Set clear = false only when, without an answer, one cannot tell what to build. Then return at most 5 questions, the ones that decide the most, each answerable in a sentence. Do not ask what an earlier decision below answers.\n') +
      '2. Size. "small" only if ALL of these hold: at most 3 tasks (a task is a few red-green cycles); the change stays in one module; no data migration or schema change; no new external API or service; no change to authentication, permissions or roles. In doubt: "full". ' +
      'Return in `modules` the top-level modules or directories the change touches, and in `reason` one sentence for the size.\n' +
      (decisions.length ? `Earlier decisions:\n${JSON.stringify(decisions)}\n` : ''),
      { schema: TRIAGE, model: M.worker, effort: 'low', label: 'triage', phase: 'Triage' })
    if (limitHit) throw new Error(LIMIT)
    if (!triage) log('triage: the agent failed - running the full analysis')
    if (triage && !triage.clear && !answers && triage.questions.length) {
      log(`The requirement is too vague to specify: ${triage.questions.length} question(s) for the user, no spec written`)
      return {
        status: 'needs_clarification',
        slug: req.slug,
        source: req.source,
        input,
        questions: triage.questions.slice(0, 5),
        next: 'No spec was written. Print the questions in chat as a numbered list, then ask them one at a time and wait for each answer. Then run this workflow again with {input: <the same input>, answers: "<every question with its answer>"}; it will not ask again.',
      }
    }
    // The estimate is backed by checks the agent cannot argue with: any of them sends the change to the full lane.
    const RISKY = /migrat|migrac|schema|schéma|auth(?!ors?\b)|autoriz|autentiz|login|přihl|prihl|permission|oprávn|opravn|\brol(e|es|i|í)\b|token|webhook|password|hesl/i
    // The answers count too: a clarification can turn a small change into a risky one.
    const asked = answers ? `${req.text}\n${answers}` : req.text
    const risky = (asked.match(RISKY) || [])[0]
    const against = !triage ? 'the triage agent failed'
      : triage.size !== 'small' ? triage.reason
      : triage.modules.length > 1 ? `it touches ${triage.modules.length} modules (${triage.modules.join(', ')})`
      : risky ? `the requirement mentions "${risky}"`
      : asked.length > 1500 ? 'the requirement is longer than 1500 characters'
      : ''
    lane = opt.size || (against ? 'full' : 'small')
    sizeReason = opt.size ? 'given as size' : against || triage.reason
    log(`Size: ${lane} (${sizeReason})`)
  }
  // The answers belong to the requirement: every draft and critic reads them with it.
  if (answers) req.text += `\n\nClarifications from the user:\n${answers}`

  // ---------- Draft (3 independent angles; 1 for a small change) ----------
  phase('Draft')
  const ANGLES = [
    { key: 'behaviour', lens: 'BEHAVIOUR-FIRST: focus on user goals and the observable happy-path behaviour that proves each goal.' },
    { key: 'risk', lens: 'RISK-FIRST: focus on edge cases, invalid input, error paths, limits, permissions, backward compatibility and security.' },
    { key: 'scope', lens: 'MINIMAL-SCOPE: find the smallest shippable slice, state what is explicitly out of scope, and order tasks so each builds on a passing previous one.' },
  ]
  const draft = (angles) => parallel(angles.map(a => () => run(
    `Analyse this requirement and draft a spec. Angle: ${a.lens}\n\n` +
    `Title: ${req.title}\nSource: ${req.source}\nRequirement:\n"""${req.text}"""\n\n` +
    `Stack: ${stack.language}; tests via \`${stack.testAll}\`.\n` +
    precedents +
    'Explore the codebase to ground the draft in real modules, entry points and existing tests. Every acceptance criterion must be verifiable by an automated test. ' +
    'Exception: config, infrastructure or scaffolding work that no test can describe (docker-compose, Dockerfile, CI, manifests, installing the test framework) goes into tasks with kind "setup" (see "Task kinds" in your instructions); give each of their criteria a verify command. A task that changes what the user sees is kind "ui"; a criterion only a browser can show returns its check in `browserCheck`. All other tasks are kind "tdd". Do NOT write any files - return the draft only.',
    { agentType: A('requirements-analyst'), model: M.worker, schema: DRAFT, label: `analyst:${a.key}`, phase: 'Draft' },
  ))).then(ds => ds.filter(Boolean))
  let drafts = await draft(lane === 'small' ? ANGLES.slice(0, 1) : ANGLES)
  // A draft bigger than a small change is a wrong estimate: the other two angles are drafted too, and the full lane
  // goes on with all three. The draft is not told the limit, so it does not merge tasks to stay under it.
  // A size the caller gave holds: only an estimate is corrected. A failed single draft is replaced by the other two.
  const big = lane !== 'small' ? '' : !drafts.length ? 'failed'
    : opt.size ? '' : drafts[0].tasks.length > 3 ? `has ${drafts[0].tasks.length} tasks` : drafts[0].acceptanceCriteria.length > 6 ? `has ${drafts[0].acceptanceCriteria.length} acceptance criteria` : ''
  if (big && !limitHit) {
    lane = 'full'
    escalated = `the first draft ${big}`
    log(`Not a small change (${escalated}) - running the full analysis`)
    drafts = [...drafts, ...await draft(ANGLES.slice(1))]
  }
  if (limitHit) throw new Error(LIMIT)
  if (!drafts.length) throw new Error('tdd-flow: all analyst drafts failed.')

  // ---------- Synthesize ----------
  phase('Synthesize')
  const synthPrompt = (extra) =>
    `Merge these ${drafts.length} independent spec drafts for "${req.title}" into ONE spec.\n` +
    'Do NOT simply take the union. Include an AC only if the requirement asks for it or it is an edge case a careful engineer would consider necessary; move speculative behaviour (unicode, performance, input types, limits not mentioned) to Open questions with an assumption instead of new ACs. ' +
    'Keep scope proportional: a small function needs roughly 3-6 ACs and 1-3 tasks; group closely related ACs into one task. Drop duplicates, keep ACs sharp and testable, number them AC-1.., EC-1.., Q-1.., T-1... Order tasks so each builds on the previous.\n' +
    `Write ${dir}/spec.md using your spec template (title line: # ${req.title}, Status: draft, Source: ${req.source}, Slug: ${req.slug}).\n` +
    `Write ${dir}/tasks.md as a checklist: "- [ ] T-1 <title> (AC-1, AC-2)"; end the line of a setup task with " [setup]" and of a ui task (it changes what the user sees) with " [ui]". A spec with ui tasks has a "## UI" section, and a criterion only a browser can show carries one "- **Check (browser):** ..." line (see "Task kinds" in your instructions). Every criterion of a setup task needs a "- **Verify:** \`<command>\`" line in spec.md (or "- **Verify (manual):**" only when no automatic check exists). In a repo with no test suite, put the setup task that installs the test framework before the first tdd task.\n` +
    stateStep +
    'If .tdd-flow/ is not in .gitignore, do not change .gitignore - just mention it in assumptions.\n' +
    (decisions.length
      ? 'Earlier decisions of other specs are below. An open question that one of them answers (same subject, same behaviour) is not listed as open: put it under ## Resolved questions as ' +
        '"- Q-<n> <question> - **Answer:** <answer>, as decided in <slug> Q-<m> (<dd.MM.yyyy of that decision>) → <where it went>", and apply the answer to the criteria. ' +
        'Only a decision that really covers the question counts; if two of them fit and disagree, keep the question open and name both. ' +
        'A draft\'s `resolved` entry counts only when its `from` names one of the decisions below; drop the others.\n' +
        `Earlier decisions:\n${JSON.stringify(decisions, null, 1)}\n`
      : '') +
    (answers
      ? 'The requirement ends with clarifications the user gave before this spec was written. Apply them to the criteria, and record each under ## Resolved questions as ' +
        '"- Q-<n> <question> - **Answer:** <answer> (<today as dd.MM.yyyy, from `date +%d.%m.%Y`>) → <where it went>", so a later check of the spec still has them.\n'
      : '') +
    (extra || '') +
    `\nRaw requirement:\n"""${req.text}"""\n\nDrafts:\n${JSON.stringify(drafts, null, 1)}`
  spec = await run(synthPrompt(), { agentType: A('requirements-analyst'), model: M.strong, schema: SPEC, label: 'synthesize' })
  if (!spec) throw new Error('tdd-flow: synthesis failed.')
  }

  // ---------- Critique ----------
  phase('Critique')
  const CRITICS = [
    { key: 'testability', ask: 'Check every AC: is it unambiguous, observable, and automatable with the repo\'s test framework? Flag vague words ("fast", "user-friendly"), hidden multiple behaviours in one AC, a "Must not" line a test cannot observe, and tasks too big for a few red-green cycles. Setup tasks ([setup] in tasks.md) are checked by verify commands instead of tests: flag a setup criterion without a Verify line or with a command that cannot tell pass from fail, and flag a setup task that contains logic a test could check (it must be a tdd task). A ui task ([ui]) may hold criteria with a "Check (browser)" line, which a browser checks instead of a test: flag such a line on a task that is not [ui], a browser check for something a DOM or component test could observe (text, role, name, state, keyboard), a criterion that says only "looks right" without saying what must be seen, a ui task that contains logic (validation, mapping, API calls), and a spec with ui tasks but no "## UI" section or no design reference and no open question about it.' },
    // No requirement text (a recheck of a spec written from prompt text): nothing to compare against.
    ...(req.text ? [{ key: 'completeness', ask: 'Compare the spec against the RAW requirement below. Flag anything required but missing, anything in the spec NOT supported by the requirement (invented scope), and edge cases a careful engineer would expect.' }] : []),
    {
      key: 'existing-tests',
      ask: `Stack: ${stack.language}; tests via \`${stack.testAll}\`. For every AC or task that changes, renames or removes something an existing test can observe (visible text, a glyph, markup, an attribute, a class name, a route, an API field, an error message, a behaviour), search the existing test files (git grep) for assertions on the OLD value. ` +
        'Report a hit only when the test asserts the old value on the same element, component, endpoint or function the AC changes, not every file that contains the word. ' +
        'A hit is a blocker unless the spec keeps the old value or already names that test (file:line) as one to update. Give where = the test file:line, problem = the assertion and the AC that changes it, fix = name the test in the AC and its task, or ask which wins when a criterion says existing tests stay unchanged.',
    },
    // The next three look for what otherwise stops a session during implementation with a question for the user.
    {
      key: 'task-order',
      ask: `Stack: ${stack.language}; tests via \`${stack.testAll}\`. Walk ${dir}/tasks.md task by task, in order. Each task is committed only when the FULL test suite is green, so the suite must pass after every single task, not only after the last one. ` +
        'For each task: (1) search the existing tests (git grep) for assertions on what the task changes, renames or removes, and check that the same task updates them; (2) check that nothing the task removes is still needed by a later task, by a test a later task rewrites, or by a criterion that stays; (3) check that a check the task adds (a test, a lint rule, a verify command) does not forbid something that stays until a later task; (4) check that a setup or refactor task changes no behaviour a test observes. ' +
        'Give where = the task ids and the test file:line (e.g. "T-7 vs T-8, tests/lookup.test.tsx:34"), problem = which test or criterion is red after which task, fix = merge the tasks, move the test update into the task that breaks it, or narrow the check. A suite left red between two tasks is a blocker.',
    },
    {
      key: 'grounding',
      ask: 'Check that the spec stands on what the repo really has. For every file, path, command, config key, placeholder, route, environment variable and library or framework API that an AC, a Verify line or a task names: ' +
        'does it exist; is a file that a test or a verify command reads tracked in git (`git ls-files`, `git check-ignore -v`; exit code 1 from check-ignore means "not ignored", it is not an error), so that it exists in a clean checkout and in a new worktree; ' +
        'does the framework or library accept it in the version the project\'s manifest pins and with the project\'s config (read the installed package\'s types, docs or source; do not answer from memory); ' +
        'can the data an AC expects reach the place where the AC checks it (for example a template that prints the field only inside a loop the case does not enter). ' +
        'Give where = the AC, Verify line or task id and the file:line that shows it, problem = what the spec assumes and what is there, fix = what to use from the repo, or the question for the user when only they can say.',
    },
    {
      key: 'consistency',
      ask: 'Look for contradictions inside this one spec. Compare every pair of criteria and edge cases that constrain the same function, call, element, route or stored row: can both be true for one input and one stored state? ' +
        'Also check each AC against Out of scope, against the Verify lines, and against any criterion that limits which existing tests or files may change (an allow-list). ' +
        'Give where = both ids (e.g. "AC-15 (b) vs AC-46"), problem = the input for which they disagree, fix = which one to change, or the question for the user when it is a product choice.',
    },
    // Contradictions with the other specs, found before approval. No other spec: no agent.
    ...(otherSpecs.length ? [{
      key: 'cross-spec',
      ask: 'Check the spec against the OTHER specs of this repo (digest below: title, status, AC names, out of scope) and their earlier decisions. ' +
        'Open only the specs you suspect: a path with ":" is `<ref>:<file>`, read it with `git show <path>`; any other path is a file. Report: the same behaviour specified differently, an AC that breaks an AC of another spec, a term used with two meanings, ' +
        'something required here and out of scope there, a question resolved "as decided in" another spec where that decision does not fit, and earlier decisions that contradict each other. ' +
        'Give where = this spec\'s id and the other spec\'s slug and id (e.g. "AC-2 vs 12-csv AC-1"), problem = the contradiction, fix = the earlier decision that settles it, or the question for the user when none does.\n' +
        `Other specs:\n${JSON.stringify(otherSpecs)}\nEarlier decisions:\n${JSON.stringify(decisions)}`,
    }] : []),
  ]
  // A rechecked spec can be partly built (a spec the autopilot stopped with a decision): its commits must keep matching tasks.md.
  const DONE_TASKS = 'Tasks ticked "[x]" in tasks.md are implemented and committed: judge only the open tasks, and never change, merge, renumber or untick a ticked one; a change a ticked task needs goes into a new task.\n'
  // What counts as proof of a blocker or major issue, per critic. A replay on 8 approved specs gave about 19 serious
  // issues per spec; each one starts a revision and some become questions for the user, so a serious issue needs proof.
  const SPEC_LINE = 'the spec line it is about, quoted'
  const FILE_LINE = 'the file:line you read in the repo, with the line quoted'
  const PROOF = {
    testability: SPEC_LINE, consistency: 'both spec lines, quoted', completeness: 'the sentence of the requirement, quoted',
    'existing-tests': FILE_LINE, 'task-order': FILE_LINE, grounding: FILE_LINE, 'cross-spec': 'the other spec\'s slug and id, with its line quoted',
  }
  const MAX_MAJOR = 3
  // A serious issue without proof, and a major one past the limit, counts as minor: it is logged, not revised.
  // Not limited: existing-tests and cross-spec, which list facts the approval gate shows (every broken test counts),
  // and round two, where an issue reported again is one the revision did not fix and must not look fixed.
  const LISTS_FACTS = ['existing-tests', 'cross-spec']
  const tame = (issues, key, earlier) => {
    let majors = 0
    return issues.map(issue => {
      if (issue.severity === 'minor') return issue
      if (earlier && earlier.some(e => e.critic === key && e.where === issue.where)) return issue
      const why = !(issue.evidence || '').trim() ? 'no proof' : issue.severity === 'major' && !earlier && !LISTS_FACTS.includes(key) && ++majors > MAX_MAJOR ? `over the limit of ${MAX_MAJOR} major issues` : ''
      if (!why) return issue
      log(`critic:${key}: "${issue.where}" counted as minor (${why})`)
      return { ...issue, severity: 'minor', was: issue.severity }
    })
  }
  // One round of critics. Round two gets the round-one issues: it checks the fixes and what the revision broke.
  const critique = async (list, earlier) => (await parallel(list.map(c => () => run(
    `You are a skeptical reviewer of ${dir}/spec.md and ${dir}/tasks.md. ${c.ask}\n` +
    (earlier
      ? 'This is the second round: the spec was revised to fix the review issues below. Check that each issue marked as yours is fixed and report the ones that are not. Then review only what the revision changed, and report new problems it brought in. Do not start the review over.\n' +
        `Round-one issues (yours have critic "${c.key}"):\n${JSON.stringify(earlier, null, 1)}\n`
      : '') +
    (recheck ? DONE_TASKS : '') +
    'Severity: blocker or major only when implementation would stop, or a test could not be written or would fail as specified. Wording, style and detail that would be nice to have are minor. ' +
    `Every blocker or major issue needs proof in \`evidence\`: ${PROOF[c.key]}. Without proof, report it as minor. ${earlier || LISTS_FACTS.includes(c.key) ? '' : `Report at most ${MAX_MAJOR} major issues, the ones most likely to stop implementation, most likely first; blockers are not limited.`}\n` +
    'Only report real problems; do not edit files. This reviews the spec text, not code: do not run the test suite or lint.' +
    (req.text ? `\n\nRaw requirement:\n"""${req.text}"""` : ''),
    { schema: CRIT, model: M.worker, label: `critic:${c.key}${earlier ? ' (round 2)' : ''}`, phase: 'Critique', agentType: A('code-reviewer') },
  )))).flatMap((c, i) => tame(c ? c.issues : [], list[i].key, earlier).map(issue => ({ ...issue, critic: list[i].key })))
  // The last revision is checked by no critic: it says itself what it could not fix (deferred).
  const revise = (issues, last) => run(
    `Revise ${dir}/spec.md and ${dir}/tasks.md to fix these review issues. Where an issue needs information only the user has, add it to Open questions with your assumption instead of guessing.\n` +
    'Do not change what ## Resolved questions decided: a finding against one of them becomes a new Open question that names that Q id.\n' +
    'An existing test that asserts what the spec changes: if no criterion says existing tests stay unchanged, name the test (file:line) and its new assertion in the AC and in the task that makes the change, so the test-writer updates it in RED. If a criterion says they stay unchanged, the spec contradicts itself: add an Open question (which wins), with your assumption; do not resolve it silently.\n' +
    'A task-order issue: the full suite must be green after every task. Merge the tasks, move the update of the existing test into the task that breaks it, or narrow the check; keep the task table and tasks.md in step.\n' +
    'A grounding issue: use what the repo really has. Where only the user can say (a file that is not in git, an API the installed version refuses, data that cannot reach the place the AC checks), add an Open question with your assumption.\n' +
    'Two criteria that contradict each other (consistency): fix it when one of them clearly follows from the requirement; otherwise add an Open question (which wins) that names both ids, with your assumption.\n' +
    'A contradiction with another spec (cross-spec): if an earlier decision settles it, fix the spec from that decision and record it under ## Resolved questions ("as decided in <slug> Q-<m>"). If it needs the user, add an Open question that names both specs (slug and id) and your assumption.\n' +
    (recheck ? DONE_TASKS + 'If the spec says Status: approved (or later) and you change criteria or tasks, set Status: draft.\n' : '') +
    (last ? 'This is the last revision and no critic checks it. Fix what you safely can. Return in `deferred` every issue you could not fix, one line each ("<where>: <problem>"), and add each of them to Open questions with your assumption.\n' : '') +
    JSON.stringify(issues, null, 1),
    { agentType: A('requirements-analyst'), model: M.strong, schema: SPEC, label: last && lane !== 'small' ? 'revise (round 2)' : 'revise', phase: 'Critique' })
  const isSerious = i => i.severity !== 'minor'
  const line = i => `${i.where}: ${i.problem}`

  // A small change gets the three critics that found the implementation questions in a replay of 8 approved specs.
  // A blocker from one of them means the spec has a real defect: the other critics run too and the full lane goes on.
  const LIGHT = ['existing-tests', 'task-order', 'grounding']
  let round1 = await critique(lane === 'small' ? CRITICS.filter(c => LIGHT.includes(c.key)) : CRITICS)
  if (limitHit) throw new Error(LIMIT)
  if (lane === 'small' && !opt.size && round1.some(i => i.severity === 'blocker')) {
    lane = 'full'
    escalated = 'a critic found a blocker'
    log(`Not a small change (${escalated}) - running the other critics and the second round`)
    round1 = [...round1, ...await critique(CRITICS.filter(c => !LIGHT.includes(c.key)))]
    if (limitHit) throw new Error(LIMIT)
  }
  const serious1 = round1.filter(isSerious)
  let round2 = [], unresolved = []
  if (serious1.length) {
    log(`Critics raised ${serious1.length} blocker/major issue(s) - revising the spec`)
    // The small lane has one revision and no second round: that revision says itself what it could not fix.
    const revised = await revise(serious1, lane === 'small')
    if (!revised) {
      unresolved = serious1.map(line)
    } else if (lane === 'small') {
      spec = revised
      unresolved = revised.deferred || []
    } else {
      // Round two: the critics that had a serious issue, consistency (a revision can bring in a contradiction),
      // and task-order when the revision changed the tasks. A rechecked spec's tasks are not known here.
      const tasksChanged = recheck || JSON.stringify(revised.tasks) !== JSON.stringify(spec.tasks)
      spec = revised
      const flagged = new Set(serious1.map(i => i.critic))
      const again = CRITICS.filter(c => flagged.has(c.key) || c.key === 'consistency' || (c.key === 'task-order' && tasksChanged))
      round2 = await critique(again, serious1)
      if (limitHit) throw new Error(LIMIT)
      const serious2 = round2.filter(isSerious)
      if (serious2.length) {
        log(`Round two: ${serious2.length} blocker/major issue(s) left or new - revising once more`)
        const last = await revise(serious2, true)
        if (last) spec = last
        unresolved = last ? last.deferred || [] : serious2.map(line)
      }
    }
  } else {
    log('Critics found no blocker/major issues')
  }
  if (unresolved.length) log(`${unresolved.length} review issue(s) not fixed - shown at the approval gate`)
  const all = [...round1, ...round2]
  const minor = all.filter(i => !isSerious(i))
  if (minor.length) log(`${minor.length} minor critique note(s) not applied - see the critic agents in /workflows`)
  // Shown at the approval gate, from both rounds: existing tests that assert what the spec changes, and
  // contradictions with other specs.
  const hits = (key) => [...new Map(all.filter(i => isSerious(i) && i.critic === key).map(i => [i.where, i])).values()].map(line)
  const testHits = hits('existing-tests'), crossHits = hits('cross-spec')
  if (testHits.length) log(`Existing tests assert what the spec changes: ${testHits.length}`)
  if (crossHits.length) log(`Contradictions with other specs: ${crossHits.length}`)
  const found = {
    // Round two reports an unfixed round-one issue again: count each critic's issue at one place once.
    critiqueFixesApplied: Math.max(0, new Set(all.filter(isSerious).map(i => `${i.critic} ${i.where}`)).size - unresolved.length),
    existingTestsChanged: testHits,
    crossSpecFindings: crossHits,
    unresolvedFindings: unresolved,
  }

  if (recheck) {
    return {
      status: 'spec_rechecked',
      slug: req.slug,
      specPath: spec.specPath,
      tasksPath: spec.tasksPath,
      // acCount is 0 only in the placeholder, which a revision replaces.
      specChanged: spec.acCount > 0,
      // Every open question of the revised spec. Without a revision the spec on disk is unchanged and not read here.
      ...(spec.acCount > 0 ? { openQuestions: spec.openQuestions } : {}),
      ...found,
      next: 'Show the user what the recheck changed in spec.md and tasks.md (diff against the copies taken before the run), with existingTestsChanged, crossSpecFindings and unresolvedFindings (review issues the revision could not fix, now open questions). Ask the open questions the spec has now, one at a time. Do not run the recheck again in this conversation. A spec whose Status went back to draft needs the user\'s approval again.',
    }
  }
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
    // Which analysis ran: "small" (one draft, three critics, one revision) or "full"; escalated = why a small one became full.
    size: lane,
    sizeReason,
    ...(escalated ? { escalated } : {}),
    ...found,
    ...(active ? { stateKept: `.tdd-flow/state.json still names ${active.feature} (spec ${active.specStatus}), so commands without a slug work on that feature. Pass {feature: "${req.slug}"} to tdd-implement, document and deploy, or delete ${active.feature}'s spec folder if it is abandoned.` } : {}),
    next: 'GATE: say which analysis ran (size with sizeReason, and escalated when set; a small one can be run again with {input, size: "full"}). Show the user the spec summary, including existingTestsChanged (existing tests the spec changes), crossSpecFindings (contradictions with other specs, fixed from an earlier decision or now an open question) and unresolvedFindings (review issues the last revision could not fix, now open questions). Print the open questions in chat as a numbered list, then ask them one at a time and update spec.md after each answer (/tdd-flow:resolve-questions <slug>). After they approve, set "Status: approved" in spec.md, then run /tdd-flow:tdd-implement.',
  }
} catch (e) {
  if (!limitHit) throw e
  return {
    status: 'agent_limit',
    agentsUsed: spawned,
    next: `Stopped at the agent limit (${MAX_AGENTS} agents per run). Rerun with a higher {maxAgents}. Resuming this run replays its finished agents, and they still count toward the limit.`,
  }
}
