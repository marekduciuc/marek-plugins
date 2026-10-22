export const meta = {
  name: 'deploy',
  description: 'Ship a tdd-flow feature through CI/CD: multi-lens verified review, PR, CI watch with fix loop; merge/release only with explicit approval',
  whenToUse: 'mode "pr" (default): review + open PR + get CI green, then stop for approval. mode "merge" with approved:true (optional requireReview:true): check PR review status, merge, optional release, watch post-merge pipeline',
  phases: [
    { title: 'Preflight', detail: 'tasks, CLI auth, CI present' },
    { title: 'Review', detail: '3 review lenses, adversarially verified' },
    { title: 'PR', detail: 'commit hygiene, push, open PR' },
    { title: 'CI', detail: 'watch checks, fix and re-push (max 2 rounds)' },
    { title: 'Merge', detail: 'review status check, approved merge/release, post-merge pipeline' },
  ],
}

const opt = typeof args === 'string' ? { feature: args } : (args || {})
const mode = opt.mode || 'pr'
const A = (type) => 'tdd-flow:' + type
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, (typeof args === 'object' && args && args.models) || {})
// Agent limits. Override per run with args {maxAgents, maxParallel} (positive integers).
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const MAX_AGENTS = posInt(opt.maxAgents, 20)
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
const MAX_CI_ROUNDS = 2

const PRE = {
  type: 'object',
  required: ['slug', 'base', 'branch', 'cliReady', 'hasCi', 'openTasks'],
  properties: {
    slug: str, base: str, branch: str, issueId: str, cliReady: { type: 'boolean' }, cliFix: str,
    hasCi: { type: 'boolean' }, openTasks: strs, existingPr: str, testSingle: str, testAll: str,
    reviewDecision: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'NONE'] },
  },
}
const FIND = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', required: ['severity', 'where', 'issue'], properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: str, issue: str, fix: str } } } },
}
const VERDICT = { type: 'object', required: ['refuted', 'why'], properties: { refuted: { type: 'boolean' }, why: str } }
const PR = { type: 'object', required: ['prUrl'], properties: { prUrl: str, branch: str, notes: str } }
const CI = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'none', 'timeout'] }, runUrl: str, failingJob: str, rootCause: str,
    category: { type: 'string', enum: ['code', 'test', 'infra', 'flaky', 'unknown'] }, onMerge: str,
    reviewDecision: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'NONE'] },
  },
}
const COMMIT = { type: 'object', required: ['committed'], properties: { committed: { type: 'boolean' }, nothingToCommit: { type: 'boolean' }, sha: str, reason: str, unexpected: strs } }
const MERGE = { type: 'object', required: ['merged'], properties: { merged: { type: 'boolean' }, mergeCommit: str, releaseUrl: str, notes: str } }

