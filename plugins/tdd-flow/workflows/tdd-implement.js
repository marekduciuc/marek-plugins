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
    slug: str, approved: { type: 'boolean' },
    testAll: str, testSingle: str, lint: str, testPattern: str,
    baselinePass: { type: 'boolean' }, baselineSummary: str, noTestSuite: { type: 'boolean' },
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
const COMMIT = { type: 'object', required: ['committed'], properties: { committed: { type: 'boolean' }, nothingToCommit: { type: 'boolean' }, ticked: { type: 'boolean' }, sha: str, reason: str, unexpected: strs } }

// ---------- Plan ----------
phase('Plan')
const plan = await run(
  'Prepare a tdd-flow implementation run.\n' +
  `1. Feature slug: ${opt.feature ? '"' + opt.feature + '"' : 'read "feature" from .tdd-flow/state.json'}. Read .tdd-flow/features/<slug>/spec.md and tasks.md, and .tdd-flow/stack.md (if stack.md is missing, detect the test commands yourself and write it).\n` +
  '2. approved = true only if spec.md has "Status: approved".\n' +
  '3. Run the full test suite once as a baseline; report pass/fail and a short summary. If the repo has no test framework or no tests yet (stack.md says "none", or no test command exists), do not run anything: set noTestSuite = true, baselinePass = true and testAll/testSingle = "none".\n' +
  '4. For every task in tasks.md return id, title, done (checkbox ticked) and its behaviours: one entry per acceptance criterion or edge case mapped to the task, in implementation order (simplest happy path first). ref = AC/EC id, text = the full Given/When/Then or edge-case text.\n' +
  '   kind = "setup" if the task line ends with "[setup]" (or its Kind in the spec task table is setup), otherwise "tdd". For setup tasks also return verify: one entry per "Verify:" line of the task\'s criteria in spec.md, with ref = AC id and command = the exact command; for a "Verify (manual):" line set manual = true and command = the check text.\n' +
  'Do not modify source or test files. Do not run git commands that change anything.',
  { schema: PLAN, model: M.worker, label: 'plan', effort: 'low' })
if (!plan) throw new Error('tdd-flow: planning failed.')
if (!plan.approved && !opt.force) throw new Error(`tdd-flow: spec for ${plan.slug} is not approved. Review it and set "Status: approved" in spec.md (or pass {force: true}).`)
// Test commands can be "none"/"unknown" in a repo being bootstrapped; a setup task may add them later.
const none = (v) => !v || /^(none|unknown|n\/a)\b/i.test(String(v).trim())
let hasTests = !plan.noTestSuite && !none(plan.testAll)
const tests = { all: plan.testAll, single: plan.testSingle }
if (!plan.baselinePass && hasTests && !opt.allowRedBaseline) throw new Error(`tdd-flow: baseline test suite is failing - fix it first or pass {allowRedBaseline: true}. ${plan.baselineSummary || ''}`)
const br = await run(`Action: create-branch. Feature slug: ${plan.slug}.`,
  { agentType: A('release-engineer'), model: M.light, schema: BRANCH, label: 'branch', effort: 'low' })
if (!br) throw new Error('tdd-flow: creating the feature branch failed.')

const dir = `.tdd-flow/features/${plan.slug}`
const ctxFor = () => `Feature: ${plan.slug}. Spec: ${dir}/spec.md. ` +
  (hasTests ? `Test all: \`${tests.all}\`. Single test: \`${tests.single}\`.` : 'No test suite yet.') + (plan.lint ? ` Lint: \`${plan.lint}\`.` : '')
let ctx = ctxFor()

const allOpen = plan.tasks.filter(t => !t.done)
let tasks = allOpen.slice()
if (opt.fromTask) { const i = tasks.findIndex(t => t.id === opt.fromTask); if (i > 0) tasks = tasks.slice(i) }
if (opt.findings && opt.findings.length) {
  tasks.unshift({ id: 'FIX', title: 'Address review findings', done: false,
    behaviours: opt.findings.map((f, i) => ({ ref: `F-${i + 1}`, text: typeof f === 'string' ? f : JSON.stringify(f) })) })
}
if (opt.maxTasks && tasks.length > opt.maxTasks) { log(`Limiting this run to ${opt.maxTasks} of ${tasks.length} open tasks`); tasks = tasks.slice(0, opt.maxTasks) }
if (!tasks.length) return { status: 'nothing_to_do', slug: plan.slug, next: 'All tasks are ticked. Run /tdd-flow:document.' }
log(`${tasks.length} task(s) to implement on ${br.branch}`)

