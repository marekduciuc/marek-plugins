// State contract of the tdd-flow status pane (hooks/register.tsx): the values it keeps in $.state.

/** A blocked run's question for the user, as `tdd-flow run-report` recorded it. */
export type Decision = { id: string; question: string; recommendation: string; options: string[]; tasks: string[] }

/** One row of `tdd-flow status`: a spec with a worktree or a run file. */
export type StatusRow = {
  slug: string
  status: string
  done: number | null
  total: number | null
  current: string
  prUrl: string
  details: string
  attach: string
  decision?: Decision
  task: string
  phase: string
  issueUrl: string
  title: string
  session: string
  sessionState: string
  at: string
  /** Position of the open task in tasks.md, from 1; null when every task is ticked or there is no task list. */
  position: number | null
  /** The number of `/issues/<n>` in `issueUrl`, of `/pull/<n>` in `prUrl`; null when the URL has none. */
  issueNumber: number | null
  prNumber: number | null
}

/** The last `tdd-flow status` result, or the error of the last failed call (rows kept from before). */
export type StatusSnapshot = { rows: StatusRow[]; error: string }

/** A decision answered from the pane, shown as "answer sent" until the spec runs again. */
export type SentAnswer = { slug: string; id: string }

/**
 * A restart from the pane: in flight (`running`), done until a status shows the spec running (`sent`), or refused
 * (`failed`, with the CLI's error line). `at`: when it got this state ($.clock.now), so a lost one expires.
 */
export type RestartState = { slug: string; state: 'running' | 'sent' | 'failed'; error: string; at: number }

/** A Workflow started in this session that has not sent its task notification yet. */
export type SessionWorkflow = { taskId: string; name: string; feature: string; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'tdd-flow': {
      status: Shaped<StatusSnapshot | null>
      isClosed: boolean
      sent: Shaped<SentAnswer[]>
      restarts: Shaped<RestartState[]>
      workflows: Shaped<SessionWorkflow[]>
    }
  }
}
