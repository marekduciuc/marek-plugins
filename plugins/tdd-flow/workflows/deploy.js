export const meta = {
  name: 'deploy',
  description: 'Ship a tdd-flow feature through CI/CD: open the PR; merge/release only with explicit approval and green CI',
  whenToUse: 'mode "pr" (default): push and open the PR, then stop (review the branch with /code-review before, watch the PR with /steward after). mode "merge" with approved:true (optional requireReview:true): check PR review status and CI, merge, optional release, watch post-merge pipeline',
  phases: [
    { title: 'Preflight', detail: 'tasks, CLI auth, CI present' },
    { title: 'PR', detail: 'commit hygiene, push, open PR' },
    { title: 'CI', detail: 'checks of the PR must pass before the merge' },
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
// 10: mode "pr" needs preflight, secret scan and PR. Mode "merge" on GitHub, each CLI call with its relay retry:
// preflight 2, pre-merge CI watch 2, merge 1, post-merge watch 2 and its cause 1, close-out 2.
const MAX_AGENTS = posInt(opt.maxAgents, 10)
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
  // An identity problem (none, or one git made up from the hostname) is shown, not fatal: deploy commits only the secret-scan workflow.
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
    // The PR run no longer waits for CI (the user's /steward does), so the merge checks it: pending checks are waited
    // for, and a red or unfinished pipeline is not merged, also where branch protection requires no checks.
    if (pre.hasCi) {
      phase('CI')
      const ci = await watchCi({ pr: pre.existingPr }, 'pre-merge CI',
        `Action: watch-ci for PR ${pre.existingPr}. Poll until all checks finish or 30 minutes pass. On failure fetch the failing job log, classify the root cause (code | test | infra | flaky | unknown) and summarise it in 3-5 lines.`)
      // No checks at all (the pipeline runs only on the base branch, or path filters skip this PR): nothing to wait for.
      if (ci && ci.status === 'none') log('the PR has no checks - merging without a CI result')
      else if (!ci || ci.status !== 'passed') {
        return { status: 'ci_not_green', prUrl: pre.existingPr, ci: ci || { status: 'unknown', rootCause: 'the CI watch agent failed' }, next: 'The checks of the PR did not pass, so nothing was merged. Show the root cause to the user. A /steward watch on the PR fixes failing checks; or fix it with /tdd-flow:tdd-implement {findings}, push, and run the merge again.' }
      }
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

  // ---------- PR ----------
  phase('PR')
  let secretScan = pre.secretScan || 'not_github'
  let scanFailure = ''
  if (secretScan === 'missing' && pre.workflowScope) {
    // secretScan is "missing" only from the CLI preflight (GitHub), so the CLI writes and commits the file.
    const sc = await cli('add-secret-scan', {}, COMMIT, { label: 'add secret scan', phase: 'PR' })
    secretScan = sc.ok && sc.result.committed ? 'added' : 'add_failed'
    if (secretScan === 'add_failed') {
      scanFailure = (sc.ok ? sc.result.reason : sc.error) || 'no reason given'
      log(`adding the secret scan workflow failed: ${scanFailure}`)
      warnings.push(`The repo has no secret scan in CI, and adding .github/workflows/secret-scan.yml failed: ${scanFailure}. Common causes: a pre-commit hook rejected the commit, or .github/ is git-ignored.`)
    }
  } else if (secretScan === 'missing') secretScan = 'missing_no_workflow_scope'
  const scanNote = {
    added: ' This PR also adds .github/workflows/secret-scan.yml (gitleaks on the PR\'s commits) in a separate `ci:` commit; say so in the PR body.',
    missing_no_workflow_scope: ' The repo has no secret scan in CI and the gh token lacks the `workflow` scope; list that under risks in the PR body.',
    add_failed: ` The repo has no secret scan in CI, and adding one failed (${scanFailure}); list that under risks in the PR body.`,
  }[secretScan] || ''
  const pr = await run(
    `Action: prepare-pr. Feature ${pre.slug}, base ${pre.base}, issue ${pre.issueId || 'none'}.${pre.existingPr ? ' A PR already exists (' + pre.existingPr + '): push and update it instead of opening a new one.' : ''}\n` +
    `PR body: summary from .tdd-flow/features/${pre.slug}/spec.md, linked issue (use "Closes #id" / "AB#id" as the tracker expects), ACs covered, test evidence from tdd-log.md, docs changed, risks.${scanNote}`,
    { agentType: A('release-engineer'), schema: PR, label: 'open PR', phase: 'PR' })
  if (!pr) throw new Error('tdd-flow: opening the PR failed.')
  log(`PR: ${pr.prUrl}`)
  if (!pre.hasCi) return { status: 'pr_open_no_ci', prUrl: pr.prUrl, ...(warnings.length ? { warnings } : {}), next: 'This repo has no CI pipeline, so deployment cannot be automated. Merge manually or add a pipeline.' }


  // No CI watch and no fix loop here: the built-in /steward watches a PR for up to 7 days and handles failing checks,
  // conflicts and review comments. Only the user can start it, so the run ends with the PR open.
  const prNumber = (pr.prUrl.match(/\/(?:pull|pullrequest|merge_requests)\/(\d+)/) || [])[1] || pr.prUrl
  return {
    status: 'pr_open',
    prUrl: pr.prUrl,
    ...(warnings.length ? { warnings } : {}),
    reviewDecision: pre.reviewDecision || 'NONE',
    secretScan,
    next: `The PR is open. Tell the user to type \`/steward ${prNumber}\` in a separate Claude Code session in this checkout (GitHub only; it watches the PR for up to 7 days, fixes failing checks, conflicts and review comments, and never merges). ` +
      'GATE: only after the user explicitly approves the merge, run /tdd-flow:deploy with {mode: "merge", approved: true' + (opt.release ? ', release: true' : '') + (opt.requireReview ? ', requireReview: true' : '') + '}. It waits for the checks, merges only when they passed, and closes the spec out. A merge made on GitHub instead leaves the spec at "implemented".',
  }
} catch (e) {
  if (!limitHit) throw e
  return {
    status: 'agent_limit',
    agentsUsed: spawned,
    next: `Stopped at the agent limit (${MAX_AGENTS} agents per run). Rerun with a higher {maxAgents}. Resuming this run replays its finished agents, and they still count toward the limit.`,
  }
}
