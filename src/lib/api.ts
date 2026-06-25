import type { AgentsResponse, WorkflowFileContent, WorkflowFileInfo } from '@shared/protocol'

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
