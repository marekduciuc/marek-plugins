// tdd-flow status pane: every spec of the repo beside the chat (`tdd-flow status`, every 10 s), the workflows this
// session started, a waiting decision answered from the pane through the answer-decision skill, and a blocked or
// stalled spec restarted with `tdd-flow restart` (no model).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderViewport, ThemeKey } from 'claude-code'

import type { StatusRow, StatusSnapshot } from '../types'

const PANE = 'tdd-status'
const TITLE = 'tdd-flow'
const POLL_MS = 10_000
const CLI_TIMEOUT_MS = 30_000
/** The fullscreen layout docks a pane beside the transcript from this width; below it an unasked pane lands inline. */
const DOCK_COLUMNS = 110
const ANSWER_SKILL = 'tdd-flow:answer-decision'

// Change a shape tag when the value's fields change: a reload then reads what the old code stored as the initial.
const status = atom({ plugin: 'tdd-flow', key: 'status' } as const, null, { shape: 'status-1' })
const isClosed = atom({ plugin: 'tdd-flow', key: 'isClosed' } as const, false)
const sent = atom({ plugin: 'tdd-flow', key: 'sent' } as const, [], { shape: 'sent-1' })
const restarts = atom({ plugin: 'tdd-flow', key: 'restarts' } as const, [], { shape: 'restarts-1' })
const workflows = atom({ plugin: 'tdd-flow', key: 'workflows' } as const, [], { shape: 'workflows-1' })

/** Display order and colour per kind of row; a blocked row with a decision is its own kind. */
const KINDS: readonly { kind: string; color: ThemeKey }[] = [
  { kind: 'decision', color: 'permission' },
  { kind: 'blocked', color: 'error' },
  { kind: 'stalled', color: 'warning' },
  { kind: 'running', color: 'suggestion' },
  { kind: 'queued', color: 'inactive' },
  { kind: 'done', color: 'success' },
]
const kindOf = (row: StatusRow): string => (row.decision ? 'decision' : row.status)
const rankOf = (row: StatusRow): number => {
  const i = KINDS.findIndex(k => k.kind === kindOf(row))
  return i < 0 ? KINDS.length : i
}
const colorOf = (row: StatusRow): ThemeKey => KINDS.find(k => k.kind === kindOf(row))?.color ?? 'subtle'
/** A blocked row without a decision or a stalled row can be restarted from the pane. */
const canRestart = (row: StatusRow): boolean => row.status === 'stalled' || (row.status === 'blocked' && !row.decision)
const isActive = (row: StatusRow): boolean => ['running', 'blocked', 'stalled'].includes(row.status)

/** Cuts `text` to `width` cells with an ellipsis. */
const fit = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
/** `#<n>` when the number was parsed, else the last path part of the URL. */
const linkTail = (n: number | null, url: string): string => (n !== null ? `#${n}` : (url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? url))
const firstLine = (text: string): string => text.split('\n')[0] ?? ''
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The feature a Workflow call works on: its `args` slug, or `args.feature`. */
function featureOf(args: unknown): string {
  if (typeof args === 'string') {
    if (!args.trim().startsWith('{')) return args.trim()
    try {
      return featureOf(JSON.parse(args))
    } catch {
      return ''
    }
  }
  if (args && typeof args === 'object' && 'feature' in args && typeof args.feature === 'string') return args.feature
  return ''
}

// What the drawing sites last said about the layout: whether a pane opened unasked would dock as a sidebar.
let viewport: RenderViewport | undefined

/** The main checkout's root when the session is in a git repo with `.tdd-flow/`, else null. */
async function specRoot($: EngineInterface): Promise<string | null> {
  const repo = await $.session.repo()
  if (!repo) return null
  return (await $.fs.exists(`${repo.root}/.tdd-flow`)) ? repo.root : null
}

