export const meta = {
  name: 'tdd-implement',
  description: 'Implement an approved tdd-flow spec task by task with strict red-green-refactor cycles, per-task review and commits',
  whenToUse: 'After the spec is approved. args: feature slug (optional), or {feature, fromTask, maxTasks, findings}',
  phases: [
    { title: 'Plan', detail: 'load spec and tasks, baseline test run' },
    { title: 'Implement', detail: 'RED test-writer -> GREEN implementer, per behaviour' },
    { title: 'Review', detail: 'refactor, review, fix loop, commit per task' },
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
    baselinePass: { type: 'boolean' }, baselineSummary: str,
    tasks: { type: 'array', items: { type: 'object', required: ['id', 'title', 'done', 'behaviours'], properties: {
      id: str, title: str, done: { type: 'boolean' },
      behaviours: { type: 'array', items: { type: 'object', required: ['ref', 'text'], properties: { ref: str, text: str } } },
    } } },
  },
}
const RED = {
  type: 'object',
  required: ['result', 'testFile', 'testName', 'reason'],
  properties: { result: { type: 'string', enum: ['FAIL', 'PASS', 'ERROR'] }, testFile: str, testName: str, command: str, reason: str },
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
const COMMIT = { type: 'object', required: ['committed'], properties: { committed: { type: 'boolean' }, nothingToCommit: { type: 'boolean' }, sha: str, reason: str, unexpected: strs } }

// ---------- Plan ----------
phase('Plan')
const plan = await run(
  'Prepare a tdd-flow implementation run.\n' +
  `1. Feature slug: ${opt.feature ? '"' + opt.feature + '"' : 'read "feature" from .tdd-flow/state.json'}. Read .tdd-flow/features/<slug>/spec.md and tasks.md, and .tdd-flow/stack.md (if stack.md is missing, detect the test commands yourself and write it).\n` +
  '2. approved = true only if spec.md has "Status: approved".\n' +
  '3. Run the full test suite once as a baseline; report pass/fail and a short summary.\n' +
  '4. For every task in tasks.md return id, title, done (checkbox ticked) and its behaviours: one entry per acceptance criterion or edge case mapped to the task, in implementation order (simplest happy path first). ref = AC/EC id, text = the full Given/When/Then or edge-case text.\n' +
  'Do not modify source or test files. Do not run git commands that change anything.',
  { schema: PLAN, model: M.worker, label: 'plan', effort: 'low' })
if (!plan) throw new Error('tdd-flow: planning failed.')
if (!plan.approved && !opt.force) throw new Error(`tdd-flow: spec for ${plan.slug} is not approved. Review it and set "Status: approved" in spec.md (or pass {force: true}).`)
if (!plan.baselinePass && !opt.allowRedBaseline) throw new Error(`tdd-flow: baseline test suite is failing - fix it first or pass {allowRedBaseline: true}. ${plan.baselineSummary || ''}`)
const br = await run(`Action: create-branch. Feature slug: ${plan.slug}.`,
  { agentType: A('release-engineer'), model: M.light, schema: BRANCH, label: 'branch', effort: 'low' })
if (!br) throw new Error('tdd-flow: creating the feature branch failed.')

const dir = `.tdd-flow/features/${plan.slug}`
const ctx = `Feature: ${plan.slug}. Spec: ${dir}/spec.md. Test all: \`${plan.testAll}\`. Single test: \`${plan.testSingle}\`.` + (plan.lint ? ` Lint: \`${plan.lint}\`.` : '')

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
async function blocked(task, step, details, extra = '') {
  await run(
    `A tdd-flow run is stopping. Set "phase" to "IDLE" in .tdd-flow/state.json (keep other fields, set "task": "${task.id}"). ${extra}` +
    `Append to ${dir}/tdd-log.md: "## ${task.id} - BLOCKED at ${step}" followed by these details:\n${details}`,
    { label: 'record-block', model: M.light, effort: 'low', phase: 'Review' }, true)
  return { status: 'blocked', slug: plan.slug, task: task.id, step, details,
    escalationsToStrongModel: escalations,
    next: 'The step failed on both models. Show the user the details. After the issue is resolved, rerun /tdd-flow:tdd-implement (it resumes from tasks.md).' }
}

// Escalation ladder: worker model, worker model with feedback, then strong model with feedback.
// Only steps that fail twice reach the strong model.
let escalations = 0
async function escalate(name, run, ok, feedback) {
  const ladder = [
    { model: M.worker, suffix: '' },
    { model: M.worker, suffix: ' retry' },
    { model: M.strong, suffix: ' ESCALATED' },
  ]
  let last = null
  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i]
    if (i === 2) { escalations++; log(`${name}: failed twice on ${M.worker} - escalating to ${M.strong}`) }
    const extra = i === 0 ? '' : (last ? '\n\nA previous attempt did not succeed:\n' + feedback(last) : '\n\nA previous attempt crashed; start fresh.')
    const r = await run(step.model, extra, name + step.suffix)
    if (r && ok(r)) return { ok: true, result: r, escalated: i === 2 }
    if (r) last = r
  }
  return { ok: false, result: last }
}

