import type {
  AgentsResponse,
  CapabilitiesResponse,
  PromptsResponse,
  WorkflowFileContent,
  WorkflowFileInfo,
} from '@shared/protocol'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export function fetchAgents(): Promise<AgentsResponse> {
  return fetch('/api/agents').then((r) => json<AgentsResponse>(r))
}

export function fetchCapabilities(): Promise<CapabilitiesResponse> {
  return fetch('/api/capabilities').then((r) => json<CapabilitiesResponse>(r))
}

export function fetchPrompts(): Promise<PromptsResponse> {
  return fetch('/api/prompts').then((r) => json<PromptsResponse>(r))
}

export function fetchPromptFile(
  tier: 'project' | 'user',
  name: string,
): Promise<{ name: string; content: string }> {
  return fetch(`/api/prompts/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`).then((r) =>
    json<{ name: string; content: string }>(r),
  )
}

export function savePromptFile(
  tier: 'project' | 'user',
  name: string,
  content: string,
): Promise<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }> {
  return fetch(`/api/prompts/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((r) =>
    json<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }>(r),
  )
}

// Tool (capability) files — `name` is the full basename incl. extension (e.g. "jira.ts").
export function fetchToolFile(
  tier: 'project' | 'user',
  name: string,
): Promise<{ name: string; content: string }> {
  return fetch(`/api/tools/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`).then((r) =>
    json<{ name: string; content: string }>(r),
  )
}

export function saveToolFile(
  tier: 'project' | 'user',
  name: string,
  content: string,
): Promise<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }> {
  return fetch(`/api/tools/${encodeURIComponent(tier)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((r) =>
    json<{ name: string; path: string; tier: 'project' | 'user'; modifiedAt: number }>(r),
  )
}

export function fetchFiles(): Promise<WorkflowFileInfo[]> {
  return fetch('/api/workflows').then((r) => json<WorkflowFileInfo[]>(r))
}

export function fetchFile(name: string): Promise<WorkflowFileContent> {
  return fetch(`/api/workflows/${encodeURIComponent(name)}`).then((r) => json<WorkflowFileContent>(r))
}

export function saveFile(name: string, content: string): Promise<WorkflowFileInfo> {
  return fetch(`/api/workflows/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((r) => json<WorkflowFileInfo>(r))
}

export function deleteFile(name: string): Promise<{ ok: boolean }> {
  return fetch(`/api/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    json<{ ok: boolean }>(r),
  )
}
