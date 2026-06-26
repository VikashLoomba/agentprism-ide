import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import type { AcpAgentId, AcpAgentSpec, SessionModeState } from '@shared/agents'
import type { RunEvent, RunSnapshot } from '@shared/events'
import type {
  CapabilityCatalogEntry,
  InputRequest,
  InputResponse,
  PermissionRequest,
  PermissionResponse,
  PromptCatalogEntry,
  RunRequest,
  ServerMessage,
  WorkflowFileInfo,
  WorkspaceInfo,
} from '@shared/protocol'
import type { WorkflowInputParam } from '@shared/dsl'
import { resolveCapability, type CapabilityCatalog } from '@shared/capability-resolve'
import { resolvePrompt, type PromptCatalog } from '@shared/prompt-resolve'
import { validateWorkflow, type ValidateResult } from '@shared/validate'
import { validateInputs } from '@shared/validate-inputs'
import { applyRunEvent } from './runReducer'
import * as api from '@/lib/api'
import { DEFAULT_WORKFLOW } from '@/lib/defaults'
import { buildWorkflowDts, INITIAL_WORKFLOW_DSL_DTS } from '@/lib/workflow-dts'
import { createWsClient, type WsClient, type WsStatus } from '@/lib/ws'

const ACTIVE_WS_KEY = 'agentprism.activeWorkspaceId'

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
  inputs?: WorkflowInputParam[],
): string {
  return buildWorkflowDts(
    agents.filter((a) => a.installed),
    defaultAgentId,
    capabilities,
    prompts,
    inputs,
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
 *  upserts into `run.agents` (keyed by id) and groups under its phase. */
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

/** Seed the input form values from each declared param's `default`. */
function seedInputValues(inputs: WorkflowInputParam[] | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const input of inputs ?? []) {
    if (input.default !== undefined) values[input.name] = input.default
  }
  return values
}

function inputStatePatch(
  nextInputs: WorkflowInputParam[] | undefined,
  prevInputs: WorkflowInputParam[] | undefined,
  currentValues: Record<string, unknown>,
): { inputValues: Record<string, unknown>; inputsValid: boolean } {
  const changed = JSON.stringify(prevInputs) !== JSON.stringify(nextInputs)
  const inputValues = changed ? seedInputValues(nextInputs) : currentValues
  return { inputValues, inputsValid: validateInputs(nextInputs, inputValues).ok }
}

// --- Per-workspace slot types -----------------------------------------------
type OpenKind = 'workflow' | 'prompt' | 'tool'
type OpenTier = 'project' | 'user' | null

interface CatalogSlot {
  capabilities: CapabilityCatalogEntry[]
  capabilityCatalog: CapabilityCatalog
  prompts: PromptCatalogEntry[]
  promptCatalog: PromptCatalog
}
interface RunSlot {
  activeRunId: string | null
  run: RunSnapshot | null
  permission: PermissionRequest | null
  input: InputRequest | null
}
interface EditorSlot {
  source: string
  fileName: string | null
  openKind: OpenKind
  openTier: OpenTier
  dirty: boolean
  breakpoints: number[]
  /** Per-workspace agent-cwd OVERRIDE ('' = use ws root). */
  cwd: string
}
type AttentionStatus = 'idle' | 'running' | 'needs-input' | 'error'

function emptyEditorSlot(): EditorSlot {
  return {
    source: DEFAULT_WORKFLOW,
    fileName: null,
    openKind: 'workflow',
    openTier: null,
    dirty: false,
    breakpoints: [],
    cwd: '',
  }
}
function emptyRunSlot(): RunSlot {
  return { activeRunId: null, run: null, permission: null, input: null }
}
const EMPTY_CATALOG: CapabilityCatalog = { project: {}, user: {} }
const EMPTY_PROMPT_CATALOG: PromptCatalog = { project: {}, user: {} }

interface State {
  agents: AcpAgentSpec[]
  defaultCwd: string
  wsStatus: WsStatus

  // --- Workspaces (single source of truth) ---
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string
  defaultWorkspaceId: string
  catalogByWs: Record<string, CatalogSlot>
  runByWs: Record<string, RunSlot>
  editorByWs: Record<string, EditorSlot>
  filesByWs: Record<string, WorkflowFileInfo[]>
  workspaceAttention: Record<string, { status: AttentionStatus; needsInputSince?: number }>

  /** Flat list of every available capability (both tiers) — mirror of active ws. */
  capabilities: CapabilityCatalogEntry[]
  capabilityCatalog: CapabilityCatalog
  prompts: PromptCatalogEntry[]
  promptCatalog: PromptCatalog

  openKind: OpenKind
  openTier: OpenTier

  source: string
  fileName: string | null
  dirty: boolean
  validation: ValidateResult
  workflowDts: string

  breakpoints: number[]

  selectedAgent: AcpAgentId
  selectedMode: string
  cwd: string
  argsText: string
  inputValues: Record<string, unknown>
  stepMode: boolean
  manualApprovals: boolean
  maxConcurrency: number
  methodConfig: Record<string, Record<string, unknown>>

  run: RunSnapshot | null
  activeRunId: string | null
  permission: PermissionRequest | null
  input: InputRequest | null
  inputsValid: boolean

  files: WorkflowFileInfo[]
  lastError: string | null

  init: () => Promise<void>
  setSource: (s: string) => void
  toggleBreakpoint: (line: number) => void
  setSelectedAgent: (id: AcpAgentId) => void
  setSelectedMode: (id: string) => void
  setCwd: (c: string) => void
  setArgsText: (s: string) => void
  setInputValue: (name: string, value: unknown) => void
  setStepMode: (b: boolean) => void
  setManualApprovals: (b: boolean) => void
  setMaxConcurrency: (n: number) => void
  setMethodConfig: (method: string, key: string, value: unknown) => void
  clearMethodConfigField: (method: string, key: string) => void
  resetMethodConfig: (method: string) => void

  // Workspaces
  setActiveWorkspace: (id: string) => Promise<void>
  refreshWorkspaces: () => Promise<void>
  openWorkspace: (root: string) => Promise<string>
  closeWorkspace: (id: string) => Promise<void>

  refreshCapabilities: () => Promise<void>
  refreshPrompts: () => Promise<void>
  refreshFiles: (id?: string) => Promise<void>
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
  respondInput: (response: InputResponse) => void

  modesForUi: () => SessionModeState
  onServerMessage: (msg: ServerMessage) => void
}

export const useStore = create<State>((set, get) => {
  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    requestAnimationFrame(() => {
      flushScheduled = false
      const s = get()
      const slot = s.runByWs[s.activeWorkspaceId]
      if (slot?.run) set({ run: { ...slot.run } })
    })
  }

  /** Recompute the derived attention status for one workspace from its run slot. */
  function recomputeAttention(id: string) {
    const s = get()
    const slot = s.runByWs[id]
    let status: AttentionStatus = 'idle'
    if (slot) {
      if (slot.permission || slot.input) status = 'needs-input'
      else if (slot.run?.status === 'failed') status = 'error'
      else if (slot.run?.status === 'running' || slot.run?.status === 'paused') status = 'running'
    }
    const prev = s.workspaceAttention[id]
    const needsInputSince = status === 'needs-input' ? prev?.needsInputSince ?? Date.now() : undefined
    set({ workspaceAttention: { ...s.workspaceAttention, [id]: { status, needsInputSince } } })
  }

  /** Copy runByWs[id] (seed if absent) into the top-level run mirror. */
  function setActiveRunMirror(id: string) {
    const s = get()
    const slot = s.runByWs[id] ?? emptyRunSlot()
    if (!s.runByWs[id]) set({ runByWs: { ...s.runByWs, [id]: slot } })
    set({ run: slot.run, activeRunId: slot.activeRunId, permission: slot.permission, input: slot.input })
  }

  /** Copy editorByWs[id] + filesByWs[id] (seed if absent) into the top-level mirror. */
  function setActiveEditorMirror(id: string) {
    const s = get()
    const slot = s.editorByWs[id] ?? emptyEditorSlot()
    if (!s.editorByWs[id]) set({ editorByWs: { ...s.editorByWs, [id]: slot } })
    const files = s.filesByWs[id] ?? []
    set({
      source: slot.source,
      fileName: slot.fileName,
      openKind: slot.openKind,
      openTier: slot.openTier,
      dirty: slot.dirty,
      breakpoints: slot.breakpoints,
      cwd: slot.cwd,
      files,
    })
  }

  /** Re-validate + rebuild workflowDts against catalogByWs[id], mirror to top-level. */
  function setActiveCatalogMirror(id: string) {
    const s = get()
    const cat = s.catalogByWs[id]
    if (!cat) return
    const validation = validateWorkflow(
      s.source,
      s.selectedAgent,
      installedAgentIds(s.agents),
      cat.capabilityCatalog,
      cat.promptCatalog,
    )
    set({
      capabilities: cat.capabilities,
      capabilityCatalog: cat.capabilityCatalog,
      prompts: cat.prompts,
      promptCatalog: cat.promptCatalog,
      validation,
      workflowDts: workflowDtsFor(
        s.agents,
        s.selectedAgent,
        scopedCapabilityEntries(cat.capabilityCatalog, validation.meta?.capabilities),
        scopedPromptEntries(cat.promptCatalog, validation.meta?.prompts),
        validation.meta?.inputs,
      ),
      ...inputStatePatch(validation.meta?.inputs, s.validation.meta?.inputs, s.inputValues),
    })
  }

  /** Fetch + store a workspace's catalogs; mirror when it is the active ws. */
  async function fetchCatalogsFor(id: string) {
    try {
      const [{ capabilities }, { prompts }] = await Promise.all([
        api.fetchCapabilities(id),
        api.fetchPrompts(id),
      ])
      const slot: CatalogSlot = {
        capabilities,
        capabilityCatalog: buildCapabilityCatalog(capabilities),
        prompts,
        promptCatalog: buildPromptCatalog(prompts),
      }
      set((s) => ({ catalogByWs: { ...s.catalogByWs, [id]: slot } }))
      if (id === get().activeWorkspaceId) setActiveCatalogMirror(id)
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Write a patch into the active workspace's editor slot AND the top-level mirror. */
  function writeEditor(patch: Partial<EditorSlot>) {
    const s = get()
    const id = s.activeWorkspaceId
    const slot = { ...(s.editorByWs[id] ?? emptyEditorSlot()), ...patch }
    set({ editorByWs: { ...s.editorByWs, [id]: slot }, ...patch })
  }

  return {
    agents: [],
    defaultCwd: '',
    wsStatus: 'connecting',

    workspaces: [],
    activeWorkspaceId: '',
    defaultWorkspaceId: '',
    catalogByWs: {},
    runByWs: {},
    editorByWs: {},
    filesByWs: {},
    workspaceAttention: {},

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
    inputValues: {},
    stepMode: false,
    manualApprovals: false,
    maxConcurrency: 8,
    methodConfig: {},

    run: null,
    activeRunId: null,
    permission: null,
    input: null,
    inputsValid: true,

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
        const [{ workspaces, defaultWorkspaceId }, { agents }] = await Promise.all([
          api.fetchWorkspaces(),
          api.fetchAgents(),
        ])
        const stored = localStorage.getItem(ACTIVE_WS_KEY)
        const activeWorkspaceId =
          stored && workspaces.some((w) => w.id === stored) ? stored : defaultWorkspaceId
        localStorage.setItem(ACTIVE_WS_KEY, activeWorkspaceId)
        const selected = agents.find((a) => a.installed) ?? agents[0]
        const selectedAgent = selected?.id ?? 'claude'
        const activeRoot = workspaces.find((w) => w.id === activeWorkspaceId)?.root ?? ''
        set((s) => ({
          agents,
          workspaces,
          defaultWorkspaceId,
          activeWorkspaceId,
          defaultCwd: activeRoot,
          selectedAgent,
          selectedMode: selected?.defaultModes.currentModeId ?? 'default',
          // Seed the active editor slot if absent.
          editorByWs: s.editorByWs[activeWorkspaceId]
            ? s.editorByWs
            : { ...s.editorByWs, [activeWorkspaceId]: emptyEditorSlot() },
        }))
        setActiveEditorMirror(activeWorkspaceId)
        await fetchCatalogsFor(activeWorkspaceId)
        await get().refreshFiles(activeWorkspaceId)
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
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
      const capsChanged = JSON.stringify(prevCaps) !== JSON.stringify(nextCaps)
      const promptsChanged = JSON.stringify(prevPrompts) !== JSON.stringify(nextPrompts)
      writeEditor({ source, dirty: true })
      set({
        validation,
        ...inputStatePatch(validation.meta?.inputs, s.validation.meta?.inputs, s.inputValues),
        ...(capsChanged || promptsChanged
          ? {
              workflowDts: workflowDtsFor(
                s.agents,
                s.selectedAgent,
                scopedCapabilityEntries(s.capabilityCatalog, nextCaps),
                scopedPromptEntries(s.promptCatalog, nextPrompts),
                validation.meta?.inputs,
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
      writeEditor({ breakpoints })
      const s = get()
      const runId = s.activeRunId
      if (runId && s.run && !s.run.finishedAt) {
        ws?.send({ t: 'setBreakpoints', workspaceId: s.activeWorkspaceId, runId, lines: breakpoints })
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
          validation.meta?.inputs,
        ),
        validation,
        ...inputStatePatch(validation.meta?.inputs, s.validation.meta?.inputs, s.inputValues),
      })
    },
    setSelectedMode: (selectedMode) => set({ selectedMode }),
    setCwd: (cwd) => writeEditor({ cwd }),
    setArgsText: (argsText) => set({ argsText }),
    setInputValue: (name, value) => {
      const s = get()
      const inputValues = { ...s.inputValues, [name]: value }
      set({ inputValues, inputsValid: validateInputs(s.validation.meta?.inputs, inputValues).ok })
    },
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

    // --- Workspaces ---------------------------------------------------------
    async setActiveWorkspace(id) {
      const prevId = get().activeWorkspaceId
      if (id === prevId) return
      // 1. SNAPSHOT the outgoing buffer back into editorByWs[prevId].
      if (prevId) {
        const s0 = get()
        const outgoing: EditorSlot = {
          source: s0.source,
          fileName: s0.fileName,
          openKind: s0.openKind,
          openTier: s0.openTier,
          dirty: s0.dirty,
          breakpoints: s0.breakpoints,
          cwd: s0.cwd,
        }
        set({ editorByWs: { ...s0.editorByWs, [prevId]: outgoing } })
      }
      // 2. persist + 3. set active
      localStorage.setItem(ACTIVE_WS_KEY, id)
      set({ activeWorkspaceId: id })
      // 4. repoint run mirror (foregrounds a backgrounded blocked request).
      setActiveRunMirror(id)
      recomputeAttention(id)
      // 5. repoint editor mirror + defaultCwd to the target ws root.
      setActiveEditorMirror(id)
      const target = get().workspaces.find((w) => w.id === id)
      if (target) set({ defaultCwd: target.root })
      // 6. refresh files (tree now shows id).
      await get().refreshFiles(id)
      // 7. catalogs (lazy populate, else re-mirror).
      if (!get().catalogByWs[id]) await fetchCatalogsFor(id)
      else setActiveCatalogMirror(id)
    },

    async refreshWorkspaces() {
      try {
        const { workspaces, defaultWorkspaceId } = await api.fetchWorkspaces()
        set({ workspaces, defaultWorkspaceId })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async openWorkspace(root) {
      const info = await api.openWorkspace(root)
      set((s) => ({
        workspaces: s.workspaces.some((w) => w.id === info.id)
          ? s.workspaces.map((w) => (w.id === info.id ? info : w))
          : [...s.workspaces, info],
      }))
      return info.id
    },

    async closeWorkspace(id) {
      const s = get()
      // 0. LAST-WORKSPACE GUARD (mirrors the server 409).
      if (s.workspaces.length <= 1) {
        set({ lastError: 'Cannot close the last open workspace' })
        return
      }
      // 1. If closing the ACTIVE ws, switch away FIRST.
      if (id === s.activeWorkspaceId) {
        const target =
          s.defaultWorkspaceId && s.defaultWorkspaceId !== id
            ? s.defaultWorkspaceId
            : s.workspaces.find((w) => w.id !== id)!.id
        await get().setActiveWorkspace(target)
      }
      // 2. Server close (throws on non-2xx — step 3 never runs on that path).
      await api.closeWorkspace(id)
      // 3. Drop the closed ws's per-workspace slots + list entry.
      set((s2) => {
        const { [id]: _r, ...runByWs } = s2.runByWs
        const { [id]: _c, ...catalogByWs } = s2.catalogByWs
        const { [id]: _e, ...editorByWs } = s2.editorByWs
        const { [id]: _f, ...filesByWs } = s2.filesByWs
        const { [id]: _a, ...workspaceAttention } = s2.workspaceAttention
        void _r
        void _c
        void _e
        void _f
        void _a
        const workspaces = s2.workspaces.filter((w) => w.id !== id)
        const defaultWorkspaceId =
          s2.defaultWorkspaceId === id ? workspaces[0]?.id ?? '' : s2.defaultWorkspaceId
        return { runByWs, catalogByWs, editorByWs, filesByWs, workspaceAttention, workspaces, defaultWorkspaceId }
      })
    },

    async refreshCapabilities() {
      const id = get().activeWorkspaceId
      try {
        const { capabilities } = await api.fetchCapabilities(id)
        const capabilityCatalog = buildCapabilityCatalog(capabilities)
        set((s) => {
          const existing = s.catalogByWs[id]
          const slot: CatalogSlot = {
            capabilities,
            capabilityCatalog,
            prompts: existing?.prompts ?? [],
            promptCatalog: existing?.promptCatalog ?? EMPTY_PROMPT_CATALOG,
          }
          return { catalogByWs: { ...s.catalogByWs, [id]: slot } }
        })
        if (id === get().activeWorkspaceId) setActiveCatalogMirror(id)
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async refreshPrompts() {
      const id = get().activeWorkspaceId
      try {
        const { prompts } = await api.fetchPrompts(id)
        const promptCatalog = buildPromptCatalog(prompts)
        set((s) => {
          const existing = s.catalogByWs[id]
          const slot: CatalogSlot = {
            capabilities: existing?.capabilities ?? [],
            capabilityCatalog: existing?.capabilityCatalog ?? EMPTY_CATALOG,
            prompts,
            promptCatalog,
          }
          return { catalogByWs: { ...s.catalogByWs, [id]: slot } }
        })
        if (id === get().activeWorkspaceId) setActiveCatalogMirror(id)
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async refreshFiles(id) {
      const wsId = id ?? get().activeWorkspaceId
      if (!wsId) return
      try {
        const files = await api.fetchFiles(wsId)
        set((s) => ({ filesByWs: { ...s.filesByWs, [wsId]: files } }))
        if (wsId === get().activeWorkspaceId) set({ files })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    async openFile(name) {
      const id = get().activeWorkspaceId
      const { content } = await api.fetchFile(id, name)
      const s = get()
      const validation = validateWorkflow(
        content,
        s.selectedAgent,
        installedAgentIds(s.agents),
        s.capabilityCatalog,
        s.promptCatalog,
      )
      writeEditor({
        source: content,
        fileName: name,
        openKind: 'workflow',
        openTier: null,
        dirty: false,
        breakpoints: [],
      })
      set({
        validation,
        workflowDts: workflowDtsFor(
          s.agents,
          s.selectedAgent,
          scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
          scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
          validation.meta?.inputs,
        ),
        ...inputStatePatch(validation.meta?.inputs, s.validation.meta?.inputs, s.inputValues),
      })
    },

    async openPrompt(tier, name) {
      const id = get().activeWorkspaceId
      const { content } = await api.fetchPromptFile(id, tier, name)
      writeEditor({
        source: content,
        fileName: `${name}.hbs`,
        openKind: 'prompt',
        openTier: tier,
        dirty: false,
        breakpoints: [],
      })
    },

    async openTool(tier, fileName) {
      const id = get().activeWorkspaceId
      const { content } = await api.fetchToolFile(id, tier, fileName)
      writeEditor({
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
      const id = s.activeWorkspaceId
      if (s.openKind === 'prompt') {
        const fileName = name ?? s.fileName
        if (!fileName || !s.openTier) throw new Error('No prompt file')
        const bare = fileName.replace(/\.hbs$/, '')
        const info = await api.savePromptFile(id, s.openTier, bare, s.source)
        writeEditor({ dirty: false })
        await get().refreshPrompts()
        return { name: info.name }
      }
      if (s.openKind === 'tool') {
        const fileName = name ?? s.fileName
        if (!fileName || !s.openTier) throw new Error('No tool file')
        const info = await api.saveToolFile(id, s.openTier, fileName, s.source)
        writeEditor({ dirty: false })
        await get().refreshCapabilities()
        return { name: info.name }
      }
      const fileName = name ?? s.fileName
      if (!fileName) throw new Error('No file name')
      const info = await api.saveFile(id, fileName, s.source)
      writeEditor({ fileName: info.name, dirty: false })
      await get().refreshFiles(id)
      return info
    },

    async deleteFileByName(name) {
      const id = get().activeWorkspaceId
      await api.deleteFile(id, name)
      if (get().fileName === name) writeEditor({ fileName: null })
      await get().refreshFiles(id)
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
      writeEditor({
        source: DEFAULT_WORKFLOW,
        fileName: null,
        openKind: 'workflow',
        openTier: null,
        dirty: false,
        breakpoints: [],
      })
      set({
        validation,
        workflowDts: workflowDtsFor(
          s.agents,
          s.selectedAgent,
          scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
          scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
          validation.meta?.inputs,
        ),
        ...inputStatePatch(validation.meta?.inputs, s.validation.meta?.inputs, s.inputValues),
      })
    },

    startRun() {
      const s = get()
      const id = s.activeWorkspaceId
      const runId = nanoid()
      const methodConfig = Object.fromEntries(
        Object.entries(s.methodConfig).filter(([, v]) => v && Object.keys(v).length > 0),
      )
      const declaredInputs = s.validation.meta?.inputs
      const args =
        declaredInputs && declaredInputs.length > 0 ? s.inputValues : parseArgs(s.argsText)
      const req: RunRequest = {
        runId,
        source: s.source,
        agent: s.selectedAgent,
        modeId: s.selectedMode,
        cwd: s.cwd || s.defaultCwd,
        workspaceId: id,
        args,
        breakpoints: s.breakpoints,
        stepMode: s.stepMode,
        manualApprovals: s.manualApprovals,
        maxConcurrency: s.maxConcurrency,
        methodConfig: Object.keys(methodConfig).length ? methodConfig : undefined,
      }
      const slot: RunSlot = { activeRunId: runId, run: newSnapshot(req), permission: null, input: null }
      set((st) => ({
        runByWs: { ...st.runByWs, [id]: slot },
        run: slot.run,
        activeRunId: runId,
        permission: null,
        input: null,
      }))
      recomputeAttention(id)
      ws?.send({ t: 'start', workspaceId: id, run: req })
    },

    cancelRun() {
      const s = get()
      const runId = s.activeRunId
      if (runId) ws?.send({ t: 'cancel', workspaceId: s.activeWorkspaceId, runId })
    },
    resumeRun() {
      const s = get()
      const runId = s.activeRunId
      if (runId) ws?.send({ t: 'resume', workspaceId: s.activeWorkspaceId, runId })
    },
    stepRun() {
      const s = get()
      const runId = s.activeRunId
      if (runId) ws?.send({ t: 'step', workspaceId: s.activeWorkspaceId, runId })
    },

    respondPermission(response) {
      const s = get()
      const { activeRunId, permission, activeWorkspaceId } = s
      if (activeRunId && permission) {
        ws?.send({ t: 'permission', workspaceId: activeWorkspaceId, runId: activeRunId, requestId: permission.requestId, response })
        const slot = s.runByWs[activeWorkspaceId]
        if (slot) slot.permission = null
        set({ permission: null })
        recomputeAttention(activeWorkspaceId)
      }
    },

    respondInput(response) {
      const s = get()
      const { activeRunId, input, activeWorkspaceId } = s
      if (activeRunId && input) {
        ws?.send({ t: 'input', workspaceId: activeWorkspaceId, runId: activeRunId, requestId: input.requestId, response })
        const slot = s.runByWs[activeWorkspaceId]
        if (slot) slot.input = null
        set({ input: null })
        recomputeAttention(activeWorkspaceId)
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
          const activeStillValid = msg.workspaces.some((w) => w.id === s.activeWorkspaceId)
          set({
            agents: msg.agents,
            workspaces: msg.workspaces,
            defaultWorkspaceId: msg.defaultWorkspaceId,
            workflowDts: workflowDtsFor(
              msg.agents,
              selectedAgent,
              scopedCapabilityEntries(s.capabilityCatalog, validation.meta?.capabilities),
              scopedPromptEntries(s.promptCatalog, validation.meta?.prompts),
              validation.meta?.inputs,
            ),
            validation,
            ...inputStatePatch(validation.meta?.inputs, s.validation.meta?.inputs, s.inputValues),
          })
          // Active ws vanished across a reconnect (e.g. a pruned persisted root that was
          // active): repoint to the new default and refetch its catalogs/files. `set` above
          // left `activeWorkspaceId` unchanged, so setActiveWorkspace sees a real prev→next
          // delta (it early‑returns only when prev === next).
          //
          // Gate on an already-established active id: an empty `activeWorkspaceId` is not a
          // vanished workspace, it is the pre-init state. On first page load `hello` can race
          // ahead of `init()`'s localStorage hydration (the WS connects synchronously, before
          // init's awaited HTTP fetch resolves), so reconciling an empty active here would
          // clobber the user's persisted selection with the default. Leave the uninitialized
          // case for init() to own.
          if (s.activeWorkspaceId && !activeStillValid && msg.defaultWorkspaceId) {
            void get().setActiveWorkspace(msg.defaultWorkspaceId)
          }
          break
        }
        case 'snapshot': {
          const s = get()
          const slot = s.runByWs[msg.workspaceId]
          if (!slot) return
          if (msg.snapshot.runId === slot.activeRunId) {
            slot.run = msg.snapshot
            if (msg.workspaceId === s.activeWorkspaceId) set({ run: msg.snapshot })
          }
          recomputeAttention(msg.workspaceId)
          break
        }
        case 'event': {
          const s = get()
          const slot = s.runByWs[msg.workspaceId]
          if (!slot) return
          if (slot.run && msg.runId === slot.activeRunId) {
            if (!reduceEffectEvent(slot.run, msg.event)) applyRunEvent(slot.run, msg.event)
            if (msg.workspaceId === s.activeWorkspaceId) scheduleFlush()
          }
          recomputeAttention(msg.workspaceId)
          break
        }
        case 'permission': {
          const s = get()
          const slot = s.runByWs[msg.workspaceId]
          if (!slot) return
          if (msg.runId === slot.activeRunId) {
            slot.permission = msg.req
            if (msg.workspaceId === s.activeWorkspaceId) {
              set({ permission: msg.req })
            } else {
              const name = s.workspaces.find((w) => w.id === msg.workspaceId)?.name ?? msg.workspaceId
              toast(`Workspace ${name} needs input`, {
                action: { label: 'Switch', onClick: () => void get().setActiveWorkspace(msg.workspaceId) },
              })
            }
          }
          recomputeAttention(msg.workspaceId)
          break
        }
        case 'input': {
          const s = get()
          const slot = s.runByWs[msg.workspaceId]
          if (!slot) return
          if (msg.runId === slot.activeRunId) {
            slot.input = msg.req
            if (msg.workspaceId === s.activeWorkspaceId) {
              set({ input: msg.req })
            } else {
              const name = s.workspaces.find((w) => w.id === msg.workspaceId)?.name ?? msg.workspaceId
              toast(`Workspace ${name} needs input`, {
                action: { label: 'Switch', onClick: () => void get().setActiveWorkspace(msg.workspaceId) },
              })
            }
          }
          recomputeAttention(msg.workspaceId)
          break
        }
        case 'permission:resolved': {
          const s = get()
          const slot = s.runByWs[msg.workspaceId]
          if (!slot) return
          if (slot.permission?.requestId === msg.requestId) {
            slot.permission = null
            if (msg.workspaceId === s.activeWorkspaceId) set({ permission: null })
          }
          recomputeAttention(msg.workspaceId)
          break
        }
        case 'input:resolved': {
          const s = get()
          const slot = s.runByWs[msg.workspaceId]
          if (!slot) return
          if (slot.input?.requestId === msg.requestId) {
            slot.input = null
            if (msg.workspaceId === s.activeWorkspaceId) set({ input: null })
          }
          recomputeAttention(msg.workspaceId)
          break
        }
        case 'error':
          set({ lastError: msg.message })
          if (msg.workspaceId && get().runByWs[msg.workspaceId]) recomputeAttention(msg.workspaceId)
          break
        case 'pong':
          break
      }
    },
  }
})
