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
// Model policy. Override per run with args {models: {worker, strong, light}}.
const M = Object.assign({ worker: 'sonnet', strong: 'opus', light: 'haiku' }, (typeof args === 'object' && args && args.models) || {})

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
const WROTE = { type: 'object', required: ['files', 'summary'], properties: { files: strs, summary: str, unverified: strs } }
const CHECK = {
  type: 'object',
  required: ['ok', 'problems'],
  properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'object', required: ['where', 'claim', 'reality'], properties: { where: str, claim: str, reality: str } } } },
}

// ---------- Survey ----------
phase('Survey')
const survey = await agent(
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
  (_, t) => agent(
    `${ctx}\n\nProduce ONLY the "${t.kind}" documentation target, in ${t.file}. Why: ${t.why}. Do not touch other doc targets' files.`,
    { agentType: A('doc-writer'), schema: WROTE, label: `write:${t.kind}`, phase: 'Write' }),
  (wrote, t) => wrote && agent(
    `Fact-check the ${t.kind} documentation just written in ${wrote.files.join(', ')} against the actual code (${ctx.split('\n')[0]}).\n` +
    'Try to REFUTE every concrete claim: names, signatures, parameters, defaults, file paths, commands, examples. Run or compile examples where feasible (or match them to passing tests). Report only claims that are false or unverifiable. Do not edit files.',
    { schema: CHECK, model: M.worker, label: `verify:${t.kind}`, phase: 'Verify', agentType: A('code-reviewer') })
    .then(check => ({ wrote, check })),
  (r, t) => {
    if (!r || !r.check || r.check.ok || !r.check.problems.length) return r
    return agent(
      `${ctx}\n\nFix these inaccuracies in the ${t.kind} documentation (${r.wrote.files.join(', ')}). Make the docs match the code; never change production logic.\n${JSON.stringify(r.check.problems, null, 1)}`,
      { agentType: A('doc-writer'), schema: WROTE, label: `fix:${t.kind}`, phase: 'Verify' })
      .then(fixed => ({ ...r, fixed }))
  },
)
const ok = results.filter(Boolean)
const dropped = targets.length - ok.length
if (dropped) log(`${dropped} doc target(s) failed - see /workflows`)

// ---------- Commit ----------
phase('Commit')
const files = [...new Set(ok.flatMap(r => [...r.wrote.files, ...((r.fixed && r.fixed.files) || [])]))]
const touchedSource = targets.some(t => t.kind === 'api')
const commit = await agent(
  `${touchedSource ? 'Doc comments were added to source files: run the full test suite first; if it fails, report that and do NOT commit. ' : ''}` +
  `Stage these documentation files and commit with message "docs(${survey.slug}): update documentation" (no --no-verify, no push):\n${files.join('\n')}\nReturn the short sha, or the failure.`,
  { label: 'commit', model: M.light, effort: 'low' })

return {
  status: 'documented',
  slug: survey.slug,
  targets: ok.map(r => ({ files: r.wrote.files, summary: (r.fixed || r.wrote).summary, factCheckIssuesFixed: r.check ? r.check.problems.length : 0 })),
  commit,
  next: 'Run /tdd-flow:deploy to open the PR and run CI.',
}
