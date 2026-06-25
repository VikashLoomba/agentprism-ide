import { parse } from 'acorn'
import type { Node } from 'acorn'

/** Unique vm filename so we can recognise the workflow's frames in stack traces. */
export const WORKFLOW_FILENAME = 'agentprism-workflow.js'

/**
 * Determinism prelude run inside the vm realm before the user body — neuters
 * Math.random / Date.now / new Date() exactly like pi-dynamic-workflows so that
 * scripts behave the same here as they would in the reference runtime.
 */
export const DETERMINISM_PRELUDE = `"use strict";
Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (pass randomness via args or vary by index)"); };
{
  const RealDate = Date;
  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (pass a timestamp via args)"); };
  const SafeDate = function (...a) {
    if (!new.target) fail("Date()");
    if (a.length === 0) fail("new Date()");
    return Reflect.construct(RealDate, a, SafeDate);
  };
  SafeDate.UTC = RealDate.UTC;
  SafeDate.parse = RealDate.parse;
  SafeDate.now = () => fail("Date.now()");
  SafeDate.prototype = RealDate.prototype;
  globalThis.Date = SafeDate;
}`

const WRAP_OPEN = '(async () => {\n'
const WRAP_CLOSE = '\n})()'

export interface InstrumentResult {
  /** The full wrapped source to execute in the vm. */
  code: string
  /** Number of header lines before body line 1 — to map stack lines to source. */
  headerLines: number
}

/**
 * Prepare a workflow script for execution.
 *
 * The `export` keyword of the leading `export const meta = {...}` is blanked
 * (replaced with spaces) rather than removed, so `meta` becomes an unused local
 * const and **every other line/column is preserved**. That lets us map V8
 * stack-trace lines straight back to the user's source for breakpoints.
 */
export function instrumentWorkflow(normalizedSource: string): InstrumentResult {
  let src = normalizedSource
  try {
    const ast = parse(normalizedSource, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: Node[] }
    const first = ast.body[0] as unknown as { type: string; start: number } | undefined
    if (first && first.type === 'ExportNamedDeclaration') {
      const start = first.start
      // Blank exactly the "export" keyword (6 chars).
      if (normalizedSource.slice(start, start + 6) === 'export') {
        src = normalizedSource.slice(0, start) + '      ' + normalizedSource.slice(start + 6)
      }
    }
  } catch {
    // Validation runs before instrumentation; if parsing fails here we just run
    // the raw source and let the vm surface the error.
  }

  const header = `${DETERMINISM_PRELUDE}\n${WRAP_OPEN}`
  const headerLines = (header.match(/\n/g) ?? []).length
  const code = `${header}${src}${WRAP_CLOSE}`
  return { code, headerLines }
}

/** Parse a V8 stack trace and return the source line of the nearest workflow frame. */
export function sourceLineFromStack(stack: string | undefined, headerLines: number): number | undefined {
  if (!stack) return undefined
  const re = new RegExp(`${WORKFLOW_FILENAME.replace('.', '\\.')}:(\\d+):(\\d+)`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(stack)) !== null) {
    const codeLine = Number(match[1])
    const sourceLine = codeLine - headerLines
    if (sourceLine >= 1) return sourceLine
  }
  return undefined
}
