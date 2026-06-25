import type { MethodFactory } from './index.ts'

/**
 * Identity at runtime — returns the schema unchanged. It exists only so authors
 * can wrap a schema literal (`const S = jsonSchema({...})`) and have
 * agent({ schema: S }) infer a typed result. All the value is in the .d.ts
 * generic (see shared/dsl-registry.ts); at runtime there is nothing to do.
 */
export const jsonSchema: MethodFactory = () => (schema: unknown) => schema