// ---------- helpers ----------
async function blocked(task, step, details, extra = '', next = '') {
  await run(
    `A tdd-flow run is stopping. Set "phase" to "IDLE" in .tdd-flow/state.json (keep other fields, set "task": "${task.id}"). ${extra}` +
    `Append to ${dir}/tdd-log.md: "## ${task.id} - BLOCKED at ${step}" followed by these details:\n${details}`,
    { label: 'record-block', model: M.light, effort: 'low', phase: 'Review' }, true)
  return { status: 'blocked', slug: plan.slug, task: task.id, step, details,
    escalationsToStrongModel: escalations, unverified: [...unverified.values()],
    next: next || 'The step failed on both models. Show the user the details. After the issue is resolved, rerun /tdd-flow:tdd-implement (it resumes from tasks.md).' }
}

// Escalation ladder: worker model, worker model with feedback, then strong model with feedback.
// Only steps that fail twice reach the strong model. `attempts` holds every result, because an attempt that
// did not succeed may still have changed files that belong to the task.
let escalations = 0
async function escalate(name, run, ok, feedback) {
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
    if (r) last = r
  }
  return { ok: false, result: last, attempts }
}
const changedFiles = (attempts) => attempts.flatMap(a => a.filesChanged || [])

// RED then GREEN for a list of behaviours, in batches of BATCH. A separate test-writer writes every failing test of
// the batch before the implementer changes production code. `structural` review findings go into the last GREEN call.
// Returns {ok:true, files, greenRan, structuralDone} | {ok:false, step, details}
async function tddStep(task, items, structural = []) {
  const files = []
  let greenRan = false, structuralDone = false
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const refs = batch.map(b => b.ref)
    const isLastBatch = i + BATCH >= items.length
    const tag = `${task.id} ${refs.length > 1 ? refs[0] + '..' + refs[refs.length - 1] : refs[0]}`

    // RED succeeds only if every requested ref is reported and none errored.
    const redProblems = (r) => [
      ...refs.filter(ref => !r.tests.some(t => t.ref === ref)).map(ref => `${ref}: no test reported`),
      ...r.tests.filter(t => refs.includes(t.ref) && t.result === 'ERROR').map(t => `${t.ref}: ${t.reason}`),
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
    const reported = refs.map(ref => red.result.tests.find(t => t.ref === ref))
    reported.filter(t => t.result === 'PASS').forEach(t => log(`${task.id} ${t.ref}: test passed immediately - behaviour already exists`))
    const failing = reported.filter(t => t.result === 'FAIL')
    if (!failing.length) continue

    // GREEN succeeds only if every listed test is reported passing and the full suite is green.
    const withStructural = isLastBatch && structural.length > 0
    const greenProblems = (r) => [
      ...failing.filter(t => !r.tests.some(x => x.ref === t.ref && x.pass)).map(t => `${t.ref}: ${t.testFile} :: ${t.testName} is not passing`),
      ...(r.suitePass ? [] : ['the full suite is failing']),
    ]
    const green = await escalate(`${tag} GREEN`,
      (model, extra, label) => run(
        `GREEN step. ${ctx}\nTask ${task.id}: ${task.title}\nFailing tests, in order:\n` +
        failing.map(t => `- ${t.ref}: ${t.testFile} :: ${t.testName}\n  Failure: ${t.reason}\n  Behaviour: ${batch.find(b => b.ref === t.ref).text}`).join('\n') + '\n' +
        'Make them pass one at a time, in this order, with minimal code, running each single test as you go. Then refactor the code changed in this step and run the full suite.\n' +
        (withStructural ? `Also address these non-behavioural review findings without changing behaviour:\n${JSON.stringify(structural, null, 1)}\n` : '') +
        `Append one entry per behaviour (RED + GREEN lines) and one REFACTOR line for ${task.id} to ${dir}/tdd-log.md. Report each test by ref.` + extra,
        { agentType: A('implementer'), model, schema: GREEN, label, phase: 'Implement' }),
      r => !greenProblems(r).length,
      r => `Not done yet:\n${greenProblems(r).join('\n')}\n${r.failures || r.summary}\nThe work already done is on disk: inspect the current code first. Fix production code, never the tests.`)
    files.push(...changedFiles(green.attempts))
    if (!green.ok) return { ok: false, step: `GREEN ${refs.join(', ')}`, details: green.result ? greenProblems(green.result).join('\n') + '\n' + (green.result.failures || green.result.summary) : 'agent failed' }
    greenRan = true
    if (withStructural) structuralDone = true
  }
  return { ok: true, files, greenRan, structuralDone }
}

