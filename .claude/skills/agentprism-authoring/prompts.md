# Writing a prompt template

A prompt template is a **Handlebars** file saved as **`prompts/<name>.hbs`**. It declares typed parameters in a frontmatter block, renders to a plain string, and is callable from a workflow as `prompts.<name>(data)`.

## Hard rules

1. **The filename bareName MUST be a valid JS identifier** — `mrReview.hbs`, **not** `mr-review.hbs`. The bareName is simultaneously the injected member (`prompts.mrReview`), the catalog key, and the partial name (`{{> mrReview}}`); there is no name transform anywhere, so a non-identifier filename is rejected.
2. **Templates are pure.** No helper does IO, randomness, or time. This is what lets the server render and the browser live-preview produce byte-identical output.
3. Rendering uses `noEscape` (plain text — never HTML-encodes `& < > "`) and is **lenient** (`strict: false`): a missing field renders empty rather than throwing.

## Frontmatter — typed params

A leading `---` fence whose body is **JSON** of shape `{ "params": PromptParam[] }`:

```hbs
---
{ "params": [
  { "name": "criteria", "type": "string[]", "description": "Checklist to render",
    "example": ["Has tests", "Updates docs"] }
] }
---
{{#each criteria}}
- [ ] {{this}}
{{/each}}
```

Each param:

| field | required | notes |
|---|---|---|
| `name` | yes | must be an identifier; becomes a key in the `data` object |
| `type` | yes | one of `string`, `number`, `boolean`, `string[]`, `number[]`, `boolean[]` |
| `description` | no | shown in the typed `prompts.<name>(data)` signature |
| `default` | no | workflow-facing default + preview seed; must match `type` |
| `example` | no | explicit preview sample (overrides the type-derived placeholder) |

The params drive both the **typed signature** the workflow sees and the **live preview** sample data (seeded `example ?? default ?? type-placeholder`). A malformed frontmatter fence degrades gracefully (zero params + a warning), it does not break the file.

## Built-in safe helpers

All pure. Use them in the body:

- `eq a b`, `ne a b`, `not a` — comparisons / negation
- `join arr sep` — join an array (default separator `", "`)
- `json v` — `JSON.stringify(v, null, 2)`
- `lowercase s`, `uppercase s`, `trim s`
- `default v fallback` — `fallback` when `v` is `undefined`/`null`/`""`

```hbs
{{#if (eq verdict "approve")}}APPROVED{{/if}}
Tags: {{join tags ", "}}
```

## Partials (composition)

Reference another template by its identifier name with `{{> name}}`; pass params with `key=value`. The partial is the other template's full body, so composition renders identically everywhere:

```hbs
## Acceptance criteria
{{> criteriaList criteria=acceptanceCriteria}}
```

(`criteriaList` here is `prompts/criteriaList.hbs`.)

## Calling it from a workflow

Declare the template in `meta.prompts`, then call it — it returns a `string`:

```js
export const meta = {
  name: 'mr_review_demo',
  description: 'Review an MR using the mrReview prompt template.',
  prompts: ['mrReview'],   // project prompts/ first, then ~/.agentprism/prompts/
}

phase('Review')
const p = prompts.mrReview({
  acceptanceCriteria: ['Has tests', 'Updates docs'],
  comments: ['Consider the empty-input edge case'],
  diff: args.diff ?? '',
})
return await agent(p, { cwd, label: 'mr review' })
```

Save the template to `prompts/<name>.hbs`; the IDE's Prompts sidebar opens it with Handlebars highlighting and a live preview rendered exactly as production.