// One red-green cycle. Returns {ok:true, files} | {ok:true, skipped:true, files} | {ok:false, step, details}
async function cycle(task, b) {
  const tag = `${task.id} ${b.ref}`
  const red = await escalate(`${tag} RED`,
    (model, extra, label) => run(
      `RED step. ${ctx}\nTask ${task.id}: ${task.title}\nBehaviour ${b.ref}: ${b.text}\n` +
      'Write ONE failing test for exactly this behaviour, run it, and confirm it fails for the expected reason.' + extra,
      { agentType: A('test-writer'), model, schema: RED, label, phase: 'Implement' }),
    r => r.result !== 'ERROR',
    r => `It errored for the wrong reason: ${r.reason}. Fix the test or setup so it fails on the behaviour itself.`)
  if (!red.ok) return { ok: false, step: `RED ${b.ref}`, details: red.result ? red.result.reason : 'agent failed' }
  const rr = red.result
  if (rr.result === 'PASS') { log(`${tag}: test passed immediately - behaviour already exists`); return { ok: true, skipped: true, files: [rr.testFile] } }

  const green = await escalate(`${tag} GREEN`,
    (model, extra, label) => run(
      `GREEN step. ${ctx}\nFailing test: ${rr.testFile} :: ${rr.testName}\nFailure: ${rr.reason}\nBehaviour ${b.ref}: ${b.text}\n` +
      'Write the minimal production code to make it pass, then run the single test and the full suite. ' +
      `Then append a cycle entry (RED + GREEN lines) for ${task.id} / ${b.ref} to ${dir}/tdd-log.md.` + extra,
      { agentType: A('implementer'), model, schema: CODE, label, phase: 'Implement' }),
    r => r.singlePass && r.suitePass,
    r => `It left failures:\n${r.failures || r.summary}\nInspect the current state of the code first, then fix production code (never the tests).`)
  if (!green.ok) return { ok: false, step: `GREEN ${b.ref}`, details: green.result ? (green.result.failures || green.result.summary) : 'agent failed' }
  return { ok: true, files: [rr.testFile, ...green.result.filesChanged] }
}

