// server/config.ts
//
// Thin server-tier config. All path/anchor resolution now lives in
// runtime/paths.ts (the runtime is the only layer that resolves filesystem
// paths). This module exposes ONLY the HTTP PORT plus a re-export of the two
// PACKAGE_ROOT anchors the server adapter legitimately needs: PACKAGE_ROOT for
// the static-dist serve and resolveAgentBin (kept for back-compat import sites).
export const PORT = Number(process.env.PORT ?? 8787)

export { PACKAGE_ROOT, resolveAgentBin } from '../runtime/paths.ts'
