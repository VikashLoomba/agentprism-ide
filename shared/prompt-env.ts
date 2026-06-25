// shared/prompt-env.ts  (isomorphic — NO node:* imports; full Handlebars build for live compile)
import Handlebars from 'handlebars'
import type { Json } from './capability.ts'

export type PromptEnv = ReturnType<typeof Handlebars.create>

/** Compile options shared by server-render and client-preview (must be identical). */
export const PROMPT_COMPILE_OPTIONS: CompileOptions = {
  noEscape: true,   // prompts are plain text; never HTML-entity-encode & < > "
  strict: false,    // lenient: missing fields render empty (don't throw at author time)
}

/** Curated SAFE helper set. Every helper is PURE: no Date, no random, no IO, no console.
 *  This purity is what makes render deterministic across realms (inject-lens determinism). */
function registerSafeHelpers(env: PromptEnv): void {
  env.registerHelper('eq', (a: unknown, b: unknown) => a === b)
  env.registerHelper('ne', (a: unknown, b: unknown) => a !== b)
  env.registerHelper('not', (a: unknown) => !a)
  env.registerHelper('join', (arr: unknown, sep: unknown) =>
    Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ', ') : '')
  env.registerHelper('json', (v: unknown) => JSON.stringify(v, null, 2))
  env.registerHelper('lowercase', (s: unknown) => String(s ?? '').toLowerCase())
  env.registerHelper('uppercase', (s: unknown) => String(s ?? '').toUpperCase())
  env.registerHelper('trim', (s: unknown) => String(s ?? '').trim())
  env.registerHelper('default', (v: unknown, fallback: unknown) =>
    v === undefined || v === null || v === '' ? fallback : v)
}

/** Build a fresh configured environment. Helpers are registered; partials are
 *  added by the caller via registerPartial (full bodies — see render-parity below). */
export function createPromptEnv(): PromptEnv {
  const env = Handlebars.create()
  registerSafeHelpers(env)
  return env
}

/** Register one partial under its IDENTIFIER name so `{{> name}}` resolves unquoted.
 *  Body is the FULL template body (frontmatter-stripped) — never a truncated preview,
 *  so partial composition renders identically on server and client. */
export function registerPartial(env: PromptEnv, name: string, body: string): void {
  env.registerPartial(name, body)
}

/** Compile a body ONCE with PROMPT_COMPILE_OPTIONS and return the bound render
 *  delegate. This is the canonical compile path (R1): one parse per template, with
 *  the SAME options used at render time — a raw-string partial inherits the parent's
 *  compile options, so noEscape must be applied here for byte-identical output.
 *  Compile errors surface here (load-time), mirroring how capabilities bind once. */
export function compilePrompt(env: PromptEnv, body: string): (data: Json) => string {
  const tpl = env.compile(body, PROMPT_COMPILE_OPTIONS)
  return (data: Json) => tpl(data as Record<string, unknown>)
}

/** Compile a body in `env` and render it against `data`. Pure + synchronous.
 *  One-shot convenience; prefer compilePrompt when rendering the same body repeatedly. */
export function renderPrompt(env: PromptEnv, body: string, data: Json): string {
  return compilePrompt(env, body)(data)
}
