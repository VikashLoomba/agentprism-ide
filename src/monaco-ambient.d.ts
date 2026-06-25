// monaco-editor ships deep ESM subpaths (e.g. the basic-languages contributions)
// that its package.json `exports` map does not expose to TypeScript's module
// resolution, even though the bundler (Vite) resolves and loads them fine at
// build/run time. Declare the side-effect modules we import so tsc is satisfied.
declare module 'monaco-editor/esm/vs/basic-languages/handlebars/handlebars.contribution'

// Vite `?raw` imports resolve to the file's text content as a string. We use one
// to feed shared/capability.ts's real source to the Monaco TS service as a
// virtual lib (see monaco-setup.ts), so tool files type-check their import.
declare module '*?raw' {
  const content: string
  export default content
}
