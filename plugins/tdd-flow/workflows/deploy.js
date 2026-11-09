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
    hasCi: { type: 'boolean' }, openTasks: strs, warnings: strs,
    secretScan: { type: 'string', enum: ['present', 'missing', 'not_github'] }, workflowScope: { type: 'boolean' }, existingPr: str, testSingle: str, testAll: str,
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
const WATCH = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'none', 'timeout', 'pending', 'unknown'] }, runUrl: str, failingJob: str, log: str, error: str,
    onMerge: str, commit: str, reviewDecision: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'NONE'] },
    deployments: { type: 'array', items: { type: 'object', properties: { environment: str, state: str, url: str } } },
  },
}
const CAUSE = { type: 'object', required: ['category', 'rootCause'], properties: { category: { type: 'string', enum: ['code', 'test', 'infra', 'flaky', 'unknown'] }, rootCause: str } }

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

try {
  // ---------- Preflight ----------
  phase('Preflight')
  const pf = await cli('preflight', { feature: opt.feature || null }, PRE, { label: 'preflight' })
  if (!pf.ok && !pf.fallback) throw new Error(`tdd-flow: preflight failed. ${pf.error}`)
  // scripted = GitHub: the CLI also watches CI and closes out. Otherwise the release-engineer does those steps.
  const scripted = pf.ok
  const pre = scripted ? pf.result : await run(
    'Preflight for shipping a tdd-flow feature. Do not change anything.\n' +
    `Feature: ${opt.feature ? '"' + opt.feature + '"' : '"feature" in .tdd-flow/state.json'}. Read .tdd-flow/stack.md and .tdd-flow/features/<slug>/tasks.md and spec.md (issue id from its Source).\n` +
    'Report: base (default) branch, current branch, unticked tasks, whether a CI pipeline exists (.github/workflows, azure-pipelines.yml, .gitlab-ci.yml, Jenkinsfile), whether a PR already exists for this branch and, if so, its review status (reviewDecision), ' +
    'and whether the tracker CLI is installed and authenticated (`gh auth status` / `az account show` / `glab auth status`). If not, put the exact command the user must run in cliFix.\n' +
    'secretScan: "not_github" unless the repo uses GitHub Actions; "present" if any file in .github/workflows mentions gitleaks, trufflehog, detect-secrets or a secret-scan job (grep -il); else "missing". ' +
    'workflowScope: true only if `gh auth status` lists the `workflow` token scope (needed to push files under .github/workflows).',
    { agentType: A('release-engineer'), model: M.light, schema: PRE, label: 'preflight (agent)', effort: 'low' })
  if (!pre) throw new Error('tdd-flow: preflight failed.')
  if (!pre.cliReady) throw new Error(`tdd-flow: tracker CLI not ready. Run: ${pre.cliFix || 'gh auth login / az login'}`)
  if (pre.branch === pre.base) throw new Error(`tdd-flow: you are on ${pre.base}. Deploy works from a feature branch.`)
  // An identity problem (none, or one git made up from the hostname) is shown, not fatal: deploy commits only CI fixes.
  const warnings = pre.warnings || []
  warnings.forEach(w => log(`warning: ${w}`))

  // CI watch. GitHub: the CLI polls (the runner repeats the call every ~8.5 minutes up to 30 minutes, cheap
  // because each call prints one line), and an agent reads the failure log only when a check failed.
  async function watchCi(target, label, agentPrompt) {
    if (!scripted) return run(agentPrompt, { agentType: A('release-engineer'), schema: CI, label, phase: target.pr ? 'CI' : 'Merge', stallMs: 2400000 })
    const w = await cli('ci-watch', { ...target, base: pre.base, maxMinutes: 30 }, WATCH, { label, phase: target.pr ? 'CI' : 'Merge', repeat: 6, stallMs: 2400000 })
    if (!w.ok) return { status: 'unknown', rootCause: w.error }
    const c = w.result
    if (c.status === 'pending') c.status = 'timeout'
    if (c.status !== 'failed') return c
    const cause = await run(
      `CI failed${target.pr ? ' on PR ' + target.pr : ''}: ${c.failingJob || 'unknown job'} (${c.runUrl || 'no run URL'}). Failed-step log (tail):\n${c.log}\n\n` +
      'Classify the root cause: code (production bug), test (broken or wrong test), infra (runner, network, credentials, config), flaky (timing, nondeterminism) or unknown. ' +
      'Summarise it in 3-5 lines. Read the repo if you need to; do not change anything.',
      { schema: CAUSE, model: M.worker, effort: 'low', label: `${label} cause`, phase: target.pr ? 'CI' : 'Merge' })
    return { ...c, ...(cause || { category: 'unknown', rootCause: 'classification agent failed' }) }
  }

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
    const post = await watchCi({ commit: merged.mergeCommit || null }, 'post-merge CI',
      `Action: watch-ci for the post-merge pipeline on ${pre.base} (merge commit ${merged.mergeCommit || 'HEAD of ' + pre.base}). Poll until it finishes or 30 minutes pass. Report status, run URL, and any deployment URL/environment the pipeline reports.`)
    const closeOut = scripted ? await cli('close-out', { slug: pre.slug }, { type: 'object', required: ['uncommitted'], properties: { uncommitted: { type: 'boolean' } } }, { label: 'close-out', phase: 'Merge' }) : null
    const closed = closeOut ? (closeOut.ok ? closeOut.result : null) : await run(
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
    { key: 'spec', ask: 'SPEC COVERAGE & CORRECTNESS: every AC in the spec has a test that would fail if the behaviour broke (ACs of [setup] tasks are covered by their verify command passing, or a manual check recorded in tdd-log.md, instead of a test); logic errors; unhandled edge cases listed in the spec.' },
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
  let secretScan = pre.secretScan || 'not_github'
  if (secretScan === 'missing' && pre.workflowScope) {
    // secretScan is "missing" only from the CLI preflight (GitHub), so the CLI writes and commits the file.
    const sc = await cli('add-secret-scan', {}, COMMIT, { label: 'add secret scan', phase: 'PR' })
    secretScan = sc.ok && sc.result.committed ? 'added' : 'add_failed'
  } else if (secretScan === 'missing') secretScan = 'missing_no_workflow_scope'
  const scanNote = {
    added: ' This PR also adds .github/workflows/secret-scan.yml (gitleaks on the PR\'s commits) in a separate `ci:` commit; say so in the PR body.',
    missing_no_workflow_scope: ' The repo has no secret scan in CI and the gh token lacks the `workflow` scope; list that under risks in the PR body.',
  }[secretScan] || ''
  const pr = await run(
    `Action: prepare-pr. Feature ${pre.slug}, base ${pre.base}, issue ${pre.issueId || 'none'}.${pre.existingPr ? ' A PR already exists (' + pre.existingPr + '): push and update it instead of opening a new one.' : ''}\n` +
    `PR body: summary from .tdd-flow/features/${pre.slug}/spec.md, linked issue (use "Closes #id" / "AB#id" as the tracker expects), ACs covered, test evidence from tdd-log.md, docs changed, risks. Final review found no blocker/major issues.${scanNote}`,
    { agentType: A('release-engineer'), schema: PR, label: 'open PR', phase: 'PR' })
  if (!pr) throw new Error('tdd-flow: opening the PR failed.')
  log(`PR: ${pr.prUrl}`)
  if (!pre.hasCi) return { status: 'pr_open_no_ci', prUrl: pr.prUrl, next: 'This repo has no CI pipeline, so deployment cannot be automated. Merge manually or add a pipeline.' }

  // ---------- CI watch + fix loop ----------
  phase('CI')
  let ci = null
  let rerunUsed = false
  for (let round = 0; round <= MAX_CI_ROUNDS; round++) {
    ci = await watchCi({ pr: pr.prUrl }, `watch CI ${round + 1}`,
      `Action: watch-ci for PR ${pr.prUrl}. Poll until all checks finish or 30 minutes pass. On failure fetch the failing job log, classify the root cause (code | test | infra | flaky | unknown) and summarise it in 3-5 lines. Also read the pipeline definition and describe in one line what merging into ${pre.base} will trigger (onMerge), and report the PR review status (reviewDecision).`)
    if (!ci) throw new Error('tdd-flow: CI watch agent failed.')
    if (ci.status !== 'failed') break
    if (round === MAX_CI_ROUNDS) break
    if ((ci.category === 'infra' || ci.category === 'flaky') && !rerunUsed) {
      rerunUsed = true
      log(`CI failed (${ci.category}): re-running once`)
      if (scripted) await cli('ci-rerun', { pr: pr.prUrl }, { type: 'object', properties: { rerun: strs, failed: strs } }, { label: 'rerun CI', phase: 'CI' })
      else await run(`Re-run the failed jobs for PR ${pr.prUrl} (e.g. \`gh run rerun --failed\` / \`az pipelines run\`). Do not change code.`,
        { agentType: A('release-engineer'), label: 'rerun CI', phase: 'CI', effort: 'low' })
      continue
    }
    if (ci.category !== 'code' && ci.category !== 'test') break
    log(`CI failed (${ci.category}) - fixing test-first, round ${round + 1}`)
    const red = await run(
      `RED step. CI failed on PR ${pr.prUrl}: job ${ci.failingJob}. Root cause: ${ci.rootCause}\n${ci.log ? 'Failed-step log (tail):\n' + ci.log + '\n' : ''}Write (or adjust setup for) a local test that reproduces this failure, and confirm it fails locally. If it cannot be reproduced locally, return result ERROR with why.`,
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
      status: 'ci_not_green', prUrl: pr.prUrl, ci, ...(warnings.length ? { warnings } : {}),
      next: 'Show the CI root cause to the user and decide together (fix via /tdd-flow:tdd-implement with findings, re-run, or investigate).',
    }
  }
  return {
    status: 'ready_to_merge',
    prUrl: pr.prUrl,
    ...(warnings.length ? { warnings } : {}),
    ciRun: ci.runUrl,
    onMerge: ci.onMerge,
    reviewDecision: ci.reviewDecision || 'NONE',
    reviewCandidatesRefuted: candidates.length,
    secretScan,
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
