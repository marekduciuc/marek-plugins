// Tests of the tdd-flow status pane (hooks/register.tsx), run by `claude plugin test plugins/tdd-flow`:
// `$.process.run` answers a canned `tdd-flow status`, the clock is mocked.
import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderInput } from 'claude-code'

import type { StatusRow } from '../types'

const PLUGIN = 'tdd-flow'
const ROOT = '/repo'
const SESSION = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const

const RUNNING: StatusRow = {
  slug: '82-ux-fixes-68f-focus', status: 'running', done: 5, total: 10, current: 'T-6 Settings: inline category…', prUrl: 'https://github.com/o/r/pull/90',
  details: '', attach: 'claude attach form-error-focus', task: 'T-6', phase: 'GREEN', issueUrl: 'https://github.com/o/r/issues/82',
  title: 'UX fixes', session: 'form-error-focus', sessionState: 'working', at: '2026-11-11T10:00:00.000Z',
  position: 6, issueNumber: 82, prNumber: 90,
}
const DECISION: StatusRow = {
  ...RUNNING, slug: '23-csv', status: 'blocked', done: 2, total: 4, current: 'T-3 Export', prUrl: '', attach: 'claude attach csv-export-flow',
  phase: '', issueUrl: '', details: 'needs a decision', sessionState: 'done', position: 3, issueNumber: null, prNumber: null,
  decision: { id: 'Q-2', question: 'Keep the old export?', recommendation: 'Keep it', options: ['Keep it', 'Drop it'], tasks: ['T-3', 'T-4'] },
}

