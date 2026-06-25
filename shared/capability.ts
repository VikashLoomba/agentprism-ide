// shared/capability.ts  (isomorphic — NO node:* imports)

/** Anything JSON-serializable. Effect args + results MUST satisfy this
 *  (same constraint as agent() schema results — they are snapshotted/emitted). */
export type Json =
  | null | boolean | number | string
  | Json[]
  | { [k: string]: Json }

/** Host-injected context handed to every effect fn in the TRUSTED realm. */
export interface CapabilityContext {
  /** Resolved secret VALUES, keyed by the capability's declared secret names.
   *  Present only for declared names; missing/blank => undefined. Never crosses
   *  into the sandbox — the workflow body sees only (args)=>Promise<result>. */
  readonly secrets: Readonly<Record<string, string | undefined>>
  /** Structured host logger (writes to the run's acp log, redaction-safe). */
  log: (message: string, data?: Json) => void
}

/** One effect, as written by the capability author. */
export type EffectFn<A extends Json = Json, R extends Json = Json> =
  (ctx: CapabilityContext, args: A) => Promise<R> | R

/** A capability definition (the default export of a tools/<name>.ts module). */
export interface Capability {
  /** Namespace global injected into the sandbox, e.g. "jira" -> global `jira`. */
  name: string
  /** Names (NOT values) of secrets this capability needs from the host env. */
  secrets: string[]
  /** Effect functions, keyed by method name -> jira.getTicket etc. */
  effects: Record<string, EffectFn>
}

/** Identity helper that preserves inference and validates shape at author time.
 *  Pure: callable in either realm; the HOST imports the module for real. */
export function defineCapability<E extends Record<string, EffectFn>>(
  cap: { name: string; secrets: string[]; effects: E },
): { name: string; secrets: string[]; effects: E } {
  if (!cap.name || !/^[A-Za-z_$][\w$]*$/.test(cap.name)) {
    throw new Error(`defineCapability: invalid namespace name "${cap.name}"`)
  }
  if (!cap.effects || Object.keys(cap.effects).length === 0) {
    throw new Error(`defineCapability("${cap.name}"): at least one effect required`)
  }
  return cap
}
