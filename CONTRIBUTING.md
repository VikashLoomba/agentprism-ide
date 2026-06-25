# Contributing to AgentPrism

Thanks for your interest in contributing! A few things to know before you start.

## License

AgentPrism is distributed under the [Business Source License 1.1](./LICENSE)
(BUSL-1.1). In short: you may read, modify, and run it locally or on your own
infrastructure — including for commercial purposes — but you may not offer it to
third parties as a competing hosted or managed service. Each released version
converts to the Apache License 2.0 on its Change Date (four years after release).
See [LICENSE](./LICENSE) for the exact terms.

## Contributor License Agreement (required)

Because AgentPrism is dual-licensable (BUSL-1.1 today, with commercial terms
available, and Apache-2.0 in the future), **every contributor must agree to our
[Contributor License Agreement](./CLA.md) before we can merge their work.**

- Individuals sign the **Individual CLA**.
- Anyone contributing on behalf of an employer signs the **Corporate CLA**.

You keep ownership of your contributions; the CLA grants Automata Labs the
rights needed to distribute and relicense them. This is the same model used by
most open-core projects.

### How signing works

We use an automated CLA check on pull requests. The first time you open a PR, a
bot will comment with a link to sign; once signed (one time, for all future
PRs), the check goes green and your PR can be reviewed.

> **Maintainer setup (one-time):** enable the
> [CLA Assistant](https://github.com/cla-assistant/cla-assistant) GitHub App (or
> [`contributor-assistant/github-action`](https://github.com/contributor-assistant/github-action))
> on this repository and point it at [`CLA.md`](./CLA.md). Until that is enabled,
> ask contributors to add a line to their PR description:
> `I have read and agree to the CLA in CLA.md.`

## Development

```bash
npm install
npm run dev          # Vite (http://localhost:5173) + backend (:8787)
npm run typecheck    # tsc for app + server
npm run lint         # oxlint
npm run build        # production build
```

Please make sure `npm run typecheck`, `npm run lint`, and `npm run build` all
pass before opening a pull request, and match the style of the surrounding code.

## Reporting issues

Open a GitHub issue with steps to reproduce, expected vs. actual behavior, and
your environment (OS, Node version, which ACP agents you have configured).
