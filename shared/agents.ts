/** Available ACP coding agents that can power a workflow run. */

export type AcpAgentId = 'claude' | 'codex'

export interface SessionModeInfo {
  id: string
  name: string
  description?: string | null
}

export interface SessionModeState {
  currentModeId: string
  availableModes: SessionModeInfo[]
}

export interface ConfigOptionValue {
  value: string
  name: string
  description?: string
}

export interface ConfigOptionCatalogEntry {
  id: string
  name: string
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | string
  type: 'select' | 'boolean'
  values?: ConfigOptionValue[]
  open?: boolean
  conditional?: boolean
}

export interface AcpAgentSpec {
  id: AcpAgentId
  name: string
  description: string
  /** Executable to spawn (default: npx). */
  command: string
  /** Args that launch the agent in ACP stdio mode. */
  args: string[]
  /** Documentation link. */
  docsUrl: string
  /** Env var that, if missing, may require interactive auth (informational). */
  authEnv?: string
  /** Whether the package/binary resolves locally (filled in by the server). */
  installed?: boolean
  /** Best-known session modes, shown before a live session reports real ones. */
  defaultModes: SessionModeState
  /** Static catalog of per-call session-config options, shown before a live session reports real ones. */
  configCatalog: ConfigOptionCatalogEntry[]
}

/**
 * Static registry. The exact mode IDs come from the agents themselves at
 * session/new time; these defaults (verified against the agent sources) drive
 * the run-config UI until a real session reports its modes.
 */
export const ACP_AGENTS: Record<AcpAgentId, AcpAgentSpec> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    description: 'Claude Agent SDK (Claude Code) over ACP.',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    docsUrl: 'https://github.com/agentclientprotocol/claude-agent-acp',
    authEnv: 'ANTHROPIC_API_KEY',
    defaultModes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default', description: 'Ask before edits and commands.' },
        { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-accept file edits.' },
        { id: 'plan', name: 'Plan Mode', description: 'Plan only; no tool execution.' },
        { id: 'dontAsk', name: "Don't Ask", description: 'Never prompt; deny if not pre-approved.' },
        {
          id: 'bypassPermissions',
          name: 'Bypass Permissions',
          description: 'Run everything without prompts (sandbox/non-root only).',
        },
      ],
    },
    configCatalog: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        values: [
          { value: 'default', name: 'Default' },
          { value: 'acceptEdits', name: 'Accept Edits' },
          { value: 'plan', name: 'Plan Mode' },
          { value: 'dontAsk', name: "Don't Ask" },
          { value: 'bypassPermissions', name: 'Bypass Permissions' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        open: true,
        values: [
          { value: 'default', name: 'Default' },
          { value: 'opus', name: 'Opus' },
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'haiku', name: 'Haiku' },
        ],
      },
      {
        id: 'effort',
        name: 'Reasoning Effort',
        category: 'thought_level',
        type: 'select',
        open: true,
        conditional: true,
        values: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Extra High' },
          { value: 'max', name: 'Max' },
        ],
      },
      {
        id: 'agent',
        name: 'Agent',
        type: 'select',
        open: true,
        conditional: true,
        values: [{ value: 'default', name: 'Default' }],
      },
    ],
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex (App Server) over ACP.',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    docsUrl: 'https://github.com/agentclientprotocol/codex-acp',
    authEnv: 'OPENAI_API_KEY',
    defaultModes: {
      currentModeId: 'agent',
      availableModes: [
        { id: 'read-only', name: 'Read-only', description: 'Approval required to edit or run.' },
        { id: 'agent', name: 'Agent', description: 'Read/edit files and run commands.' },
        {
          id: 'agent-full-access',
          name: 'Agent (full access)',
          description: 'Edit outside the workspace and use the network.',
        },
      ],
    },
    configCatalog: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        values: [
          { value: 'read-only', name: 'Read-only' },
          { value: 'agent', name: 'Agent' },
          { value: 'agent-full-access', name: 'Agent (full access)' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        open: true,
        values: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning Effort',
        category: 'thought_level',
        type: 'select',
        open: true,
        conditional: true,
        values: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'fast-mode',
        name: 'Fast Mode',
        category: 'fast-mode',
        type: 'select',
        values: [
          { value: 'on', name: 'On' },
          { value: 'off', name: 'Off' },
        ],
      },
    ],
  },
}

export const ACP_AGENT_LIST: AcpAgentSpec[] = Object.values(ACP_AGENTS)

/** Ids of the agents whose package/binary resolves locally (installed === connected). */
export function connectedAgentIds(agents: AcpAgentSpec[]): AcpAgentId[] {
  return agents.filter((a) => a.installed).map((a) => a.id)
}