try {
  // ---------- Preflight ----------
  phase('Preflight')
  const pre = await run(
    'Preflight for shipping a tdd-flow feature. Do not change anything.\n' +
    `Feature: ${opt.feature ? '"' + opt.feature + '"' : '"feature" in .tdd-flow/state.json'}. Read .tdd-flow/stack.md and .tdd-flow/features/<slug>/tasks.md and spec.md (issue id from its Source).\n` +
    'Report: base (default) branch, current branch, unticked tasks, whether a CI pipeline exists (.github/workflows, azure-pipelines.yml, .gitlab-ci.yml, Jenkinsfile), whether a PR already exists for this branch and, if so, its review status (reviewDecision), ' +
    'and whether the tracker CLI is installed and authenticated (`gh auth status` / `az account show` / `glab auth status`). If not, put the exact command the user must run in cliFix.',
    { agentType: A('release-engineer'), model: M.light, schema: PRE, label: 'preflight', effort: 'low' })
  if (!pre) throw new Error('tdd-flow: preflight failed.')
  if (!pre.cliReady) throw new Error(`tdd-flow: tracker CLI not ready. Run: ${pre.cliFix || 'gh auth login / az login'}`)
  if (pre.branch === pre.base) throw new Error(`tdd-flow: you are on ${pre.base}. Deploy works from a feature branch.`)

  // ======================= MERGE MODE =======================
  if (mode === 'merge') {
    if (opt.approved !== true) throw new Error('tdd-flow: merge requires {mode: "merge", approved: true}. Only pass approved:true after the user explicitly approved the merge in this conversation.')
    if (!pre.existingPr) return { status: 'no_pr', next: 'There is no open PR for this branch. Run /tdd-flow:deploy (mode "pr") first.' }
    if (pre.reviewDecision === 'CHANGES_REQUESTED') {
      return { status: 'review_changes_requested', prUrl: pre.existingPr, next: 'A reviewer requested changes on the PR. Show them to the user; fix them with /tdd-flow:tdd-implement {findings}, then run /tdd-flow:deploy again.' }
    }
    if (opt.requireReview === true && pre.reviewDecision !== 'APPROVED') {
      return { status: 'review_required', prUrl: pre.existingPr, reviewDecision: pre.reviewDecision || 'NONE', next: 'requireReview is set and the PR has no approving review yet. Wait for approval, then run the merge again.' }
    }
    phase('Merge')
    const merged = await run(
      `Action: merge${opt.release ? ' then release' : ''}. approved: true. Feature ${pre.slug}, branch ${pre.branch} into ${pre.base}, PR ${pre.existingPr}.\n` +
      'Merge through the PR using the repo\'s merge strategy (squash if unspecified), delete the branch, then switch to the base branch and pull. Never bypass branch protection or failing required checks - if blocked, report why and stop.' +
      (opt.release ? ' Then create a release/tag following the repo\'s existing versioning (semver), with notes from the CHANGELOG Unreleased section.' : ''),
      { agentType: A('release-engineer'), schema: MERGE, label: 'merge' })
    if (!merged || !merged.merged) return { status: 'merge_blocked', details: merged ? merged.notes : 'agent failed' }
    const post = await run(
      `Action: watch-ci for the post-merge pipeline on ${pre.base} (merge commit ${merged.mergeCommit || 'HEAD of ' + pre.base}). Poll until it finishes or 30 minutes pass. Report status, run URL, and any deployment URL/environment the pipeline reports.`,
      { agentType: A('release-engineer'), schema: CI, label: 'post-merge CI', stallMs: 2400000 })
    const closed = await run(
      `Close out tdd-flow feature ${pre.slug}: set "Status: done" in .tdd-flow/features/${pre.slug}/spec.md and set .tdd-flow/state.json to {"feature": null, "phase": "IDLE", "task": null}. ` +
      'Do not run git commands other than `git status`. Report uncommitted=true if `git status --porcelain .tdd-flow` shows changes afterwards.',
      { label: 'close-out', model: M.light, effort: 'low', schema: { type: 'object', required: ['uncommitted'], properties: { uncommitted: { type: 'boolean' } } } })
    const closeNote = closed && closed.uncommitted ? ` .tdd-flow/ is tracked by git: the close-out edits are uncommitted on ${pre.base}; commit them through a PR or discard them.` : ''
    return {
      status: post && post.status === 'passed' ? 'deployed' : 'merged_pipeline_' + (post ? post.status : 'unknown'),
      mergeCommit: merged.mergeCommit, releaseUrl: merged.releaseUrl, pipeline: post,
      next: (pre.issueId ? `Check whether issue ${pre.issueId} closed automatically; offer to close it with a link to the PR.` : 'Done.') + closeNote,
    }
  }

  // ======================= PR MODE =======================
  if (pre.openTasks.length && !opt.force) throw new Error(`tdd-flow: unticked tasks: ${pre.openTasks.join(', ')}. Finish /tdd-flow:tdd-implement or pass {force: true}.`)

  // ---------- Review: 3 lenses -> dedupe (barrier) -> adversarial verify ----------
  phase('Review')
  const LENSES = [
    { key: 'spec', ask: 'SPEC COVERAGE & CORRECTNESS: every AC in the spec has a test that would fail if the behaviour broke; logic errors; unhandled edge cases listed in the spec.' },
    { key: 'security', ask: 'SECURITY: injection, unsafe deserialisation, secrets in code or config, path traversal, missing authorisation, unsafe defaults.' },
    { key: 'quality', ask: 'TEST QUALITY & MAINTAINABILITY: non-deterministic tests, tests asserting implementation details, dead code, duplication, convention violations.' },
  ]
  const lensResults = await parallel(LENSES.map(l => () => run(
    `Final pre-merge review of branch ${pre.branch} vs ${pre.base} (\`git diff ${pre.base}...HEAD\`) for feature ${pre.slug} (spec: .tdd-flow/features/${pre.slug}/spec.md).\nLens: ${l.ask}\nReport only findings within this lens. Do not edit files.`,
    { agentType: A('code-reviewer'), model: M.strong, schema: FIND, label: `review:${l.key}`, phase: 'Review' })))
  if (limitHit) throw new Error(LIMIT)
  const seen = new Set()
  const candidates = lensResults.filter(Boolean).flatMap(r => r.findings)
    .filter(f => f.severity !== 'minor')
    .filter(f => { const k = (f.where + '|' + f.issue).toLowerCase().slice(0, 160); if (seen.has(k)) return false; seen.add(k); return true })
  log(`${candidates.length} blocker/major candidate finding(s) to verify`)
  // Verify only if the skeptics (2 per finding) plus PR and the first CI watch fit in the agent limit.
  if (spawned + 2 * candidates.length + 2 > MAX_AGENTS) {
    log(`Verifying ${candidates.length} finding(s) needs ${2 * candidates.length + 2} more agents; only ${MAX_AGENTS - spawned} left`)
    limitHit = true
    throw new Error(LIMIT)
  }

  const verified = await pipeline(candidates, f => parallel([1, 2].map(n => () => run(
    `Skeptic #${n}: try to REFUTE this code-review finding on branch ${pre.branch} (diff vs ${pre.base}). Read the code; if possible write a quick throwaway check (do not commit it). Default to refuted=true if the finding is speculative.\nFinding: ${JSON.stringify(f)}`,
    { schema: VERDICT, model: M.worker, label: `verify:${f.where}`.slice(0, 60), phase: 'Review', effort: 'medium' })))
    .then(votes => ({ ...f, refutedBy: votes.filter(Boolean).filter(v => v.refuted).length })))
  if (limitHit) throw new Error(LIMIT)
  const confirmed = verified.filter(Boolean).filter(f => f.refutedBy < 2)
  if (confirmed.length) {
    return {
      status: 'changes_requested',
      findings: confirmed,
      next: 'Show the findings to the user. To fix them test-first, run /tdd-flow:tdd-implement with {findings: <these findings>}, then /tdd-flow:deploy again.',
    }
  }

  // ---------- PR ----------
  phase('PR')
  const pr = await run(
    `Action: prepare-pr. Feature ${pre.slug}, base ${pre.base}, issue ${pre.issueId || 'none'}.${pre.existingPr ? ' A PR already exists (' + pre.existingPr + '): push and update it instead of opening a new one.' : ''}\n` +
    `PR body: summary from .tdd-flow/features/${pre.slug}/spec.md, linked issue (use "Closes #id" / "AB#id" as the tracker expects), ACs covered, test evidence from tdd-log.md, docs changed, risks. Final review found no blocker/major issues.`,
    { agentType: A('release-engineer'), schema: PR, label: 'open PR', phase: 'PR' })
  if (!pr) throw new Error('tdd-flow: opening the PR failed.')
  log(`PR: ${pr.prUrl}`)
  if (!pre.hasCi) return { status: 'pr_open_no_ci', prUrl: pr.prUrl, next: 'This repo has no CI pipeline, so deployment cannot be automated. Merge manually or add a pipeline.' }

  // ---------- CI watch + fix loop ----------
  phase('CI')
  let ci = null
  let rerunUsed = false
  for (let round = 0; round <= MAX_CI_ROUNDS; round++) {
    ci = await run(
      `Action: watch-ci for PR ${pr.prUrl}. Poll until all checks finish or 30 minutes pass. On failure fetch the failing job log, classify the root cause (code | test | infra | flaky | unknown) and summarise it in 3-5 lines. Also read the pipeline definition and describe in one line what merging into ${pre.base} will trigger (onMerge), and report the PR review status (reviewDecision).`,
      { agentType: A('release-engineer'), schema: CI, label: `watch CI ${round + 1}`, phase: 'CI', stallMs: 2400000 })
    if (!ci) throw new Error('tdd-flow: CI watch agent failed.')
    if (ci.status !== 'failed') break
    if (round === MAX_CI_ROUNDS) break
    if ((ci.category === 'infra' || ci.category === 'flaky') && !rerunUsed) {
      rerunUsed = true
      log(`CI failed (${ci.category}): re-running once`)
      await run(`Re-run the failed jobs for PR ${pr.prUrl} (e.g. \`gh run rerun --failed\` / \`az pipelines run\`). Do not change code.`,
        { agentType: A('release-engineer'), label: 'rerun CI', phase: 'CI', effort: 'low' })
      continue
    }
    if (ci.category !== 'code' && ci.category !== 'test') break
    log(`CI failed (${ci.category}) - fixing test-first, round ${round + 1}`)
    const red = await run(
      `RED step. CI failed on PR ${pr.prUrl}: job ${ci.failingJob}. Root cause: ${ci.rootCause}\nWrite (or adjust setup for) a local test that reproduces this failure, and confirm it fails locally. If it cannot be reproduced locally, return result ERROR with why.`,
      { agentType: A('test-writer'), schema: { type: 'object', required: ['result', 'reason'], properties: { result: { type: 'string', enum: ['FAIL', 'PASS', 'ERROR'] }, reason: str, testFile: str, testName: str } }, label: `CI repro ${round + 1}`, phase: 'CI' })
    if (!red || red.result !== 'FAIL') break
    const green = await run(
      `GREEN step. Make the reproducing test ${red.testFile} :: ${red.testName} pass with a minimal production fix (never weaken tests) and run the full suite. Do not commit or push.`,
      { agentType: A('implementer'), schema: { type: 'object', required: ['suitePass', 'summary', 'filesChanged'], properties: { suitePass: { type: 'boolean' }, summary: str, filesChanged: strs } }, label: `CI fix ${round + 1}`, phase: 'CI', model: round === 0 ? M.worker : M.strong })
    if (!green || !green.suitePass) break
    const fixCommit = await run(
      `Action: commit. Message: "fix(${pre.slug}): ${ci.failingJob || 'CI failure'}". Push the branch after committing.\nFiles:\n${[red.testFile, ...green.filesChanged].join('\n')}`,
      { agentType: A('release-engineer'), model: M.light, schema: COMMIT, label: `CI fix commit ${round + 1}`, phase: 'CI', effort: 'low' })
    if (!fixCommit || !fixCommit.committed) { log(`CI fix commit failed: ${fixCommit ? fixCommit.reason : 'agent failed'}`); break }
  }

  if (!ci || ci.status !== 'passed') {
    return {
      status: 'ci_not_green', prUrl: pr.prUrl, ci,
      next: 'Show the CI root cause to the user and decide together (fix via /tdd-flow:tdd-implement with findings, re-run, or investigate).',
    }
  }
  return {
    status: 'ready_to_merge',
    prUrl: pr.prUrl,
    ciRun: ci.runUrl,
    onMerge: ci.onMerge,
    reviewDecision: ci.reviewDecision || 'NONE',
    reviewCandidatesRefuted: candidates.length,
    next: 'GATE: show PR URL, green CI, review status and what merging triggers. Only after the user explicitly approves, run /tdd-flow:deploy with {mode: "merge", approved: true' + (opt.release ? ', release: true' : '') + (opt.requireReview ? ', requireReview: true' : '') + '}.',
  }
} catch (e) {
  if (!limitHit) throw e
  return {
    status: 'agent_limit',
    agentsUsed: spawned,
    next: `Stopped at the agent limit (${MAX_AGENTS} agents per run). Rerun with a higher {maxAgents}. Resuming this run replays its finished agents, and they still count toward the limit.`,
  }
}