// Setup task (config/infrastructure, no red-green cycle): write the files, run the spec's verify commands.
// Success is computed here: every automatic verify command reported and none failed. "skipped" (tool missing) is
// allowed and collected in `unverified`. Returns {ok:true, files} | {ok:false, step, details}
const unverified = new Map()
const norm = (c) => String(c || '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
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
try {
  for (const task of tasks) {
    const isSetup = task.kind === 'setup'
    if (!isSetup && !hasTests) {
      return await blocked(task, 'NO TEST SUITE', `${task.id} is a tdd task, but the repo has no test command yet.`, '',
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
    if (isSetup) {
      const s = await setupStep(task)
      if (!s.ok) return await blocked(task, s.step, s.details)
      s.files.forEach(f => taskFiles.add(f))
    } else {
      const t = await tddStep(task, task.behaviours)
      if (!t.ok) return await blocked(task, t.step, t.details)
      t.files.forEach(f => taskFiles.add(f))
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
    const state = JSON.stringify({ feature: plan.slug, phase: 'IDLE', task: next ? next.id : 'DONE' })
    const commitFiles = [...new Set([...taskFiles, `${dir}/tasks.md`, `${dir}/tdd-log.md`, `${dir}/review.md`, '.tdd-flow/state.json',
      ...(isSetup ? ['.tdd-flow/stack.md'] : [])])]
    const type = task.id === 'FIX' ? 'fix' : isSetup ? 'chore' : 'feat'
    const commit = await run(
      `Action: commit. Message: "${type}(${plan.slug}): ${task.id} ${task.title}". Do not push.\n` +
      'Bookkeeping before staging:\n' +
      (needsTick ? `- tick: in ${dir}/tasks.md, change the checkbox of task ${task.id} from "[ ]" to "[x]". Match only the line for ERE \`^[[:space:]]*[-*] \\[ \\] ${task.id}([^0-9]|$)\` (so ${task.id} never matches ${task.id}0). Report ticked = true only if that line changed.\n` : '') +
      `- state: write exactly this JSON to .tdd-flow/state.json: ${state}\n` +
      `Files:\n${commitFiles.join('\n')}`,
      { agentType: A('release-engineer'), model: M.light, schema: COMMIT, label: `${task.id} commit`, effort: 'low', phase: 'Review' })
    if (!commit || (!commit.committed && !commit.nothingToCommit)) {
      return await blocked(task, 'COMMIT', commit ? commit.reason || 'commit failed' : 'agent failed',
        needsTick ? `Untick "${task.id}" in ${dir}/tasks.md if it is ticked. ` : '')
    }
    if (needsTick && !commit.ticked) {
      return await blocked(task, 'TICK', `${task.id} was committed (${commit.sha || 'no sha'}), but its checkbox in ${dir}/tasks.md was not ticked.`, '',
        `Tick ${task.id} in ${dir}/tasks.md by hand, then rerun /tdd-flow:tdd-implement to continue with the next task.`)
    }
    if (commit.unexpected && commit.unexpected.length) log(`${task.id}: not committed (unexpected): ${commit.unexpected.join(', ')}`)
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
  tasksCompleted: done,
  escalationsToStrongModel: escalations,
  unverified: [...unverified.values()],
  logs: [`${dir}/tdd-log.md`, `${dir}/review.md`],
  next: 'Run /tdd-flow:document, then /tdd-flow:deploy.',
}