// ---------- Implement + Review, task by task (sequential: one working tree) ----------
const done = []
let current = null
try {
  for (const task of tasks) {
    // Start a task only if its minimum cost (2 per behaviour + refactor, review, close, commit) fits.
    const est = task.behaviours.length * 2 + 4
    if (spawned + est + 1 > MAX_AGENTS) {
      return { status: 'agent_limit', slug: plan.slug, branch: br.branch, tasksCompleted: done, escalationsToStrongModel: escalations,
        next: done.length
          ? `Agent limit (${MAX_AGENTS}) reached after ${done.length} task(s). Rerun /tdd-flow:tdd-implement to continue with ${task.id}.`
          : `Task ${task.id} needs at least ${est} agents, but only ${MAX_AGENTS - spawned - 1} are left. Rerun with a higher {maxAgents}.` }
    }
    current = task
    log(`${task.id}: ${task.title} (${task.behaviours.length} behaviour(s))`)
    const taskFiles = new Set()
    for (const b of task.behaviours) {
      const r = await cycle(task, b)
      if (!r.ok) return await blocked(task, r.step, r.details)
      r.files.forEach(f => taskFiles.add(f))
    }

    const ref = await escalate(`${task.id} REFACTOR`,
      (model, extra, label) => run(
        `REFACTOR step. ${ctx}\nTask ${task.id}: ${task.title}. Refactor the code changed for this task (see \`git diff HEAD\`) without changing behaviour; keep the full suite green. Append a REFACTOR line to ${dir}/tdd-log.md.` + extra,
        { agentType: A('implementer'), model, schema: CODE, label, phase: 'Review' }),
      r => r.suitePass,
      r => `The suite failed after refactoring:\n${r.failures || r.summary}\nRevert anything risky; a no-op refactor is acceptable.`)
    if (!ref.ok) return await blocked(task, 'REFACTOR', ref.result ? (ref.result.failures || ref.result.summary) : 'agent failed')
    ref.result.filesChanged.forEach(f => taskFiles.add(f))

    let review = null
    for (let round = 1; round <= MAX_REVIEW_ROUNDS + 1; round++) {
      review = await run(
        `Review task ${task.id} (${task.title}). ${ctx}\nScope: uncommitted changes (\`git diff HEAD\` plus untracked files). ACs in scope: ${task.behaviours.map(b => b.ref).join(', ')}.\n` +
        `Write your review to ${dir}/review.md (append a "## ${task.id} round ${round}" section). Mark each finding behavioural=true if fixing it changes observable behaviour (needs a test), false for structure/naming/style.`,
        { agentType: A('code-reviewer'), model: M.worker, schema: REVIEW, label: `${task.id} review ${round}`, phase: 'Review' })
      if (!review) return await blocked(task, 'REVIEW', 'reviewer agent failed')
      const must = review.findings.filter(f => f.severity !== 'minor')
      if (review.verdict === 'APPROVE' && review.testsPass && !review.uncoveredAcs.length) break
      if (round > MAX_REVIEW_ROUNDS) return await blocked(task, 'REVIEW', `Not approved after ${MAX_REVIEW_ROUNDS} fix rounds:\n${JSON.stringify(review, null, 1)}`)

      log(`${task.id}: review round ${round} requested changes (${must.length} finding(s), ${review.uncoveredAcs.length} uncovered AC(s))`)
      const fixes = [
        ...review.uncoveredAcs.map((ac, i) => ({ ref: `${ac}-gap`, text: `${ac} is not adequately covered by a test. Re-read ${ac} in the spec and specify it.` })),
        ...must.filter(f => f.behavioural).map((f, i) => ({ ref: `R${round}-${i + 1}`, text: `Review finding at ${f.where}: ${f.issue}. Expected: ${f.fix || 'correct behaviour per spec'}` })),
      ]
      for (const b of fixes) {
        const r = await cycle(task, b)
        if (!r.ok) return await blocked(task, r.step, r.details)
        r.files.forEach(f => taskFiles.add(f))
      }
      const structural = must.filter(f => !f.behavioural)
      if (structural.length || !review.testsPass) {
        const fx = await escalate(`${task.id} fix ${round}`,
          (model, extra, label) => run(
            `REFACTOR step. ${ctx}\nAddress these non-behavioural review findings without changing behaviour, and make sure the full suite and lint pass:\n${JSON.stringify(structural, null, 1)}` +
            (review.testsPass ? '' : '\nThe reviewer also reported failing tests or lint - fix production code, never weaken tests.') + extra,
            { agentType: A('implementer'), model, schema: CODE, label, phase: 'Review' }),
          r => r.suitePass,
          r => `The suite still fails:\n${r.failures || r.summary}`)
        if (!fx.ok) return await blocked(task, 'REVIEW FIX', fx.result ? (fx.result.failures || fx.result.summary) : 'agent failed')
        fx.result.filesChanged.forEach(f => taskFiles.add(f))
      }
    }

    const next = task.id === 'FIX' ? allOpen[0] : allOpen[allOpen.findIndex(t => t.id === task.id) + 1]
    await run(
      `Close tdd-flow task ${task.id} for feature ${plan.slug}. Do not run git.\n` +
      (task.id === 'FIX' ? '' : `1. Tick "${task.id}" in ${dir}/tasks.md.\n`) +
      `2. Set .tdd-flow/state.json to {"feature": "${plan.slug}", "phase": "IDLE", "task": "${next ? next.id : 'DONE'}"}.`,
      { label: `${task.id} close`, model: M.light, effort: 'low', phase: 'Review' })
    const commitFiles = [...taskFiles, `${dir}/tasks.md`, `${dir}/tdd-log.md`, `${dir}/review.md`, '.tdd-flow/state.json']
    const commit = await run(
      `Action: commit. Message: "${task.id === 'FIX' ? 'fix' : 'feat'}(${plan.slug}): ${task.id} ${task.title}". Do not push.\nFiles:\n${commitFiles.join('\n')}`,
      { agentType: A('release-engineer'), model: M.light, schema: COMMIT, label: `${task.id} commit`, effort: 'low', phase: 'Review' })
    if (!commit || (!commit.committed && !commit.nothingToCommit)) {
      return await blocked(task, 'COMMIT', commit ? commit.reason || 'commit failed' : 'agent failed',
        task.id === 'FIX' ? '' : `Untick "${task.id}" in ${dir}/tasks.md. `)
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
  logs: [`${dir}/tdd-log.md`, `${dir}/review.md`],
  next: 'Run /tdd-flow:document, then /tdd-flow:deploy.',
}
