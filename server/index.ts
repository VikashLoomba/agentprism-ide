// server/index.ts
//
// The IDE backend entry point: build the single runtime, wrap it in the HTTP/WS
// server adapter, and listen. All behavior lives in the runtime + factory — this
// file is just the composition root.
import { createRuntime } from '../runtime/index.ts'
import { createServer } from './factory.ts'
import { PORT } from './config.ts'

const runtime = createRuntime()
const { listen } = createServer(runtime)

// listen() prints the startup banner (port, WS url, default work dir, installed
// agents) once the socket is bound.
listen(PORT)
