export const meta = {
  name: 'tdd-implement',
  description: 'Implement an approved tdd-flow spec task by task: failing tests first (test-writer), then code (implementer), per-task review and commits',
  whenToUse: 'After the spec is approved. args: feature slug (optional), or {feature, fromTask, maxTasks, findings, batchSize}',
  phases: [
    { title: 'Plan', detail: 'load spec and tasks, baseline test run' },
    { title: 'Implement', detail: 'per task: RED test-writer writes all failing tests -> GREEN implementer makes them pass and refactors' },
    { title: 'Review', detail: 'review, fix loop, commit per task' },
  ],
}

// ---------- input ----------
const opt = typeof args === 'string' ? { feature: args } : (args || {})
const A = (type) => 'tdd-flow:' + type
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
const MAX_REVIEW_ROUNDS = 2
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, opt.models || {})
// Agent limits. Override per run with args {maxAgents, maxParallel} (positive integers).
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const MAX_AGENTS = posInt(opt.maxAgents, 40)
const MAX_PARALLEL = posInt(opt.maxParallel, 2)
// Behaviours per RED/GREEN pair. Bounds agent context and retry cost; batchSize 1 gives one cycle per behaviour.
const BATCH = posInt(opt.batchSize, 5)
const LIMIT = `tdd-flow: agent limit (${MAX_AGENTS}) reached`
let spawned = 0, active = 0, limitHit = false
const waiting = []
// Every agent call goes through run(): at most MAX_PARALLEL at once, started in request order,
// and at most MAX_AGENTS per run. The last slot is reserved for final bookkeeping (final = true).
async function run(prompt, o, final = false) {
  if (spawned >= MAX_AGENTS - (final ? 0 : 1)) { limitHit = true; throw new Error(LIMIT) }
  spawned++
  if (active < MAX_PARALLEL) active++
  else await new Promise(r => waiting.push(r))
  try { return await agent(prompt, o) } finally { if (waiting.length) waiting.shift()(); else active-- }
}

const PLAN = {
  type: 'object',
  required: ['slug', 'approved', 'testAll', 'testSingle', 'baselinePass', 'tasks'],
  properties: {
    slug: str, status: str, approved: { type: 'boolean' },
    testAll: str, testSingle: str, lint: str, testPattern: str,
    baselinePass: { type: 'boolean' }, baselineSummary: str, noTestSuite: { type: 'boolean' },
    taskCount: { type: 'integer' }, openIds: strs,
    tasks: { type: 'array', items: { type: 'object', required: ['id', 'title', 'done', 'behaviours'], properties: {
      id: str, title: str, done: { type: 'boolean' }, kind: { type: 'string', enum: ['tdd', 'setup'] },
      behaviours: { type: 'array', items: { type: 'object', required: ['ref', 'text'], properties: { ref: str, text: str } } },
      verify: { type: 'array', items: { type: 'object', required: ['ref', 'command'], properties: { ref: str, command: str, manual: { type: 'boolean' } } } },
    } } },
  },
}
const SETUP = {
  type: 'object',
  required: ['suitePass', 'filesChanged', 'summary', 'verifyResults'],
  properties: {
    suitePass: { type: 'boolean' }, filesChanged: strs, summary: str, failures: str, concerns: str, testAll: str, testSingle: str,
    verifyResults: { type: 'array', items: { type: 'object', required: ['command', 'result'], properties: {
      command: str, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, note: str,
    } } },
  },
}
const REDS = {
  type: 'object',
  required: ['tests'],
  properties: { tests: { type: 'array', items: { type: 'object', required: ['ref', 'result', 'testFile', 'testName', 'reason'], properties: {
    ref: str, result: { type: 'string', enum: ['FAIL', 'PASS', 'ERROR'] }, testFile: str, testName: str, command: str, reason: str,
  } } } },
}
const GREEN = {
  type: 'object',
  required: ['tests', 'suitePass', 'filesChanged', 'summary'],
  properties: {
    tests: { type: 'array', items: { type: 'object', required: ['ref', 'pass'], properties: { ref: str, pass: { type: 'boolean' } } } },
    suitePass: { type: 'boolean' }, filesChanged: strs, summary: str, failures: str, concerns: str,
    testDefects: { type: 'array', items: { type: 'object', required: ['ref', 'reason'], properties: { ref: str, reason: str } } },
  },
}
const CODE = {
  type: 'object',
  required: ['singlePass', 'suitePass', 'filesChanged', 'summary'],
  properties: { singlePass: { type: 'boolean' }, suitePass: { type: 'boolean' }, filesChanged: strs, summary: str, failures: str, concerns: str },
}
const REVIEW = {
  type: 'object',
  required: ['verdict', 'testsPass', 'findings', 'uncoveredAcs'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'CHANGES_REQUESTED'] }, testsPass: { type: 'boolean' }, lintPass: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'where', 'issue', 'behavioural'], properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: str, issue: str, fix: str, behavioural: { type: 'boolean' },
    } } },
    uncoveredAcs: strs,
  },
}
const BRANCH = { type: 'object', required: ['branch'], properties: { branch: str } }
const COMMIT = { type: 'object', required: ['committed'], properties: { committed: { type: 'boolean' }, nothingToCommit: { type: 'boolean' }, ticked: { type: 'boolean' }, specStatus: str, specStatusSkipped: str, sha: str, reason: str, unexpected: strs } }
const BLOCK = { type: 'object', required: ['logged'], properties: { logged: { type: 'boolean' }, unticked: { type: 'boolean' } } }

