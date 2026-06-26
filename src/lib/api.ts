import type {
  AgentsResponse,
  CapabilitiesResponse,
  PromptsResponse,
  ToolSourcesResponse,
  ToolTypesResponse,
  WorkflowFileContent,
  WorkflowFileInfo,
  WorkspaceInfo,
  WorkspacesResponse,
} from '@shared/protocol'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

/** Base path for a workspace's scoped resources. */
function wsBase(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}`
}

export function fetchAgents(): Promise<AgentsResponse> {
  return fetch('/api/agents').then((r) => json<AgentsResponse>(r))
}

// --- Workspace registry -----------------------------------------------------
export function fetchWorkspaces(): Promise<WorkspacesResponse> {
  return fetch('/api/workspaces').then((r) => json<WorkspacesResponse>(r))
}

export function openWorkspace(root: string): Promise<WorkspaceInfo> {
  return fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  }).then((r) => json<WorkspaceInfo>(r))
}

export function closeWorkspace(id: string): Promise<{ ok: boolean }> {
  return fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
    json<{ ok: boolean }>(r),
  )
}

// --- Workspace-scoped resources --------------------------------------------
export function fetchCapabilities(workspaceId: string): Promise<CapabilitiesResponse> {
  return fetch(`${wsBase(workspaceId)}/capabilities`).then((r) => json<CapabilitiesResponse>(r))
}

export function fetchPrompts(workspaceId: string): Promise<PromptsResponse> {
  return fetch(`${wsBase(workspaceId)}/prompts`).then((r) => json<PromptsResponse>(r))
}

export function fetchPromptFile(
  workspaceId: string,
  tier: 'project' | 'user',
  name: string,
): Promise<{ name: string; content: string }> {
  return fetch(`${wsBase(workspaceId)}/prompts/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`).then((r) =>
    json<{ name: string; content: string }>(r),
  )
}

export function savePromptFile(
  workspaceId: string,
  tier: 'project' | 'user',
  name: string,
  content: string,
): Promise<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }> {
  return fetch(`${wsBase(workspaceId)}/prompts/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((r) =>
    json<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }>(r),
  )
}

// Tool (capability) files — `name` is the full basename incl. extension (e.g. "jira.ts").
export function fetchToolFile(
  workspaceId: string,
  tier: 'project' | 'user',
  name: string,
): Promise<{ name: string; content: string }> {
  return fetch(`${wsBase(workspaceId)}/tools/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`).then((r) =>
    json<{ name: string; content: string }>(r),
  )
}

export function saveToolFile(
  workspaceId: string,
  tier: 'project' | 'user',
  name: string,
  content: string,
): Promise<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }> {
  return fetch(`${wsBase(workspaceId)}/tools/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((r) =>
    json<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }>(r),
  )
}

// Every tool source file — loaded into the editor's virtual fs so sibling imports
// in a tool .ts buffer resolve (the runtime already loads them via `await import()`).
export function fetchToolSources(workspaceId: string): Promise<ToolSourcesResponse> {
  return fetch(`${wsBase(workspaceId)}/tool-sources`).then((r) => json<ToolSourcesResponse>(r))
}

// The .d.ts graph for npm specifiers Monaco reported unresolved (cannot-find-module).
export function fetchToolTypes(workspaceId: string, specifiers: string[]): Promise<ToolTypesResponse> {
  return fetch(`${wsBase(workspaceId)}/tool-types`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ specifiers }),
  }).then((r) => json<ToolTypesResponse>(r))
}

export function fetchFiles(workspaceId: string): Promise<WorkflowFileInfo[]> {
  return fetch(`${wsBase(workspaceId)}/workflows`).then((r) => json<WorkflowFileInfo[]>(r))
}

export function fetchFile(workspaceId: string, name: string): Promise<WorkflowFileContent> {
  return fetch(`${wsBase(workspaceId)}/workflows/${encodeURIComponent(name)}`).then((r) =>
    json<WorkflowFileContent>(r),
  )
}

export function saveFile(workspaceId: string, name: string, content: string): Promise<WorkflowFileInfo> {
  return fetch(`${wsBase(workspaceId)}/workflows/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((r) => json<WorkflowFileInfo>(r))
}

export function deleteFile(workspaceId: string, name: string): Promise<{ ok: boolean }> {
  return fetch(`${wsBase(workspaceId)}/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    json<{ ok: boolean }>(r),
  )
}