/** Runs `tdd-flow status`; a failure keeps the rows of the last good call and says why in `error`. */
async function runStatus($: EngineInterface, root: string, isPaneOpen: boolean, prev: StatusSnapshot | null): Promise<StatusSnapshot> {
  const kept = prev?.rows ?? []
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/tdd-flow`, 'status'], {
      cwd: root,
      stdin: JSON.stringify(isPaneOpen ? { pane: true } : {}),
      timeoutMs: CLI_TIMEOUT_MS,
    })
    const out = JSON.parse(ran.stdout) as { ok: boolean; result?: { rows: StatusRow[] }; error?: string }
    if (out.ok && out.result) return { rows: out.result.rows, error: '' }
    return { rows: kept, error: `tdd-flow status: ${out.error ?? `exit ${ran.exitCode}`}` }
  } catch (err) {
    return { rows: kept, error: `tdd-flow status failed: ${errorText(err)}` }
  }
}

/** One timer tick: new status into the atom (only when it changed), answered decisions, auto-open, status line. */
async function refresh($: EngineInterface): Promise<void> {
  const root = await specRoot($)
  if (root === null) return
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  const closedByPerson = await read($, isClosed)
  const prev = await read($, status)
  const snapshot = await runStatus($, root, pane?.isPlaced === true, prev)
  if (JSON.stringify(snapshot) !== JSON.stringify(prev)) await update($, status, () => snapshot)
  const { rows } = snapshot

  // "answer sent" stays until the spec runs again (or its row is gone).
  const answered = await read($, sent)
  const waiting = answered.filter(s => rows.some(r => r.slug === s.slug && r.status !== 'running'))
  if (waiting.length !== answered.length) await update($, sent, list => list.filter(s => waiting.some(w => w.slug === s.slug)))

  // A restart error stays until the row can no longer be restarted (it runs again) or the button is pressed again.
  const failed = await read($, restarts)
  const kept = failed.filter(r => r.error === '' || rows.some(row => row.slug === r.slug && canRestart(row)))
  if (kept.length !== failed.length) await update($, restarts, () => kept)

  const docks = viewport?.isFullscreen === true && viewport.columns >= DOCK_COLUMNS
  if (!pane && !closedByPerson && docks && rows.some(isActive)) await $.ui.open({ id: PANE, title: TITLE })

  const running = rows.filter(r => r.status === 'running').length
  const decisions = rows.filter(r => r.decision).length
  $.ui.status(!pane && running + decisions > 0 ? `tdd-flow: ${running} running, ${decisions} waiting` : undefined)
  if (pane && (await read($, workflows)).length > 0) $.ui.invalidate('ui.render') // minutes running
}

/** Writes an error no tick could record into the snapshot, so the pane shows it as its one dim line. */
async function showError($: EngineInterface, err: unknown): Promise<void> {
  const error = `tdd-flow status pane: ${errorText(err)}`
  await update($, status, prev => ({ rows: prev?.rows ?? [], error })).catch(() => $.ui.log(error))
}

/** Answers a decision through the answer-decision skill in this session; the row says "answer sent" meanwhile. */
async function answer($: EngineInterface, slug: string, id: string, text: string): Promise<void> {
  const reply = text.replace(/\s+/g, ' ').trim()
  if (!reply) return
  const args = `${slug} ${id} ${reply}`
  await update($, sent, list => [...list.filter(s => s.slug !== slug), { slug, id }])
  try {
    const isListed = (await $.command.list()).some(c => c.name === ANSWER_SKILL)
    try {
      if (!isListed) throw new Error(`${ANSWER_SKILL} is not listed`)
      await $.command.run({ command: ANSWER_SKILL, args })
    } catch {
      // The engine refuses a plugin prompt that starts with "/", so the fallback asks the model to run the skill.
      await $.prompt.submit({ text: `Run the ${ANSWER_SKILL} skill with these arguments: ${args}`, asUser: true })
    }
  } catch (err) {
    await update($, sent, list => list.filter(s => s.slug !== slug))
    $.ui.log(`tdd-flow: the answer to ${slug} ${id} was not sent: ${errorText(err)}`)
  }
}

/** Runs `tdd-flow restart` for a spec (no model, no skill); the row says "restarting…" meanwhile and shows the CLI's error line when it fails. */
async function restart($: EngineInterface, slug: string): Promise<void> {
  const root = await specRoot($)
  if (root === null) return
  await update($, restarts, list => [...list.filter(r => r.slug !== slug), { slug, error: '' }])
  let error = ''
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/tdd-flow`, 'restart'], { cwd: root, stdin: JSON.stringify({ slug }), timeoutMs: CLI_TIMEOUT_MS })
    const out = JSON.parse(ran.stdout) as { ok: boolean; error?: string }
    if (!out.ok) error = firstLine(out.error ?? `tdd-flow restart: exit ${ran.exitCode}`)
  } catch (err) {
    error = `tdd-flow restart failed: ${firstLine(errorText(err))}`
  }
  await update($, restarts, list => (error ? list.map(r => (r.slug === slug ? { slug, error } : r)) : list.filter(r => r.slug !== slug)))
  if (!error) await refresh($).catch(err => showError($, err))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Background sessions (the autopilot's) and -p runs have nobody to show a pane to.
    if (!e.isInteractive) return next(e)
    await $.command.register({ name: 'tdd-status', description: 'Show the tdd-flow status pane: every spec of this repo and its waiting decisions' })
    const tick = (): void => {
      refresh($).catch(err => showError($, err))
    }
    $.clock.after(1, tick)
    $.clock.every(POLL_MS, tick)
    return next(e)
  })

  on('command.run', { command: 'tdd-status' }, async $ => {
    await update($, isClosed, () => false)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    await refresh($).catch(err => showError($, err))
    return { text: 'tdd-flow status pane opened.' }
  })

  // A pane the person closed stays closed until /tdd-status.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isClosed, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const ran = await next(e)
    const launched = ran.isError || ran.deny !== undefined ? undefined : (ran.result as { taskId?: unknown; workflowName?: unknown })
    if (launched && typeof launched.taskId === 'string') {
      const taskId = launched.taskId
      const name = typeof launched.workflowName === 'string' ? launched.workflowName : e.name ?? 'workflow'
      const run = { taskId, name, feature: featureOf(e.args), startedAt: await $.clock.now() }
      await update($, workflows, list => [...list.filter(w => w.taskId !== taskId), run])
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A workflow's task notification names its task id: the workflow has ended.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const list = await read($, workflows)
      if (list.some(w => e.text.includes(w.taskId))) await update($, workflows, all => all.filter(w => !e.text.includes(w.taskId)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  const seeViewport = (seen: RenderViewport | undefined): void => {
    if (seen?.isFullscreen !== undefined) viewport = seen
  }
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    seeViewport(e.viewport)
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    seeViewport(e.viewport)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const cols = Math.max(20, e.props.bodyColumns)
    const snapshot = await read($, status)
    const answered = await read($, sent)
    const flows = await read($, workflows)
    const restarting = await read($, restarts)
    const now = await $.clock.now()
    const rows = [...(snapshot?.rows ?? [])].sort((a, b) => rankOf(a) - rankOf(b))
    const firstDecision = rows.find(r => r.decision)?.slug

    const meta = (row: StatusRow) => {
      const parts = [
        row.phase ? <Text>{row.phase}</Text> : null,
        row.issueUrl ? <Link href={row.issueUrl}>{`issue ${linkTail(row.issueNumber, row.issueUrl)}`}</Link> : null,
        row.prUrl ? <Link href={row.prUrl}>{`PR ${linkTail(row.prNumber, row.prUrl)}`}</Link> : null,
        row.attach ? <Text>{row.attach}</Text> : null,
      ].filter(part => part !== null)
      if (parts.length === 0) return null
      return (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {parts.flatMap((part, i) => (i === 0 ? [part] : [' · ', part]))}
          </Text>
          {row.attach ? <Button key={`copy:${row.slug}`} label="copy" onPress={press => void $.ui.copy({ text: row.attach, surface: press.surface })} /> : null}
        </Box>
      )
    }

    const decisionBlock = (row: StatusRow) => {
      const d = row.decision
      if (!d) return null
      const isSent = answered.some(s => s.slug === row.slug && s.id === d.id)
      const hotkeys = row.slug === firstDecision
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text wrap="wrap">{`${d.id}: ${d.question}`}</Text>
          {d.tasks.length > 0 ? <Text dimColor>{`Blocks ${d.tasks.join(', ')}`}</Text> : null}
          <Text dimColor wrap="wrap">{`Recommendation: ${d.recommendation}`}</Text>
          {isSent ? (
            <Text color="success">answer sent</Text>
          ) : (
            <Box flexDirection="column">
              {d.options.map((option, i) => (
                <Button
                  key={`option:${row.slug}:${i}`}
                  label={option}
                  {...(hotkeys && i < 9 ? { hotkey: String(i + 1) } : {})}
                  onPress={() => void answer($, row.slug, d.id, option)}
                />
              ))}
              <Button key={`recommendation:${row.slug}`} label="use recommendation" variant="primary" onPress={() => void answer($, row.slug, d.id, d.recommendation)} />
              {Input ? (
                <Input key={`answer:${row.slug}`} placeholder="or type your own answer" submitLabel="send" onSubmit={value => void answer($, row.slug, d.id, value)} />
              ) : null}
            </Box>
          )}
        </Box>
      )
    }

    const specRow = (row: StatusRow) => {
      const word = kindOf(row)
      const open = row.position !== null ? row.current.match(/^(T-\d+)\s*(.*)$/) : null
      const current = open ? `${open[1]} (task ${row.position}) ${open[2]}`.trim() : row.current
      const tasks = row.total === null ? '–' : `${row.done}/${row.total} done${current ? ` · ${current}` : ''}`
      const label = row.title || row.slug
      const room = cols - word.length - 3
      const showSlug = row.title !== '' && row.title.length + 2 + row.slug.length <= room
      const mine = restarting.find(r => r.slug === row.slug)
      const why = !row.decision && ['blocked', 'stalled'].includes(row.status) && row.details ? firstLine(row.details) : ''
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={colorOf(row)}>●</Text>
              {` ${fit(label, room)}`}
              {showSlug ? <Text dimColor>{`  ${row.slug}`}</Text> : null}
            </Text>
            <Text color={colorOf(row)}>{word}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ${tasks}`}</Text>
          {meta(row)}
          {why ? <Text color={colorOf(row)} wrap="truncate-end">{`  ${why}`}</Text> : null}
          {mine?.error ? <Text color="error" wrap="truncate-end">{`  ${mine.error}`}</Text> : null}
          {mine?.error === '' ? <Text dimColor>{'  restarting…'}</Text> : null}
          {canRestart(row) && mine?.error !== '' ? (
            <Box paddingLeft={2}>
              <Button key={`restart:${row.slug}`} label="restart" onPress={() => void restart($, row.slug)} />
            </Box>
          ) : null}
          {decisionBlock(row)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {snapshot?.error ? <Text dimColor wrap="truncate-end">{snapshot.error}</Text> : null}
        {flows.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>This session</Text>
            {flows.map(w => (
              <Text wrap="truncate-end">{`  ${w.name}${w.feature ? ` · ${w.feature}` : ''} · ${Math.floor((now - w.startedAt) / 60_000)} min`}</Text>
            ))}
          </Box>
        ) : null}
        {snapshot === null ? <Text dimColor>Reading tdd-flow status…</Text> : null}
        {snapshot !== null && rows.length === 0 && !snapshot.error ? <Text dimColor>No tdd-flow spec has a worktree or a run yet.</Text> : null}
        {rows.map(specRow)}
      </Box>
    )
  })
}