// Deterministic steps run in the plugin's CLI (bin/tdd-flow) through the script-runner agent (haiku, Bash only)
// instead of a reasoning agent. Returns {ok, result} or {ok: false, error, fallback}. Identical in every workflow
// (scripts cannot import; tests/cli.test.cjs checks the copies match).
const cliSchema = (schema) => ({ type: 'object', required: ['ok'], properties: {
  ok: { type: 'boolean' }, error: str, fallback: { type: 'boolean' }, again: { type: 'boolean' }, result: schema } })
async function cli(cmd, input, schema, o = {}) {
  const r = await run(
    `Run with the Bash tool (timeout 600000):\n\ntdd-flow ${cmd} <<'TDD_FLOW_JSON'\n${JSON.stringify(input)}\nTDD_FLOW_JSON\n\n` +
    (o.repeat ? `While the printed JSON has "again": true, run the identical command again (at most ${o.repeat} runs).\n` : '') +
    'Return the printed JSON object as your structured output.',
    { agentType: A('script-runner'), model: o.model || M.light, effort: 'low', schema: cliSchema(schema), label: o.label || cmd, phase: o.phase, ...(o.stallMs ? { stallMs: o.stallMs } : {}) },
    o.final)
  if (!r) return { ok: false, error: 'script-runner agent failed' }
  return r.ok && !r.result ? { ok: false, error: 'the command returned no result' } : r
}

// ---------- Plan ----------
phase('Plan')
// The CLI parses spec.md/tasks.md and runs the baseline. For a spec it cannot parse it reports fallback, and the
// planning agent does the same work.
const planInput = { feature: opt.feature || null, maxTasks: opt.maxTasks || null, fromTask: opt.fromTask || null }
// The relay must hand over every task: a dropped task would look done (and could mark the spec implemented).
const relayProblem = (p) => {
  if (!Number.isInteger(p.taskCount) || !Array.isArray(p.openIds)) return 'no taskCount/openIds in the plan'
  if (p.tasks.length !== p.taskCount) return `${p.tasks.length} of ${p.taskCount} tasks relayed`
  const open = p.tasks.filter(t => !t.done).map(t => t.id).join(',')
  return open === p.openIds.join(',') ? '' : `open tasks relayed as [${open}], the CLI found [${p.openIds.join(',')}]`
}
let planned = await cli('plan', planInput, PLAN, { label: 'plan' })
if (planned.ok && relayProblem(planned.result)) {
  log(`plan: ${relayProblem(planned.result)} - relaying again on ${M.worker}`)
  const first = planned.result
  // The baseline already ran in the first call: keep its result instead of running the suite again.
  planned = await cli('plan', { ...planInput, baseline: false }, PLAN, { label: 'plan (relay retry)', model: M.worker })
  if (planned.ok) Object.assign(planned.result, { baselinePass: first.baselinePass, baselineSummary: first.baselineSummary })
  if (planned.ok && relayProblem(planned.result)) throw new Error(`tdd-flow: the plan was not relayed completely (${relayProblem(planned.result)}). Rerun, or pass {models: {light: "sonnet"}}.`)
}
if (!planned.ok && !planned.fallback) throw new Error(`tdd-flow: planning failed. ${planned.error}`)
if (!planned.ok) log(`plan: ${planned.error} - using the planning agent`)
const plan = planned.ok ? planned.result : await run(
  'Prepare a tdd-flow implementation run.\n' +
  `1. Feature slug: ${opt.feature ? '"' + opt.feature + '"' : 'read "feature" from .tdd-flow/state.json'}. Read .tdd-flow/features/<slug>/spec.md and tasks.md, and .tdd-flow/stack.md (if stack.md is missing, detect the test commands yourself and write it).\n` +
  '2. approved = true only if spec.md has "Status: approved".\n' +
  '3. Run the full test suite once as a baseline; report pass/fail and a short summary. If the repo has no test framework or no tests yet (stack.md says "none", or no test command exists), do not run anything: set noTestSuite = true, baselinePass = true and testAll/testSingle = "none".\n' +
  '4. For every task in tasks.md return id, title, done (checkbox ticked) and its behaviours: one entry per acceptance criterion or edge case mapped to the task, in implementation order (simplest happy path first). ref = AC/EC id, text = the full Given/When/Then or edge-case text.\n' +
  '   kind = "setup" if the task line ends with "[setup]" (or its Kind in the spec task table is setup), otherwise "tdd". For setup tasks also return verify: one entry per "Verify:" line of the task\'s criteria in spec.md, with ref = AC id and command = the exact command; for a "Verify (manual):" line set manual = true and command = the check text.\n' +
  'Do not modify source or test files. Do not run git commands that change anything.',
  { schema: PLAN, model: M.worker, label: 'plan (agent)', effort: 'low' })