const PANE: Omit<RenderInput<'Pane'>, 'surface'> = {
  component: 'Pane',
  requestId: 'tdd-status',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: 'tdd-flow', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

/** The engine beneath the plugin: a repo with .tdd-flow/, a canned `tdd-flow status`, and a record of what was asked. */
function world(on: On, opts: { rows?: StatusRow[]; isSkillListed?: boolean; fail?: string; isClosedStored?: boolean } = {}) {
  let releaseRestart = (): void => undefined
  const w = {
    /** What `tdd-flow restart` prints; it answers only after `release()` while `isRestartHeld`. */
    restartOut: { ok: true, shape: '', result: { slug: '', session: 'new-7', name: 'x', attach: 'claude attach x', notes: [] } } as object,
    isRestartHeld: false,
    release: () => releaseRestart(),
    rows: opts.rows ?? [RUNNING],
    runs: [] as { argv: readonly string[]; cwd?: string; stdin?: string }[],
    commands: [] as string[],
    opened: [] as string[],
    ran: [] as { command: string; args?: string }[],
    submitted: [] as { text: string; asUser?: true }[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    logs: [] as string[],
    copied: [] as string[],
    statusWrites: 0,
    // What the ui.close hook stored when the person closed the pane (it outlives a reload), until the next write.
    isClosedStored: opts.isClosedStored === true,
  }
  on('state.get', ($, e, next) => (e.plugin === PLUGIN && e.key === 'isClosed' && w.isClosedStored ? { value: { value: true, version: 1 } } : next(e)))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/.tdd-flow` }))
  on('process.run', async ($, e) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin })
    if (e.argv[1] === 'restart') {
      if (w.isRestartHeld) await new Promise<void>(resolve => { releaseRestart = resolve })
      return { value: { exitCode: 0, stdout: `${JSON.stringify(w.restartOut)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const out = opts.fail ? { ok: false, shape: '', error: opts.fail } : { ok: true, shape: '', result: { rows: w.rows, paneSeen: false } }
    return { value: { exitCode: opts.fail ? 1 : 0, stdout: `${JSON.stringify(out)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.list', () => ({
    value: opts.isSkillListed === false ? [] : [{ name: 'tdd-flow:answer-decision', description: 'Answer a decision', source: 'plugin' as const }],
  }))
  on('command.run', ($, e) => {
    w.ran.push({ command: e.command, args: e.args })
    return {}
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push({ text: e.text, ...(e.origin.kind === 'plugin' && e.origin.asUser ? { asUser: true as const } : {}) })
    return { text: e.text }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [...new Set(w.opened)].map(id => ({ id, title: 'tdd-flow', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.close', ($, e) => {
    w.opened = w.opened.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('state.set', ($, e, next) => {
    if (e.plugin === PLUGIN && e.key === 'status') w.statusWrites += 1
    if (e.plugin === PLUGIN && e.key === 'isClosed') w.isClosedStored = false
    return next(e)
  })
  return w
}

test('a non-interactive session registers nothing and starts no timer', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.session.start({ ...SESSION, isInteractive: false, surface: null })
  await clock.advance(60_000)
  expect(w.runs).toEqual([])
  expect(w.commands).toEqual([])
})

test('every 10 s the timer runs tdd-flow status at the repo root; unchanged status does not rewrite state', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  expect(w.commands).toEqual(['tdd-status'])
  await clock.advance(10_000)
  expect(w.runs.length).toBe(2) // the first read right after the start, then the 10 s tick
  expect(w.runs[0]?.argv[0]?.endsWith('/bin/tdd-flow')).toBe(true)
  expect(w.runs[0]?.argv[1]).toBe('status')
  expect(w.runs[0]?.cwd).toBe(ROOT)
  expect(w.runs[0]?.stdin).toBe('{}') // no heartbeat while the pane is not open
  await clock.advance(20_000)
  expect(w.runs.length).toBe(4)
  expect(w.statusWrites).toBe(1)
  expect(w.statuses.at(-1)).toBe('tdd-flow: 1 running, 0 waiting')
})

test('rows render with status, tasks, phase, issue and PR links and the attach command, on terminal and desktop', async ($, on) => {
  const w = world(on, { rows: [RUNNING, { ...RUNNING, slug: '40-stuck', status: 'stalled', details: 'session is idle without a report\nmore' }] })
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  await clock.advance(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    // Sorted: stalled before running.
    const words = (await ui.findAll({ type: 'Text', text: /^(running|stalled)$/ })).map(t => t.text)
    expect(words).toEqual(['stalled', 'running'])
    expect((await ui.find({ type: 'Text', text: /5\/10 done · T-6 Settings/ }))?.text).toBe('  5/10 done · T-6 Settings: inline category…')
    expect((await ui.find({ type: 'Text', text: /GREEN/ }))?.text).toMatch(/^  GREEN · issue #82 · PR #90 · claude attach form-error-focus$/)
    const links = (await ui.findAll({ type: 'Link' })).map(l => [l.props.href, l.text])
    expect(links.slice(0, 2)).toEqual([['https://github.com/o/r/issues/82', 'issue #82'], ['https://github.com/o/r/pull/90', 'PR #90']])
    expect((await ui.find({ type: 'Text', text: /session is idle without a report$/ }))?.text).toBe('  session is idle without a report')
    await ui.press({ key: 'copy:82-ux-fixes-68f-focus' })
    await ui.unmount()
  }
  expect(w.copied).toEqual(['claude attach form-error-focus', 'claude attach form-error-focus'])
})

test('a decision shows its question and answers through the skill: option, recommendation and free answer', async ($, on) => {
  const w = world(on, { rows: [RUNNING, DECISION] })
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  await clock.advance(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    expect((await ui.find({ type: 'Text', text: /^Q-2:/ }))?.text).toBe('Q-2: Keep the old export?')
    expect((await ui.find({ type: 'Text', text: /^Blocks/ }))?.text).toBe('Blocks T-3, T-4')
    expect((await ui.find({ type: 'Text', text: /^decision$/ }))?.text).toBe('decision')
    await ui.unmount()
  }
  const terminal = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await terminal.press({ key: 'option:23-csv:1' })
  expect(w.ran).toEqual([{ command: 'tdd-flow:answer-decision', args: '23-csv Q-2 Drop it' }])
  expect((await terminal.find({ type: 'Text', text: /answer sent/ }))?.text).toBe('answer sent')
  expect(await terminal.find({ type: 'Button', key: 'option:23-csv:0' })).toBeUndefined()
  await terminal.unmount()

  // The spec runs again: the row shows the next status, and the decision can be answered when it comes back.
  w.rows = [RUNNING, { ...DECISION, status: 'running', decision: undefined }]
  await clock.advance(10_000)
  w.rows = [RUNNING, DECISION]
  await clock.advance(10_000)
  const desktop = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await desktop.press({ key: 'recommendation:23-csv' })
  await desktop.unmount()
  w.rows = [RUNNING, { ...DECISION, status: 'running', decision: undefined }]
  await clock.advance(10_000)
  w.rows = [RUNNING, DECISION]
  await clock.advance(10_000)
  const again = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await again.input({ key: 'answer:23-csv', text: '  Keep it,\n but rename it ' })
  await again.unmount()
  expect(w.ran.slice(1)).toEqual([
    { command: 'tdd-flow:answer-decision', args: '23-csv Q-2 Keep it' },
    { command: 'tdd-flow:answer-decision', args: '23-csv Q-2 Keep it, but rename it' },
  ])
  expect(w.statuses.at(-1)).toBe('tdd-flow: 1 running, 1 waiting')
})

test('without the skill in the command list the answer goes in as the person\'s prompt asking for the skill', async ($, on) => {
  const w = world(on, { rows: [DECISION], isSkillListed: false })
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'option:23-csv:0' })
  await ui.unmount()
  expect(w.logs).toEqual([])
  expect(w.ran).toEqual([])
  expect(w.submitted).toEqual([{ text: 'Run the tdd-flow:answer-decision skill with these arguments: 23-csv Q-2 Keep it', asUser: true }])
})

test('the pane opens by itself only where it docks, and the heartbeat goes only while it is open', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  await $.session.start(SESSION)
  const hint = { component: 'PromptHint', surface: 'terminal', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '' } } as const
  await $.ui.render({ ...hint, viewport: { columns: 180, rows: 48, isFullscreen: false } })
  await clock.advance(10_000)
  expect(w.opened).toEqual([])
  await $.ui.render({ ...hint, viewport: { columns: 100, rows: 48, isFullscreen: true } })
  await clock.advance(10_000)
  expect(w.opened).toEqual([])
  await $.ui.render({ ...hint, viewport: { columns: 180, rows: 48, isFullscreen: true } })
  await clock.advance(10_000)
  expect(w.opened).toEqual(['tdd-status'])
  await clock.advance(10_000)
  expect(w.runs.at(-1)?.stdin).toBe('{"pane":true}') // the heartbeat goes only while the pane is open
  expect(w.statuses.at(-1)).toBe(undefined) // no status line while the pane shows the specs
})

test('a pane the person closed stays closed, with the status line, until /tdd-status', async ($, on) => {
  const w = world(on, { isClosedStored: true })
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  await $.session.start(SESSION)
  await $.ui.render({ component: 'PromptHint', surface: 'terminal', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '' }, viewport: { columns: 180, rows: 48, isFullscreen: true } })
  await clock.advance(20_000)
  expect(w.opened).toEqual([])
  expect(w.runs.at(-1)?.stdin).toBe('{}')
  expect(w.statuses.at(-1)).toBe('tdd-flow: 1 running, 0 waiting')
  const answer = await $.command.run({ command: 'tdd-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(answer.text).toBe('tdd-flow status pane opened.')
  expect(w.opened).toEqual(['tdd-status'])
  expect(w.runs.at(-1)?.stdin).toBe('{"pane":true}')
})

test('a failed status call is one dim line in the pane, not a toast per tick', async ($, on) => {
  const w = world(on, { fail: 'not inside a git repository' })
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  await clock.advance(30_000)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  expect((await ui.find({ type: 'Text', text: /^tdd-flow status:/ }))?.text).toBe('tdd-flow status: not inside a git repository')
  expect(w.toasts).toEqual([])
  expect(w.statusWrites).toBe(1)
  await ui.unmount()
})

test('a workflow started in this session is listed until its task notification arrives', async ($, on) => {
  world(on, { rows: [] })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: { status: 'async_launched' as const, taskId: 'wf-7', workflowName: 'tdd-implement' } }))
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Workflow', name: 'tdd-implement', args: { feature: '23-csv', maxTasks: 1 } })
  await clock.advance(180_000)
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  expect((await ui.find({ type: 'Text', text: /tdd-implement/ }))?.text).toBe('  tdd-implement · 23-csv · 3 min')
  await ui.unmount()
  await $.prompt.submit({ text: '<task-notification><task-id>wf-7</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' }, wait: false })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /This session/ })).toBeUndefined()
  await ui.unmount()
})

// ---------- row labels and the restart button (0.27.0) ----------
const RENUMBERED: StatusRow = {
  ...RUNNING, slug: 'zjednoduseni-aplikace-jedina-obrazovka-r', title: 'Simplify the app to one screen', done: 1, total: 16,
  current: 'T-11 Shared header', task: 'T-11', position: 2, issueUrl: 'https://github.com/o/r/issues/25', issueNumber: 25,
  prUrl: 'https://github.com/o/r/pull/24', prNumber: 24,
}

test('a row is labelled by the spec title, shows the open task position of a renumbered list and names its links', async ($, on) => {
  const odd: StatusRow = { ...RUNNING, slug: '7-odd', title: '', done: 0, total: 2, current: 'T-1 First', position: 1,
    issueUrl: 'https://dev.azure.com/o/p/_workitems/edit/31', issueNumber: null, prUrl: 'https://example.test/pr/7', prNumber: null }
  world(on, { rows: [RENUMBERED, odd] })
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  // The title is the label; the slug follows dim only where it fits.
  expect((await ui.find({ type: 'Text', text: /^● Simplify/ }))?.text).toBe('● Simplify the app to one screen')
  expect(await ui.find({ type: 'Text', text: /^● zjednoduseni/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^● 7-odd/ }))?.text).toBe('● 7-odd') // no title: the slug
  expect((await ui.find({ type: 'Text', text: /1\/16 done/ }))?.text).toBe('  1/16 done · T-11 (task 2) Shared header')
  expect((await ui.find({ type: 'Text', text: /0\/2 done/ }))?.text).toBe('  0/2 done · T-1 First') // numbered from 1: no position
  const links = (await ui.findAll({ type: 'Link' })).map(l => [l.props.href, l.text])
  expect(links).toEqual([
    ['https://github.com/o/r/issues/25', 'issue #25'], ['https://github.com/o/r/pull/24', 'PR #24'],
    ['https://dev.azure.com/o/p/_workitems/edit/31', 'issue 31'], ['https://example.test/pr/7', 'PR 7'],
  ])
  await ui.unmount()
  const wide = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 120 } })
  expect((await wide.find({ type: 'Text', text: /^● Simplify/ }))?.text).toBe('● Simplify the app to one screen zjednoduseni-aplikace-jedina-obrazovka-r')
  await wide.unmount()
})

test('the restart button is on blocked rows without a decision and stalled rows only, and runs tdd-flow restart', async ($, on) => {
  const blocked: StatusRow = { ...RUNNING, slug: '41-blocked', status: 'blocked', details: 'tests fail', sessionState: 'done' }
  const stalled: StatusRow = { ...RUNNING, slug: '42-stalled', status: 'stalled', details: 'session is idle without a report' }
  const done: StatusRow = { ...RUNNING, slug: '43-done', status: 'done' }
  const w = world(on, { rows: [RUNNING, DECISION, blocked, stalled, done] })
  const clock = mock.clock(on)
  await $.session.start(SESSION)
  await clock.advance(1)
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('restart:'))
  expect(keys).toEqual(['restart:41-blocked', 'restart:42-stalled'])

  // In flight: "restarting…" instead of the button, so it cannot be pressed twice.
  // A press resolves once the work it started settles, so it is awaited only after the restart is released.
  w.isRestartHeld = true
  const pressing = ui.press({ key: 'restart:42-stalled' })
  for (let i = 0; i < 1000 && !w.runs.some(r => r.argv[1] === 'restart'); i++) await Promise.resolve()
  const call = w.runs.find(r => r.argv[1] === 'restart')
  expect(call?.argv[0]?.endsWith('/bin/tdd-flow')).toBe(true)
  expect([call?.cwd, call?.stdin]).toEqual([ROOT, '{"slug":"42-stalled"}'])
  expect((await ui.find({ type: 'Text', text: /restarting/ }))?.text).toBe('  restarting…')
  expect(await ui.find({ type: 'Button', key: 'restart:42-stalled' })).toBeUndefined()
  w.release()
  await pressing
  expect((await ui.find({ type: 'Text', text: /restarting/ }))?.text).toBe('  restarting…')
  // A status still showing the spec stalled (read before the restart landed) keeps "restarting…"; one showing it run clears it.
  await clock.advance(10_000)
  expect((await ui.find({ type: 'Text', text: /restarting/ }))?.text).toBe('  restarting…')
  w.rows = [RUNNING, DECISION, blocked, { ...stalled, status: 'running' }, done]
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: /restarting/ })).toBeUndefined()
  await ui.unmount()

  // A restart whose answer never comes (the pane reloaded meanwhile) gives the button back after the CLI timeout.
  w.rows = [RUNNING, DECISION, blocked, stalled, done]
  await clock.advance(10_000)
  w.isRestartHeld = true
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  const stuck = ui.press({ key: 'restart:42-stalled' })
  for (let i = 0; i < 1000 && w.runs.filter(r => r.argv[1] === 'restart').length < 2; i++) await Promise.resolve()
  await clock.advance(60_000)
  expect((await ui.find({ type: 'Text', text: /restarting/ }))?.text).toBe('  restarting…')
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: /restarting/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'restart:42-stalled' })).toBeDefined()
  w.restartOut = { ok: false, shape: '', error: '42-stalled is running: only a blocked or stalled spec is restarted' }
  w.release()
  await stuck
  await ui.unmount()

  // A refused restart shows the CLI's error line in the row, and the button stays.
  w.isRestartHeld = false
  w.restartOut = { ok: false, shape: '', error: '41-blocked has session s-9 working\nmore' }
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'restart:41-blocked' })
  await clock.advance(1)
  expect((await ui.find({ type: 'Text', text: /tdd-flow restart:/ }))?.text).toBe('  tdd-flow restart: 41-blocked has session s-9 working')
  expect(await ui.find({ type: 'Button', key: 'restart:41-blocked' })).toBeDefined()
  await ui.unmount()
  expect(w.runs.filter(r => r.argv[1] === 'restart').map(r => r.stdin)).toEqual(['{"slug":"42-stalled"}', '{"slug":"42-stalled"}', '{"slug":"41-blocked"}'])
  expect(w.ran).toEqual([]) // no skill, no model
  expect(w.submitted).toEqual([])
})
