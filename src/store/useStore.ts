import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { AcpAgentId, AcpAgentSpec, SessionModeState } from '@shared/agents'
import type { RunEvent, RunSnapshot } from '@shared/events'
import type {
  CapabilityCatalogEntry,
  PermissionRequest,
  PermissionResponse,
  PromptCatalogEntry,
  RunRequest,
  ServerMessage,
  WorkflowFileInfo,
} from '@shared/protocol'
import { resolveCapability, type CapabilityCatalog } from '@shared/capability-resolve'
import { resolvePrompt, type PromptCatalog } from '@shared/prompt-resolve'
import { validateWorkflow, type ValidateResult } from '@shared/validate'
import { applyRunEvent } from './runReducer'
import * as api from '@/lib/api'
import { DEFAULT_WORKFLOW } from '@/lib/defaults'
import { buildWorkflowDts, INITIAL_WORKFLOW_DSL_DTS } from '@/lib/workflow-dts'
import { createWsClient, type WsClient, type WsStatus } from '@/lib/ws'

/** Ids of the installed (connected) agents — the per-call agent() backend set. */
function installedAgentIds(agents: AcpAgentSpec[]): AcpAgentId[] {
  return agents.filter((a) => a.installed).map((a) => a.id)
}

/** Regenerate the Monaco DSL .d.ts for the connected agents + the default, scoped
 *  to the capability entries the current workflow's `meta.capabilities` resolve to. */
function workflowDtsFor(
  agents: AcpAgentSpec[],
  defaultAgentId: AcpAgentId,
  capabilities?: CapabilityCatalogEntry[],
  prompts?: PromptCatalogEntry[],
): string {
  return buildWorkflowDts(
    agents.filter((a) => a.installed),
    defaultAgentId,
    capabilities,
    prompts,
  )
}

/** Build the isomorphic project>user catalog view from the flat fetched entry list. */
function buildCapabilityCatalog(entries: CapabilityCatalogEntry[]): CapabilityCatalog {
  const catalog: CapabilityCatalog = { project: {}, user: {} }
  for (const entry of entries) catalog[entry.tier][entry.name] = entry
  return catalog
}

/** Build the isomorphic project>user prompt catalog view from the flat entry list. */
function buildPromptCatalog(entries: PromptCatalogEntry[]): PromptCatalog {
  const catalog: PromptCatalog = { project: {}, user: {} }
  for (const entry of entries) catalog[entry.tier][entry.name] = entry
  return catalog
}

/** The catalog entries a workflow's `meta.capabilities` resolve to (project-first),
 *  used to scope the dts so only declared namespaces appear. */
function scopedCapabilityEntries(
  catalog: CapabilityCatalog,
  metaCapabilities: string[] | undefined,
): CapabilityCatalogEntry[] {
  if (!metaCapabilities) return []
  const out: CapabilityCatalogEntry[] = []
  for (const raw of metaCapabilities) {
    const res = resolveCapability(catalog, raw)
    if (res.resolved) out.push(catalog[res.resolved][res.bareName])
  }
  return out
}

/** The catalog entries a workflow's `meta.prompts` resolve to (project-first),
 *  used to scope the `declare const prompts` dts to only declared templates. */
function scopedPromptEntries(
  catalog: PromptCatalog,
  metaPrompts: string[] | undefined,
): PromptCatalogEntry[] {
  if (!metaPrompts) return []
  const out: PromptCatalogEntry[] = []
  for (const raw of metaPrompts) {
    const res = resolvePrompt(catalog, raw)
    if (res.resolved) out.push(catalog[res.resolved][res.bareName])
  }
  return out
}

let ws: WsClient | null = null
let currentRun: RunSnapshot | null = null
let flushScheduled = false

function newSnapshot(req: RunRequest): RunSnapshot {
  return {
    runId: req.runId,
    status: 'starting',
    agent: req.agent,
    cwd: req.cwd,
    phases: [],
    agents: [],
    effects: [],
    log: [],
    stats: { agentCount: 0, completed: 0, failed: 0, durationMs: 0, tokens: {} },
    breakpoints: req.breakpoints,
    startedAt: Date.now(),
  }
}

/** Reduce the two `effect:*` events into `run.effects`, mirroring how `agent:*`
 *  upserts into `run.agents` (keyed by id) and groups under its phase. `applyRunEvent`
 *  has no case for these, so the store reduces them here. */
