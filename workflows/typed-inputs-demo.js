export const meta = {
  name: 'typed_inputs_demo',
  description:
    'Demo of typed meta.inputs + a human-in-the-loop checkpoint. Runs with no agent — it just exercises the generated input form, the Run gate, and the InputDialog.',
  phases: [{ title: 'Inputs' }, { title: 'Confirm' }],
  inputs: [
    { name: 'target', type: 'string', description: 'Path or area to act on', required: true },
    { name: 'maxItems', type: 'number', description: 'How many items to process', default: 5 },
    { name: 'dryRun', type: 'boolean', description: 'Preview only — no writes', default: true },
    { name: 'labels', type: 'string[]', description: 'Tags to apply', default: ['bug', 'triage'] },
  ],
}

// `args` is now typed from meta.inputs — hover it in the editor to see the shape.
phase('Inputs')
const labels = args.labels ?? []
log(`target=${args.target}  maxItems=${args.maxItems}  dryRun=${args.dryRun}  labels=[${labels.join(', ')}]`)

// A real human-in-the-loop pause — surfaces the new InputDialog when run from the IDE.
phase('Confirm')
const proceed = await checkpoint(
  `Process up to ${args.maxItems} item(s) under "${args.target}" in ${args.dryRun ? 'DRY-RUN' : 'LIVE'} mode?`,
  { kind: 'confirm', default: true },
)
const response = agent('hi', {agent: 'codex', })

return { target: args.target, maxItems: args.maxItems, dryRun: args.dryRun, labels, proceed, response }
