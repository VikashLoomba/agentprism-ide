import type { AgentCallState, RunEvent, RunSnapshot } from '@shared/events'

const LOG_CAP = 3000

function ensurePhase(run: RunSnapshot, title: string) {
  let phase = run.phases.find((p) => p.title === title)
  if (!phase) {
    phase = { title, agentIds: [] }
    run.phases.push(phase)
  }
  return phase
}

function findAgent(run: RunSnapshot, id: string): AgentCallState | undefined {
  return run.agents.find((a) => a.id === id)
}

/** Mutates the snapshot in place. The caller clones the top-level to re-render. */
export function applyRunEvent(run: RunSnapshot, event: RunEvent): void {
  switch (event.type) {
    case 'run:started':
      run.meta = event.meta
      run.agent = event.agent
      run.cwd = event.cwd
      if (event.phases.length) run.phases = event.phases.map((p) => ({ ...p, agentIds: [...p.agentIds] }))
      break
    case 'run:status':
      run.status = event.status
      break
    case 'session:modes':
      run.modes = event.modes
      break
    case 'session:configOptions':
      run.configOptions = event.options
      break
    case 'phase:enter':
      ensurePhase(run, event.title)
      break
    case 'agent:started': {
      if (!findAgent(run, event.agent.id)) run.agents.push(event.agent)
      const phase = ensurePhase(run, event.agent.phase)
      if (!phase.agentIds.includes(event.agent.id)) phase.agentIds.push(event.agent.id)
      break
    }
    case 'agent:delta': {
      const agent = findAgent(run, event.agentId)
      if (agent) {
        if (event.channel === 'message') agent.message += event.text
        else agent.thoughts += event.text
      }
      break
    }
    case 'agent:tool': {
      const agent = findAgent(run, event.agentId)
      if (agent) {
        const existing = agent.toolCalls.find((t) => t.id === event.tool.id)
        if (existing) Object.assign(existing, event.tool)
        else agent.toolCalls.push(event.tool)
      }
      break
    }
    case 'agent:finished': {
      const agent = findAgent(run, event.agentId)
      if (agent) {
        agent.status = event.status
        agent.output = event.output ?? agent.output
        agent.resultJson = event.resultJson ?? agent.resultJson
        agent.error = event.error
        agent.tokens = event.tokens ?? agent.tokens
        agent.finishedAt = Date.now()
      }
      break
    }
    case 'acp':
      run.log.push(event.entry)
      if (run.log.length > LOG_CAP) run.log.splice(0, run.log.length - LOG_CAP)
      break
    case 'log':
      run.log.push({ id: `l${run.log.length}`, ts: Date.now(), level: 'info', type: 'log', text: event.message })
      break
    case 'breakpoint:set':
      run.breakpoints = event.lines
      break
    case 'breakpoint:hit':
      run.pause = event.pause
      run.status = 'paused'
      break
    case 'breakpoint:resumed':
      if (run.pause?.id === event.pauseId) run.pause = undefined
      break
    case 'run:finished':
      run.status = event.status
      run.result = event.result
      run.error = event.error
      run.stats = event.stats
      run.finishedAt = Date.now()
      run.pause = undefined
      break
  }
}
