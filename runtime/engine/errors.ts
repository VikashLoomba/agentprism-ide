/** Errors that halt the whole run (vs. recoverable ones that resolve to null). */
export class NonRecoverableWorkflowError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = code
  }
}

export class WorkflowAbortError extends NonRecoverableWorkflowError {
  constructor(message = 'Workflow aborted') {
    super('WORKFLOW_ABORTED', message)
  }
}

export class AgentLimitError extends NonRecoverableWorkflowError {
  constructor(max: number) {
    super('AGENT_LIMIT_EXCEEDED', `Agent limit exceeded (max ${max} per run)`)
  }
}

export class TokenBudgetError extends NonRecoverableWorkflowError {
  constructor() {
    super('TOKEN_BUDGET_EXHAUSTED', 'Token budget exhausted')
  }
}

export function isNonRecoverable(err: unknown): err is NonRecoverableWorkflowError {
  return err instanceof NonRecoverableWorkflowError
}
