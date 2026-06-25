// runtime/resolve.ts
//
// Resolve a WorkflowRef to a raw workflow script source. An inline {source}
// passes through untouched; a saved {name} is read from the workflows store
// (the engine only ever reads RunRequest.source). This is the single seam the
// runtime uses to turn either form of reference into the string the engine runs.
import { readWorkflow } from '../server/store/workflows.ts'

/** A reference to a workflow: an inline script source OR a saved workflow name. */
export type WorkflowRef = { source: string } | { name: string }

/**
 * Resolve a {@link WorkflowRef} to its raw script source. Inline `{ source }`
 * refs return the string as-is; `{ name }` refs are loaded from the workflows
 * directory via `readWorkflow` (throws if the file is missing/invalid).
 */
export async function resolveWorkflow(ref: WorkflowRef): Promise<string> {
  if ('source' in ref) return ref.source
  return readWorkflow(ref.name)
}