if (!plan) throw new Error('tdd-flow: planning failed.')
if (!plan.approved && !opt.force) throw new Error(`tdd-flow: spec for ${plan.slug} is not approved. Review it and set "Status: approved" in spec.md (or pass {force: true}).`)
// Test commands can be "none"/"unknown" in a repo being bootstrapped; a setup task may add them later.
const none = (v) => !v || /^(none|unknown|n\/a)\b/i.test(String(v).trim())
let hasTests = !plan.noTestSuite && !none(plan.testAll)
const tests = { all: plan.testAll, single: plan.testSingle }
if (!plan.baselinePass && hasTests && !opt.allowRedBaseline) throw new Error(`tdd-flow: baseline test suite is failing - fix it first or pass {allowRedBaseline: true}. ${plan.baselineSummary || ''}`)
const branched = await cli('branch', { slug: plan.slug }, BRANCH, { label: 'branch' })
if (!branched.ok) throw new Error(`tdd-flow: creating the feature branch failed. ${branched.error}`)
const br = branched.result

const dir = `.tdd-flow/features/${plan.slug}`
const ctxFor = () => `Feature: ${plan.slug}. Spec: ${dir}/spec.md. ` +
  (hasTests ? `Test all: \`${tests.all}\`. Single test: \`${tests.single}\`. Run tests as \`tdd-flow test -- '<command>'\` (prints only the exit code and the failure tail).` : 'No test suite yet.') +
  (plan.lint ? ` Lint: \`${plan.lint}\`.` : '')
let ctx = ctxFor()

const allOpen = plan.tasks.filter(t => !t.done)
let tasks = allOpen.slice()
if (opt.fromTask) { const i = tasks.findIndex(t => t.id === opt.fromTask); if (i > 0) tasks = tasks.slice(i) }
if (opt.findings && opt.findings.length) {
  tasks.unshift({ id: 'FIX', title: 'Address review findings', done: false,
    behaviours: opt.findings.map((f, i) => ({ ref: `F-${i + 1}`, text: typeof f === 'string' ? f : JSON.stringify(f) })) })
}
if (opt.maxTasks && tasks.length > opt.maxTasks) { log(`Limiting this run to ${opt.maxTasks} of ${tasks.length} open tasks`); tasks = tasks.slice(0, opt.maxTasks) }
// A task this run implements must come with its criteria; with none, the cycle would do nothing and tick it.
const empty = tasks.filter(t => t.id !== 'FIX' && !(t.behaviours && t.behaviours.length))
if (empty.length) throw new Error(`tdd-flow: the plan has no criteria for ${empty.map(t => t.id).join(', ')}. Rerun; if it repeats, check the AC/EC ids of these tasks in tasks.md and spec.md.`)
if (!tasks.length) {
  // Every task is ticked but the spec was never marked (e.g. finished before the status existed): mark it now.
  let specStatus = plan.status || null
  if (plan.status === 'approved' && !allOpen.length) {
    const marked = await cli('commit', { message: `chore(${plan.slug}): mark spec implemented`, files: [`${dir}/spec.md`],
      specStatus: { file: `${dir}/spec.md`, value: 'implemented' } }, COMMIT, { label: 'mark implemented', phase: 'Review' })
    if (marked.ok && marked.result.specStatus === 'implemented') specStatus = 'implemented'
    else log(`spec status not set to implemented - ${marked.ok ? marked.result.specStatusSkipped || marked.result.reason || 'nothing committed' : marked.error}`)
  }
  return { status: 'nothing_to_do', slug: plan.slug, branch: br.branch, specStatus, next: 'All tasks are ticked. Run /tdd-flow:document.' }
}
log(`${tasks.length} task(s) to implement on ${br.branch}`)

// ---------- helpers ----------
async function blocked(task, step, details, untick = false, next = '') {
  const rec = await cli('block', { dir, task: task.id, step, details, untick }, BLOCK, { label: 'record-block', phase: 'Review', final: true })
  if (!rec.ok) log(`record-block failed: ${rec.error}`)
  return { status: 'blocked', slug: plan.slug, task: task.id, step, details,
    escalationsToStrongModel: escalations, unverified: [...unverified.values()],
    next: next || 'The step failed on both models. Show the user the details. After the issue is resolved, rerun /tdd-flow:tdd-implement (it resumes from tasks.md).' }
}

