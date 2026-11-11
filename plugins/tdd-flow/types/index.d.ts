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
}

/** The last `tdd-flow status` result, or the error of the last failed call (rows kept from before). */
export type StatusSnapshot = { rows: StatusRow[]; error: string }

/** A decision answered from the pane, shown as "answer sent" until the spec runs again. */
export type SentAnswer = { slug: string; id: string }

/** A Workflow started in this session that has not sent its task notification yet. */
export type SessionWorkflow = { taskId: string; name: string; feature: string; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'tdd-flow': {
      status: Shaped<StatusSnapshot | null>
      isClosed: boolean
      sent: Shaped<SentAnswer[]>
      workflows: Shaped<SessionWorkflow[]>
    }
  }
}
