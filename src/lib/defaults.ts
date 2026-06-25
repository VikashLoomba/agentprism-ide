export const DEFAULT_WORKFLOW = `export const meta = {
  name: 'hello_workflow',
  description: 'A tiny starter workflow — inventory, then summarize.',
  phases: [{ title: 'Explore' }, { title: 'Summarize' }],
}

phase('Explore')
const overview = await agent(
  'Give a one-paragraph overview of this project based on its files.',
  { config: { model: 'haiku' }, label: 'project overview' },
)

phase('Summarize')
return await agent(
  'Turn this overview into 3 crisp bullet points:\\n\\n' + overview,
  { config: { model: 'sonnet' }, label: 'bullet summary' },
)
`

export const DEFAULT_PROMPT = `---
{ "params": [
  { "name": "topic", "type": "string", "description": "What the prompt is about", "example": "merge requests" }
] }
---
Write a short, clear instruction about {{topic}}.
`