// Escalation ladder: worker model, worker model with feedback, then strong model with feedback.
// Only steps that fail twice reach the strong model. `attempts` holds every result, because an attempt that
// did not succeed may still have changed files that belong to the task.
let escalations = 0
// `stop(r)`: a result that ends the ladder early without success (a further attempt would not help).
async function escalate(name, run, ok, feedback, stop = null) {
  const ladder = [
    { model: M.worker, suffix: '' },
    { model: M.worker, suffix: ' retry' },
    { model: M.strong, suffix: ' ESCALATED' },
  ]
  let last = null
  const attempts = []
  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i]
    if (i === 2) { escalations++; log(`${name}: failed twice on ${M.worker} - escalating to ${M.strong}`) }
    const extra = i === 0 ? '' : (last ? '\n\nA previous attempt did not succeed:\n' + feedback(last) : '\n\nA previous attempt crashed; start fresh.')
    const r = await run(step.model, extra, name + step.suffix)
    if (r) attempts.push(r)
    if (r && ok(r)) return { ok: true, result: r, attempts, escalated: i === 2 }
    if (r && stop && stop(r)) return { ok: false, result: r, attempts, stopped: true }
    if (r) last = r
  }
  return { ok: false, result: last, attempts }
}
const changedFiles = (attempts) => attempts.flatMap(a => a.filesChanged || [])
// Agents may label a behaviour differently ("AC-8b" for "AC-8b (schema part)"): refs match by their id.
const refKey = (ref) => String(ref || '').trim().split(/[\s(:]/)[0]
const sameRef = (a, b) => refKey(a) === refKey(b)

// RED then GREEN for a list of behaviours, in batches of BATCH. A separate test-writer writes every failing test of
// the batch before the implementer changes production code. `structural` review findings go into the last GREEN call.
// Returns {ok:true, files, greenRan, structuralDone, testFixes} | {ok:false, step, details}
async function tddStep(task, items, structural = []) {
  const files = [], testFixes = []
  let greenRan = false, structuralDone = false
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const refs = batch.map(b => b.ref)
    const reportFor = (r, ref) => r.tests.find(t => sameRef(t.ref, ref))
    const isLastBatch = i + BATCH >= items.length
    const tag = `${task.id} ${refs.length > 1 ? refs[0] + '..' + refs[refs.length - 1] : refs[0]}`

    // RED succeeds only if every requested ref is reported and none errored.
    const redProblems = (r) => [
      ...refs.filter(ref => !reportFor(r, ref)).map(ref => `${ref}: no test reported`),
      ...refs.map(ref => reportFor(r, ref)).filter(t => t && t.result === 'ERROR').map(t => `${t.ref}: ${t.reason}`),
    ]
    const red = await escalate(`${tag} RED`,
      (model, extra, label) => run(
        `RED step. ${ctx}\nTask ${task.id}: ${task.title}\nBehaviours, in order:\n${batch.map(b => `- ${b.ref}: ${b.text}`).join('\n')}\n` +
        'Write ONE failing test per behaviour, run each, and confirm each fails for the expected reason. Report one entry per behaviour with its ref.' + extra,
        { agentType: A('test-writer'), model, schema: REDS, label, phase: 'Implement' }),
      r => !redProblems(r).length,
      r => `These behaviours are not done:\n${redProblems(r).join('\n')}\nThe tests for the other behaviours are already on disk and correct: do not rewrite or duplicate them. ` +
        'Fix or write only the tests listed here so each fails on the behaviour itself, then report every behaviour of the batch again.')
    red.attempts.forEach(a => a.tests.forEach(t => t.testFile && files.push(t.testFile)))
    if (!red.ok) return { ok: false, step: `RED ${refs.join(', ')}`, details: red.result ? redProblems(red.result).join('\n') : 'agent failed' }
    // Each report carries the plan's ref from here on, whatever exact label the test-writer used.
    const reported = refs.map(ref => ({ ...reportFor(red.result, ref), ref }))
    reported.filter(t => t.result === 'PASS').forEach(t => log(`${task.id} ${t.ref}: test passed immediately - behaviour already exists`))
    if (!reported.some(t => t.result === 'FAIL')) continue

    // GREEN succeeds only if every listed test is reported passing and the full suite is green.
    const withStructural = isLastBatch && structural.length > 0
    let failing = reported.filter(t => t.result === 'FAIL')
    const greenProblems = (r) => [
      ...failing.filter(t => !r.tests.some(x => sameRef(x.ref, t.ref) && x.pass)).map(t => `${t.ref}: ${t.testFile} :: ${t.testName} is not passing`),
      ...(r.suitePass ? [] : ['the full suite is failing']),
    ]
    // The implementer reports a test it believes is wrong instead of editing it or bending production code to it.
    const defectsIn = (r) => (r.testDefects || []).filter(d => failing.some(t => sameRef(t.ref, d.ref)))
    const greenRun = (verdicts, stop) => escalate(`${tag} GREEN${verdicts ? ' (after test fix)' : ''}`,
      (model, extra, label) => run(
        `GREEN step. ${ctx}\nTask ${task.id}: ${task.title}\nFailing tests, in order:\n` +
        failing.map(t => `- ${t.ref}: ${t.testFile} :: ${t.testName}\n  Failure: ${t.reason}\n  Behaviour: ${batch.find(b => sameRef(b.ref, t.ref)).text}`).join('\n') + '\n' +
        'Make them pass one at a time, in this order, with minimal code, running each single test as you go. Then refactor the code changed in this step and run the full suite.\n' +
        (withStructural ? `Also address these non-behavioural review findings without changing behaviour:\n${JSON.stringify(structural, null, 1)}\n` : '') +
        (verdicts ? `The test-writer has reviewed the tests you reported as wrong; the tests on disk are now authoritative:\n${verdicts}\n`
          : 'If a test itself is wrong (it contradicts the behaviour, a test helper is broken, it reads the wrong field), do not edit it and do not bend production code to it: report it in testDefects with its ref and the reason (file:line, what is wrong, what the behaviour says), and stop.\n') +
        `Append one entry per behaviour (RED + GREEN lines) and one REFACTOR line for ${task.id} to ${dir}/tdd-log.md. Report each test by ref.` + extra,
        { agentType: A('implementer'), model, schema: GREEN, label, phase: 'Implement' }),
      r => !greenProblems(r).length,
      r => `Not done yet:\n${greenProblems(r).join('\n')}\n${r.failures || r.summary}\nThe work already done is on disk: inspect the current code first. Fix production code, never the tests.`,
      stop)
    let green = await greenRun('', r => defectsIn(r).length > 0)
    files.push(...changedFiles(green.attempts))
    if (green.stopped) {
      // One test-fix round per batch: the test-writer fixes the named tests or confirms them, then GREEN runs again.
      const defects = defectsIn(green.result).map(d => ({ ...d, test: failing.find(t => sameRef(t.ref, d.ref)) }))
      log(`${tag}: implementer reports ${defects.length} wrong test(s) - ${defects.map(d => d.test.ref).join(', ')} back to the test-writer`)
      const fixRefs = defects.map(d => d.test.ref)
      const fixProblems = (r) => [
        ...fixRefs.filter(ref => !reportFor(r, ref)).map(ref => `${ref}: no test reported`),
        ...fixRefs.map(ref => reportFor(r, ref)).filter(t => t && t.result === 'ERROR').map(t => `${t.ref}: ${t.reason}`),
      ]
      const fix = await escalate(`${tag} TEST FIX`,
        (model, extra, label) => run(
          `TEST FIX step. ${ctx}\nTask ${task.id}: ${task.title}\nThe implementer reports these tests as wrong. Production code for them is already (partly) written; do not touch it.\n` +
          defects.map(d => `- ${d.test.ref}: ${d.test.testFile} :: ${d.test.testName}\n  Reported defect: ${d.reason}\n  Behaviour: ${batch.find(b => sameRef(b.ref, d.test.ref)).text}`).join('\n') + '\n' +
          'For each test, check the report against the behaviour and the code base. If the test (or a test helper it uses) is wrong, fix only that test code. Never weaken what the test asserts about the behaviour. ' +
          'If the test is right, leave it unchanged. Run each test and report it (PASS or FAIL; ERROR only if it cannot run). Start each reason with "fixed: <what changed>" or "unchanged: <why the test is right>". ' +
          `Append a "TEST FIX" entry per test to ${dir}/tdd-log.md: the reported defect, your verdict and the change.` + extra,
          { agentType: A('test-writer'), model, schema: REDS, label, phase: 'Implement' }),
        r => !fixProblems(r).length,
        r => `Not done:\n${fixProblems(r).join('\n')}`)
      fix.attempts.forEach(a => a.tests.forEach(t => t.testFile && files.push(t.testFile)))
      if (!fix.ok) return { ok: false, step: `TEST FIX ${fixRefs.join(', ')}`, details: fix.result ? fixProblems(fix.result).join('\n') : 'agent failed' }
      // The rewritten tests replace the old entries (names may have changed); a fixed test may already pass.
      failing = failing.map(t => { const n = reportFor(fix.result, t.ref); return n && fixRefs.includes(t.ref) ? { ...t, ...n, ref: t.ref } : t })
      fixRefs.forEach(ref => { const n = reportFor(fix.result, ref); testFixes.push(`${ref}: ${n.testFile} :: ${n.testName} - ${n.reason}`) })
      green = await greenRun(fixRefs.map(ref => `- ${ref}: ${reportFor(fix.result, ref).reason}`).join('\n'))
      files.push(...changedFiles(green.attempts))
    }
    if (!green.ok) return { ok: false, step: `GREEN ${refs.join(', ')}`, details: green.result ? [...greenProblems(green.result), ...defectsIn(green.result).map(d => `${d.ref}: reported as a wrong test - ${d.reason}`)].join('\n') + '\n' + (green.result.failures || green.result.summary) : 'agent failed' }
    greenRan = true
    if (withStructural) structuralDone = true
  }
  return { ok: true, files, greenRan, structuralDone, testFixes }
}