function reduceEffectEvent(run: RunSnapshot, event: RunEvent): boolean {
  if (event.type === 'effect:started') {
    const existing = run.effects.find((e) => e.id === event.effect.id)
    if (existing) Object.assign(existing, event.effect)
    else run.effects.push(event.effect)
    const phase = run.phases.find((p) => p.title === event.effect.phase)
    if (phase && !(phase.effectIds ??= []).includes(event.effect.id)) {
      phase.effectIds.push(event.effect.id)
    }
    return true
  }
  if (event.type === 'effect:finished') {
    const effect = run.effects.find((e) => e.id === event.effectId)
    if (effect) {
      effect.status = event.status
      if (event.status === 'ok') effect.result = event.result
      else effect.error = event.error
      effect.finishedAt = (effect.startedAt ?? Date.now()) + event.durationMs
    }
    return true
  }
  return false
}

function parseArgs(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

interface State {
  agents: AcpAgentSpec[]
  defaultCwd: string
  wsStatus: WsStatus

  /** Flat list of every available capability (both tiers), from /api/capabilities. */
  capabilities: CapabilityCatalogEntry[]
  /** Derived project>user view of `capabilities`, threaded into validateWorkflow. */
  capabilityCatalog: CapabilityCatalog

  /** Flat list of every available prompt template (both tiers), from /api/prompts. */
  prompts: PromptCatalogEntry[]
  /** Derived project>user view of `prompts`, threaded into validateWorkflow. */
  promptCatalog: PromptCatalog

  /** What kind of file the editor currently holds: a workflow script, a .hbs
   *  prompt template, or a tool/capability .ts module. Non-workflow modes gate
   *  off workflow-only editor machinery (markers, breakpoints, DSL .d.ts). */
  openKind: 'workflow' | 'prompt' | 'tool'
  /** Tier of the open prompt/tool file (so saves write back to the right dir);
   *  null for workflows. */
  openTier: 'project' | 'user' | null

  source: string
  fileName: string | null
  dirty: boolean
  validation: ValidateResult
  /** Monaco DSL .d.ts, regenerated from the connected agents + the default agent. */
  workflowDts: string

  breakpoints: number[]

  selectedAgent: AcpAgentId
  selectedMode: string
  cwd: string
  argsText: string
  stepMode: boolean
  manualApprovals: boolean
  maxConcurrency: number
  /** Per-run method config overrides (UI), keyed by method name then field. */
  methodConfig: Record<string, Record<string, unknown>>

  run: RunSnapshot | null
  activeRunId: string | null
  permission: PermissionRequest | null

  files: WorkflowFileInfo[]
  lastError: string | null

  init: () => Promise<void>
  setSource: (s: string) => void
  toggleBreakpoint: (line: number) => void
  setSelectedAgent: (id: AcpAgentId) => void
  setSelectedMode: (id: string) => void
  setCwd: (c: string) => void
  setArgsText: (s: string) => void
  setStepMode: (b: boolean) => void
  setManualApprovals: (b: boolean) => void
  setMaxConcurrency: (n: number) => void
  setMethodConfig: (method: string, key: string, value: unknown) => void
  clearMethodConfigField: (method: string, key: string) => void
  resetMethodConfig: (method: string) => void

  refreshCapabilities: () => Promise<void>
  refreshPrompts: () => Promise<void>
  refreshFiles: () => Promise<void>
  openFile: (name: string) => Promise<void>
  openPrompt: (tier: 'project' | 'user', name: string) => Promise<void>
  openTool: (tier: 'project' | 'user', fileName: string) => Promise<void>
  saveCurrent: (name?: string) => Promise<{ name: string } | undefined>
  deleteFileByName: (name: string) => Promise<void>
  newFile: () => void

  startRun: () => void
  cancelRun: () => void
  resumeRun: () => void
  stepRun: () => void
  respondPermission: (response: PermissionResponse) => void

  modesForUi: () => SessionModeState
  onServerMessage: (msg: ServerMessage) => void
}

export const useStore = create<State>((set, get) => {
  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    requestAnimationFrame(() => {
      flushScheduled = false
      if (currentRun) set({ run: { ...currentRun } })
    })
  }

  return {
    agents: [],
    defaultCwd: '',
    wsStatus: 'connecting',

    capabilities: [],
    capabilityCatalog: { project: {}, user: {} },

    prompts: [],
    promptCatalog: { project: {}, user: {} },
    openKind: 'workflow',
    openTier: null,

    source: DEFAULT_WORKFLOW,
    fileName: null,
    dirty: false,
    validation: validateWorkflow(DEFAULT_WORKFLOW, 'claude'),
    workflowDts: INITIAL_WORKFLOW_DSL_DTS,

    breakpoints: [],

    selectedAgent: 'claude',
    selectedMode: 'default',
    cwd: '',
    argsText: '',
    stepMode: false,
    manualApprovals: false,
    maxConcurrency: 8,
    methodConfig: {},

    run: null,
    activeRunId: null,
    permission: null,

    files: [],
    lastError: null,

    async init() {
      if (!ws) {
        ws = createWsClient({
          onMessage: (msg) => get().onServerMessage(msg),
          onStatus: (wsStatus) => set({ wsStatus }),
        })
      }
      try {
        const [{ agents, defaultCwd }, { capabilities }, { prompts }] = await Promise.all([
          api.fetchAgents(),
          api.fetchCapabilities(),
          api.fetchPrompts(),
        ])
        const capabilityCatalog = buildCapabilityCatalog(capabilities)
        const promptCatalog = buildPromptCatalog(prompts)
        const selected = agents.find((a) => a.installed) ?? agents[0]
        const selectedAgent = selected?.id ?? 'claude'
        const validation = validateWorkflow(
          get().source,
          selectedAgent,
          installedAgentIds(agents),
          capabilityCatalog,
          promptCatalog,
        )
        set({
          agents,
          defaultCwd,
          capabilities,
          capabilityCatalog,
          prompts,
          promptCatalog,
          cwd: get().cwd || defaultCwd,
          selectedAgent,
          selectedMode: selected?.defaultModes.currentModeId ?? 'default',
          workflowDts: workflowDtsFor(
            agents,
            selectedAgent,
            scopedCapabilityEntries(capabilityCatalog, validation.meta?.capabilities),
            scopedPromptEntries(promptCatalog, validation.meta?.prompts),
          ),
          validation,
        })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
      await get().refreshFiles()
    },

    setSource(source) {
      const s = get()
      const prevCaps = s.validation.meta?.capabilities
      const prevPrompts = s.validation.meta?.prompts
      const validation = validateWorkflow(
        source,
        s.selectedAgent,
        installedAgentIds(s.agents),
        s.capabilityCatalog,
        s.promptCatalog,
      )
      const nextCaps = validation.meta?.capabilities
      const nextPrompts = validation.meta?.prompts
      // Re-inject dts only when the declared `meta.capabilities`/`meta.prompts` set changes.
      const capsChanged = JSON.stringify(prevCaps) !== JSON.stringify(nextCaps)
      const promptsChanged = JSON.stringify(prevPrompts) !== JSON.stringify(nextPrompts)
      set({
        source,
        dirty: true,
        validation,
        ...(capsChanged || promptsChanged
          ? {
              workflowDts: workflowDtsFor(
                s.agents,
                s.selectedAgent,
                scopedCapabilityEntries(s.capabilityCatalog, nextCaps),
                scopedPromptEntries(s.promptCatalog, nextPrompts),
              ),
            }
          : {}),
      })
    },

    toggleBreakpoint(line) {
      const has = get().breakpoints.includes(line)
      const breakpoints = has
        ? get().breakpoints.filter((l) => l !== line)
        : [...get().breakpoints, line].sort((a, b) => a - b)
      set({ breakpoints })
      const runId = get().activeRunId
      if (runId && get().run && !get().run!.finishedAt) {
        ws?.send({ t: 'setBreakpoints', runId, lines: breakpoints })
      }
    },

    setSelectedAgent(id) {
      const s = get()
      const agents = s.agents
      const spec = agents.find((a) => a.id === id)
      const validation = validateWorkflow(
        s.source,
        id,
        installedAgentIds(agents),
        s.capabilityCatalog,
        s.promptCatalog,
      )
      set({
        selectedAgent: id,
        selectedMode: spec?.defaultModes.currentModeId ?? 'default',
        workflowDts: workflowDtsFor(
          agents,
          id,
          scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
          scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
        ),
        validation,
      })
    },
    setSelectedMode: (selectedMode) => set({ selectedMode }),
    setCwd: (cwd) => set({ cwd }),
    setArgsText: (argsText) => set({ argsText }),
    setStepMode: (stepMode) => set({ stepMode }),
    setManualApprovals: (manualApprovals) => set({ manualApprovals }),
    setMaxConcurrency: (maxConcurrency) => set({ maxConcurrency }),
    setMethodConfig: (method, key, value) => {
      const current = get().methodConfig
      set({ methodConfig: { ...current, [method]: { ...current[method], [key]: value } } })
    },
    clearMethodConfigField: (method, key) => {
      const current = get().methodConfig
      if (current[method]?.[key] === undefined) return
      const fields = { ...current[method] }
      delete fields[key]
      const next = { ...current }
      if (Object.keys(fields).length === 0) delete next[method]
      else next[method] = fields
      set({ methodConfig: next })
    },
    resetMethodConfig: (method) => {
      const next = { ...get().methodConfig }
      delete next[method]
      set({ methodConfig: next })
    },

    async refreshCapabilities() {
      try {
        const { capabilities } = await api.fetchCapabilities()
        const capabilityCatalog = buildCapabilityCatalog(capabilities)
        const s = get()
        const validation = validateWorkflow(
          s.source,
          s.selectedAgent,
          installedAgentIds(s.agents),
          capabilityCatalog,
          s.promptCatalog,
        )
        set({
          capabilities,
          capabilityCatalog,
          validation,
          workflowDts: workflowDtsFor(
            s.agents,
            s.selectedAgent,
            scopedCapabilityEntries(capabilityCatalog, validation.meta?.capabilities),
            scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
          ),
        })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async refreshPrompts() {
      try {
        const { prompts } = await api.fetchPrompts()
        const promptCatalog = buildPromptCatalog(prompts)
        const s = get()
        const validation = validateWorkflow(
          s.source,
          s.selectedAgent,
          installedAgentIds(s.agents),
          s.capabilityCatalog,
          promptCatalog,
        )
        set({
          prompts,
          promptCatalog,
          validation,
          workflowDts: workflowDtsFor(
            s.agents,
            s.selectedAgent,
            scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
            scopedPromptEntries(promptCatalog, validation.meta?.prompts),
          ),
        })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async refreshFiles() {
      try {
        set({ files: await api.fetchFiles() })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async openFile(name) {
      const { content } = await api.fetchFile(name)
      const s = get()
      const validation = validateWorkflow(
        content,
        s.selectedAgent,
        installedAgentIds(s.agents),
        s.capabilityCatalog,
        s.promptCatalog,
      )
      set({
        source: content,
        fileName: name,
        openKind: 'workflow',
        openTier: null,
        dirty: false,
        validation,
        workflowDts: workflowDtsFor(
          s.agents,
          s.selectedAgent,
          scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
          scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
        ),
        breakpoints: [],
      })
    },

    async openPrompt(tier, name) {
      const { content } = await api.fetchPromptFile(tier, name)
      // A .hbs prompt template is NOT a workflow: skip validation, dts injection,
      // and breakpoints. The HandlebarsPreview renders it against sample data.
      set({
        source: content,
        fileName: `${name}.hbs`,
        openKind: 'prompt',
        openTier: tier,
        dirty: false,
        breakpoints: [],
      })
    },

    async openTool(tier, fileName) {
      const { content } = await api.fetchToolFile(tier, fileName)
      // A tool/capability .ts module is NOT a workflow: open it as a plain
      // TypeScript buffer and gate off the workflow-only editor machinery.
      set({
        source: content,
        fileName,
        openKind: 'tool',
        openTier: tier,
        dirty: false,
        breakpoints: [],
      })
    },

    async saveCurrent(name) {
      const s = get()
      // Dispatch by what the editor currently holds so each kind saves to its
      // own backing route (workflows / prompts / tools), never the wrong one.
      if (s.openKind === 'prompt') {
        const fileName = name ?? s.fileName
        if (!fileName || !s.openTier) throw new Error('No prompt file')
        const bare = fileName.replace(/\.hbs$/, '')
        const info = await api.savePromptFile(s.openTier, bare, s.source)
        set({ dirty: false })
        await get().refreshPrompts()
        return { name: info.name }
      }
      if (s.openKind === 'tool') {
        const fileName = name ?? s.fileName
        if (!fileName || !s.openTier) throw new Error('No tool file')
        const info = await api.saveToolFile(s.openTier, fileName, s.source)
        set({ dirty: false })
        await get().refreshCapabilities()
        return { name: info.name }
      }
      const fileName = name ?? s.fileName
      if (!fileName) throw new Error('No file name')
      const info = await api.saveFile(fileName, s.source)
      set({ fileName: info.name, dirty: false })
      await get().refreshFiles()
      return info
    },

    async deleteFileByName(name) {
      await api.deleteFile(name)
      if (get().fileName === name) set({ fileName: null })
      await get().refreshFiles()
    },

    newFile() {
      const s = get()
      const validation = validateWorkflow(
        DEFAULT_WORKFLOW,
        s.selectedAgent,
        installedAgentIds(s.agents),
        s.capabilityCatalog,
        s.promptCatalog,
      )
      set({
        source: DEFAULT_WORKFLOW,
        fileName: null,
        openKind: 'workflow',
        openTier: null,
        dirty: false,
        validation,
        workflowDts: workflowDtsFor(
          s.agents,
          s.selectedAgent,
          scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
          scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
        ),
        breakpoints: [],
      })
    },

    startRun() {
      const s = get()
      const runId = nanoid()
      // Only send method overrides the user actually set (non-empty objects), so
      // an untouched UI never shadows the script's own meta.config.
      const methodConfig = Object.fromEntries(
        Object.entries(s.methodConfig).filter(([, v]) => v && Object.keys(v).length > 0),
      )
      const req: RunRequest = {
        runId,
        source: s.source,
        agent: s.selectedAgent,
        modeId: s.selectedMode,
        cwd: s.cwd || s.defaultCwd,
        args: parseArgs(s.argsText),
        breakpoints: s.breakpoints,
        stepMode: s.stepMode,
        manualApprovals: s.manualApprovals,
        maxConcurrency: s.maxConcurrency,
        methodConfig: Object.keys(methodConfig).length ? methodConfig : undefined,
      }
      currentRun = newSnapshot(req)
      set({ activeRunId: runId, run: currentRun, permission: null })
      ws?.send({ t: 'start', run: req })
    },

    cancelRun() {
      const runId = get().activeRunId
      if (runId) ws?.send({ t: 'cancel', runId })
    },
    resumeRun() {
      const runId = get().activeRunId
      if (runId) ws?.send({ t: 'resume', runId })
    },
    stepRun() {
      const runId = get().activeRunId
      if (runId) ws?.send({ t: 'step', runId })
    },

    respondPermission(response) {
      const { activeRunId, permission } = get()
      if (activeRunId && permission) {
        ws?.send({ t: 'permission', runId: activeRunId, requestId: permission.requestId, response })
        set({ permission: null })
      }
    },

    modesForUi() {
      const s = get()
      if (s.run?.modes) return s.run.modes
      const spec = s.agents.find((a) => a.id === s.selectedAgent)
      return spec?.defaultModes ?? { currentModeId: 'default', availableModes: [] }
    },

    onServerMessage(msg) {
      switch (msg.t) {
        case 'hello': {
          const s = get()
          const selectedAgent = s.selectedAgent
          const validation = validateWorkflow(
            s.source,
            selectedAgent,
            installedAgentIds(msg.agents),
            s.capabilityCatalog,
            s.promptCatalog,
          )
          set({
            agents: msg.agents,
            workflowDts: workflowDtsFor(
              msg.agents,
              selectedAgent,
              scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
              scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
            ),
            validation,
          })
          break
        }
        case 'snapshot':
          if (msg.snapshot.runId === get().activeRunId) {
            currentRun = msg.snapshot
            set({ run: currentRun })
          }
          break
        case 'event':
          if (currentRun && msg.runId === get().activeRunId) {
            // effect:* have no case in applyRunEvent — the store reduces them here.
            if (!reduceEffectEvent(currentRun, msg.event)) applyRunEvent(currentRun, msg.event)
            scheduleFlush()
          }
          break
        case 'permission':
          if (msg.runId === get().activeRunId) set({ permission: msg.req })
          break
        case 'permission:resolved':
          if (get().permission?.requestId === msg.requestId) set({ permission: null })
          break
        case 'error':
          set({ lastError: msg.message })
          break
        case 'pong':
          break
      }
    },
  }
})
