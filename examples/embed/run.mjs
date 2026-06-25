// examples/embed/run.mjs
//
// A minimal host that embeds the AgentPrism runtime. It runs a tiny INLINE
// workflow programmatically — receiving the full event stream and answering the
// mid-run interaction round-trips (permission approvals + human-in-the-loop
// input) with plain JS handlers. No IDE, no WebSocket: just `import` and run.
//
// Run it with:  node examples/embed/run.mjs
// (Requires an authenticated Claude/Codex agent and the secrets the workflow's
//  capabilities need — all read from your environment, never from this file.)
import { createRuntime } from 'agentprism'

// A typed-input workflow declared entirely inline. The first statement MUST be a
// literal `export const meta = {…}`. `meta.inputs` makes `args` typed + validated
// before the run starts; `checkpoint()` is a real human-in-the-loop input that is
// surfaced to our `onInput` handler below.
const source = `
export const meta = {
  name: 'embed_demo',
  description: 'A tiny embeddable-runtime demo with a typed input and a checkpoint.',
  inputs: [
    { name: 'topic', type: 'string', required: true, description: 'What to summarize' },
    { name: 'maxWords', type: 'number', default: 80 },
  ],
}

phase('Confirm')
// checkpoint() parks the run until the host answers (onInput / respond()).
const go = await checkpoint('Proceed with the summary?', { kind: 'confirm', default: true })
if (!go) return 'cancelled by host'

phase('Summarize')
return await agent('In ' + args.maxWords + ' words or fewer, summarize: ' + args.topic)
`

async function main() {
  const runtime = createRuntime({
    // cwd defaults to AGENTPRISM_DEFAULT_CWD / process.cwd(); env defaults to
    // process.env — the ONLY source of capability secrets (never the wire).
    cwd: process.cwd(),
    env: process.env,
  })

  const handle = runtime.run(
    { source },                       // inline script — or { name: 'saved_workflow' }
    { topic: 'the Agent Client Protocol', maxWords: 60 }, // input, validated vs meta.inputs
    {
      agent: 'claude',                // 'claude' | 'codex' (default 'claude')

      // --- Interaction resolvers: answer round-trips inline as they arise ---

      // Permission: an ACP agent asked to run a tool. Approve the first option.
      onPermission: (req) => {
        console.log(`[permission] ${req.toolTitle} → approving`)
        return { kind: 'selected', optionId: req.options[0].optionId }
      },

      // Input: a checkpoint() / human-in-the-loop request. Return a plain value.
      onInput: (req) => {
        console.log(`[input] (${req.kind}) ${req.prompt}`)
        if (req.kind === 'confirm') return true
        if (req.kind === 'select') return req.options?.[0]?.id ?? req.default
        return req.default ?? ''
      },
    },
  )

  // Log the full event stream. `handle.on(...)` is the push form; `handle.events()`
  // is an equivalent `for await` pull form.
  const off = handle.on((event) => {
    console.log(`[event] ${event.type}`)
  })

  // `done` settles with the terminal RunResult once run:finished fires — including
  // when input validation fails before the engine even starts.
  const result = await handle.done
  off()

  console.log('\n--- result ---')
  console.log('status:', result.status)
  if (result.status === 'completed') console.log('result:', result.result)
  if (result.error) console.log('error:', result.error)

  process.exit(result.status === 'completed' ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