// Setup task (config/infrastructure, no red-green cycle): write the files, run the spec's verify commands.
// Success is computed here: every automatic verify command reported and none failed. "skipped" (tool missing) is
// allowed and collected in `unverified`. Returns {ok:true, files} | {ok:false, step, details}
const unverified = new Map()
// Commands compare without backticks, extra whitespace or a trailing note in parentheses ("... (passes after T-2)").
const norm = (c) => String(c || '').replace(/`/g, '').replace(/\s+/g, ' ').trim().replace(/\s+\([^()]*\)$/, '')
async function setupStep(task, findings = null) {
  const checks = (task.verify || []).filter(v => !v.manual)
  const manual = (task.verify || []).filter(v => v.manual)
  const failing = (r) => [
    ...checks.filter(c => !r.verifyResults.some(v => norm(v.command) === norm(c.command))).map(c => `${c.command} (not run)`),
    ...r.verifyResults.filter(v => v.result === 'fail').map(v => `${v.command}${v.note ? ' - ' + v.note : ''}`),
  ]
  const name = `${task.id} SETUP${findings ? ' fix' : ''}`
  const r = await escalate(name,
    (model, extra, label) => run(
      `SETUP step. ${ctx}\nTask ${task.id} (setup task - no red-green cycle): ${task.title}\n` +
      `Criteria:\n${task.behaviours.map(b => `- ${b.ref}: ${b.text}`).join('\n')}\n` +
      `Verify commands - run each one and report every one in verifyResults with the exact command text:\n${checks.map(c => `- ${c.ref}: ${c.command}`).join('\n') || '- none'}\n` +
      (manual.length ? `Manual checks (do not run; make the files satisfy them):\n${manual.map(c => `- ${c.ref}: ${c.command}`).join('\n')}\n` : '') +
      (findings ? `Address these review findings:\n${JSON.stringify(findings, null, 1)}\n` : '') +
      (hasTests ? 'Run the full test suite; it must stay green. ' : 'There is no test suite yet: report suitePass = true unless this task installs a test framework - then run the new suite. ') +
      `If this task installs or changes the test framework, update the test commands in .tdd-flow/stack.md and return testAll and testSingle. Append a SETUP entry for ${task.id} to ${dir}/tdd-log.md.` + extra,
      { agentType: A('implementer'), model, schema: SETUP, label, phase: findings ? 'Review' : 'Implement' }),
    r => r.suitePass && !failing(r).length,
    r => `Not done yet:\n${failing(r).join('\n') || ''}\n${r.failures || r.summary}\nInspect the files, fix them (never weaken a verify command) and rerun every verify command.`)
  if (!r.ok) return { ok: false, step: name, details: r.result ? [...failing(r.result), r.result.failures || r.result.summary].join('\n') : 'agent failed' }
  const res = r.result
  if (!none(res.testAll)) {
    tests.all = res.testAll
    if (!none(res.testSingle)) tests.single = res.testSingle
    if (!hasTests) log(`${task.id}: test suite available now - \`${tests.all}\``)
    hasTests = true
    ctx = ctxFor()
  }
  for (const v of res.verifyResults) {
    const key = `${task.id}: ${norm(v.command)}`
    if (v.result === 'skipped') unverified.set(key, `${key}${v.note ? ' - ' + v.note : ''}`)
    else unverified.delete(key)
  }
  manual.forEach(c => unverified.set(`${task.id}: manual ${c.ref}`, `${task.id}: manual check ${c.ref} - ${c.command}`))
  return { ok: true, files: changedFiles(r.attempts) }
}

