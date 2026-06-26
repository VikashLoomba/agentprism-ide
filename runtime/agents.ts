// runtime/agents.ts
//
// Agent discovery + install probe (§4.1, B16). This is filesystem resolution and
// therefore belongs in the runtime — the ONLY layer that touches the filesystem.
// It anchors at PACKAGE_ROOT (the agent bins ship with AgentPrism, LOCKED
// decision 3), so it is process-global, NOT workspace-scoped. The server PROJECTS
// listAgents(); it composes ZERO candidate paths of its own.
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT, resolveAgentBin } from './paths.ts'
import { ACP_AGENT_LIST } from '../shared/agents.ts'
import type { AcpAgentSpec } from '../shared/agents.ts'

/** True iff agentId's ACP bin is installed under AgentPrism's PACKAGE_ROOT. The
 *  EXACT candidate-path composition + fs.existsSync moved verbatim out of
 *  server/factory.ts — no behavior change, only relocation. */
export function isAgentInstalled(agentId: string): boolean {
  const candidates = [
    resolveAgentBin(agentId),
    path.join(PACKAGE_ROOT, 'node_modules', '@agentclientprotocol', `${agentId}-agent-acp`),
    path.join(PACKAGE_ROOT, 'node_modules', '@agentclientprotocol', `${agentId}-acp`),
  ].filter(Boolean) as string[]
  return candidates.some((p) => fs.existsSync(p))
}

/** The agent catalog with per-agent installed status (was factory.ts
 *  agentsWithStatus()). Process-global: agent bins ship with AgentPrism at
 *  PACKAGE_ROOT, identical for every workspace. */
export function listAgents(): AcpAgentSpec[] {
  return ACP_AGENT_LIST.map((a) => ({ ...a, installed: isAgentInstalled(a.id) }))
}