// ---------- Implement + Review, task by task (sequential: one working tree) ----------
const done = []
let current = null
let specStatus = plan.status || null
try {
  for (const task of tasks) {
    const isSetup = task.kind === 'setup'
    if (!isSetup && !hasTests) {
      return await blocked(task, 'NO TEST SUITE', `${task.id} is a tdd task, but the repo has no test command yet.`, false,
        `Add a [setup] task before ${task.id} that installs the test framework and updates .tdd-flow/stack.md (or set the framework up by hand), then rerun /tdd-flow:tdd-implement.`)
    }
    // Start a task only if its minimum cost fits: tdd = RED + GREEN per batch, review, commit;
    // setup = setup step, review, commit.
    const est = isSetup ? 3 : Math.max(1, Math.ceil(task.behaviours.length / BATCH)) * 2 + 2
    if (spawned + est + 1 > MAX_AGENTS) {
      return { status: 'agent_limit', slug: plan.slug, branch: br.branch, tasksCompleted: done, escalationsToStrongModel: escalations,
        next: done.length
          ? `Agent limit (${MAX_AGENTS}) reached after ${done.length} task(s). Rerun /tdd-flow:tdd-implement to continue with ${task.id}.`
          : `Task ${task.id} needs at least ${est} agents, but only ${MAX_AGENTS - spawned - 1} are left. Rerun with a higher {maxAgents}.` }
    }
    current = task
    log(`${task.id}: ${task.title} (${isSetup ? 'setup task' : task.behaviours.length + ' behaviour(s)'})`)
    const taskFiles = new Set()
    const testFixes = []
    if (isSetup) {
      const s = await setupStep(task)
      if (!s.ok) return await blocked(task, s.step, s.details)
      s.files.forEach(f => taskFiles.add(f))
    } else {
      const t = await tddStep(task, task.behaviours)
      if (!t.ok) return await blocked(task, t.step, t.details)
      t.files.forEach(f => taskFiles.add(f))
      testFixes.push(...t.testFixes)
    }

    const scope = isSetup
      ? `Task kind: setup (config/infrastructure, no red-green cycle). Criteria in scope: ${task.behaviours.map(b => b.ref).join(', ')}. ` +
        `Verify commands: ${(task.verify || []).filter(v => !v.manual).map(v => `${v.ref}: \`${v.command}\``).join('; ') || 'none'}. ` +
        'The evidence is the verify commands, not tests: re-run them. A criterion whose command fails or is missing is an uncovered AC; a command that cannot run here (tool or daemon missing) is not. ' +
        'Logic that a test could check does not belong in a setup task: report it as a blocker with behavioural=true.' +
        (hasTests ? '' : ' There is no test suite yet: report testsPass = true.')
      : `ACs in scope: ${task.behaviours.map(b => b.ref).join(', ')}.`
    let review = null
    for (let round = 1; round <= MAX_REVIEW_ROUNDS + 1; round++) {
      review = await run(
        `Review task ${task.id} (${task.title}). ${ctx}\nScope: uncommitted changes (\`git diff HEAD\` plus untracked files). ${scope}\n` +
        (testFixes.length ? `These tests were changed by the test-writer after the implementer reported them as wrong, so they were never seen failing in that form. Check each still asserts its behaviour fully (no weakened or removed assertion); a weakened one is a blocker with behavioural=true:\n${testFixes.map(f => '- ' + f).join('\n')}\n` : '') +
        `Write your review to ${dir}/review.md (append a "## ${task.id} round ${round}" section). Mark each finding behavioural=true if fixing it changes observable behaviour (needs a test), false for structure/naming/style.`,
        { agentType: A('code-reviewer'), model: M.worker, schema: REVIEW, label: `${task.id} review ${round}`, phase: 'Review' })
      if (!review) return await blocked(task, 'REVIEW', 'reviewer agent failed')
      const must = review.findings.filter(f => f.severity !== 'minor')
      if (review.verdict === 'APPROVE' && review.testsPass && !review.uncoveredAcs.length) break
      if (round > MAX_REVIEW_ROUNDS) return await blocked(task, 'REVIEW', `Not approved after ${MAX_REVIEW_ROUNDS} fix rounds:\n${JSON.stringify(review, null, 1)}`)

      log(`${task.id}: review round ${round} requested changes (${must.length} finding(s), ${review.uncoveredAcs.length} uncovered AC(s))`)
      if (isSetup) {
        // Setup tasks have no red-green cycle: every finding goes back to a SETUP fix step.
        const s = await setupStep(task, [
          ...review.uncoveredAcs.map(ac => `${ac} is not verified: make its verify command pass.`),
          ...must,
          ...(review.testsPass ? [] : ['The reviewer reported failing tests or lint - fix the files, never weaken tests.']),
        ])
        if (!s.ok) return await blocked(task, 'REVIEW FIX', s.details)
        s.files.forEach(f => taskFiles.add(f))
        continue
      }
      const fixes = [
        ...review.uncoveredAcs.map((ac, i) => ({ ref: `${ac}-gap`, text: `${ac} is not adequately covered by a test. Re-read ${ac} in the spec and specify it.` })),
        ...must.filter(f => f.behavioural).map((f, i) => ({ ref: `R${round}-${i + 1}`, text: `Review finding at ${f.where}: ${f.issue}. Expected: ${f.fix || 'correct behaviour per spec'}` })),
      ]
      const structural = must.filter(f => !f.behavioural)
      const t = await tddStep(task, fixes, structural)
      if (!t.ok) return await blocked(task, t.step, t.details)
      t.files.forEach(f => taskFiles.add(f))
      testFixes.push(...t.testFixes)
      // Structural findings not handled by a GREEN call, or failing tests that no GREEN call fixed, go to a REFACTOR fix.
      if ((structural.length && !t.structuralDone) || (!review.testsPass && !t.greenRan)) {
        const fx = await escalate(`${task.id} fix ${round}`,
          (model, extra, label) => run(
            `REFACTOR step. ${ctx}\nAddress these non-behavioural review findings without changing behaviour, and make sure the full suite and lint pass:\n${JSON.stringify(structural, null, 1)}` +
            (review.testsPass ? '' : '\nThe reviewer also reported failing tests or lint - fix production code, never weaken tests.') + extra,
            { agentType: A('implementer'), model, schema: CODE, label, phase: 'Review' }),
          r => r.suitePass,
          r => `The suite still fails:\n${r.failures || r.summary}`)
        changedFiles(fx.attempts).forEach(f => taskFiles.add(f))
        if (!fx.ok) return await blocked(task, 'REVIEW FIX', fx.result ? (fx.result.failures || fx.result.summary) : 'agent failed')
      }
    }

    // Closing the task (tick + state) is bookkeeping done by the commit agent before staging, so it lands in the same commit.
    const next = task.id === 'FIX' ? allOpen[0] : allOpen[allOpen.findIndex(t => t.id === task.id) + 1]
    const needsTick = task.id !== 'FIX'
    // The commit that closes the last open task of the spec (not only of this run) also sets "Status: implemented".
    const finishesSpec = needsTick && allOpen.every(t => t.id === task.id || done.some(d => d.task === t.id))
    const state = { feature: plan.slug, phase: 'IDLE', task: next ? next.id : 'DONE' }
    const commitFiles = [...new Set([...taskFiles, `${dir}/tasks.md`, `${dir}/tdd-log.md`, `${dir}/review.md`, '.tdd-flow/state.json',
      ...(isSetup ? ['.tdd-flow/stack.md'] : []), ...(finishesSpec ? [`${dir}/spec.md`] : [])])]
    const type = task.id === 'FIX' ? 'fix' : isSetup ? 'chore' : 'feat'
    // The CLI ticks the task line (T-1 never matches T-10), writes state.json, stages only these files, refuses
    // secrets and files over 5 MB, and commits. It never pushes.
    const committed = await cli('commit', {
      message: `${type}(${plan.slug}): ${task.id} ${task.title}`, files: commitFiles, state,
      tick: needsTick ? { file: `${dir}/tasks.md`, task: task.id } : null,
      specStatus: finishesSpec ? { file: `${dir}/spec.md`, value: 'implemented' } : null,
    }, COMMIT, { label: `${task.id} commit`, phase: 'Review' })
    const commit = committed.ok ? committed.result : null
    if (!commit || (!commit.committed && !commit.nothingToCommit)) {
      return await blocked(task, 'COMMIT', commit ? commit.reason || 'commit failed' : committed.error, needsTick)
    }
    if (needsTick && !commit.ticked) {
      return await blocked(task, 'TICK', `${task.id} was committed (${commit.sha || 'no sha'}), but its checkbox in ${dir}/tasks.md was not ticked.`, false,
        `Tick ${task.id} in ${dir}/tasks.md by hand, then rerun /tdd-flow:tdd-implement to continue with the next task.`)
    }
    if (commit.unexpected && commit.unexpected.length) log(`${task.id}: not committed (unexpected): ${commit.unexpected.join(', ')}`)
    if (finishesSpec && commit.specStatus !== 'implemented') log(`${task.id}: spec status not set to implemented - ${commit.specStatusSkipped || commit.reason || 'no "Status:" line in spec.md'}`)
    if (finishesSpec && commit.specStatus === 'implemented') specStatus = 'implemented'
    done.push({ task: task.id, title: task.title, commit: commit.sha || '' })
  }
} catch (e) {
  if (!limitHit) throw e
  const r = await blocked(current, 'AGENT LIMIT', `Agent limit (${MAX_AGENTS}) reached during ${current.id}. Its uncommitted changes are still in the working tree.`)
  return { ...r, status: 'agent_limit', tasksCompleted: done,
    next: `Stopped at the agent limit (${MAX_AGENTS}) in the middle of ${current.id}. Its uncommitted changes are still in the working tree: rerun /tdd-flow:tdd-implement to redo the task on top of them, or stash them first.` }
}

return {
  status: 'implemented',
  slug: plan.slug,
  branch: br.branch,
  specStatus,
  tasksCompleted: done,
  escalationsToStrongModel: escalations,
  unverified: [...unverified.values()],
  logs: [`${dir}/tdd-log.md`, `${dir}/review.md`],
  next: 'Run /tdd-flow:document, then /tdd-flow:deploy.',
}
