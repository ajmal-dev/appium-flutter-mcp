# Contributing

Thanks for your interest in improving Appium Flutter MCP! Contributions of all sizes are welcome — bug reports, doc fixes, new tools, perf wins.

## Quick start

```bash
git clone <your-fork>
cd appium-flutter-mcp
npm install
npm run dev          # hot-reload via tsx
```

To smoke-test against a real device, you'll need:
- Appium 2.x running locally (`appium`)
- The `appium-flutter-integration-driver` installed
- A Flutter app launched in debug or profile mode on a paired iOS device or Android emulator

See the [README](./README.md) for full setup details.

## Development scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the server with hot-reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting files |
| `npm start` | Run the compiled server (`node dist/index.js`) |

## Adding a new MCP tool

1. Add the handler + Zod schema in the relevant file under `src/tools/`.
2. Register it in `src/server.ts` with `server.tool(name, description, schema.shape, handler)`.
3. Keep tool descriptions self-contained — agents read them as documentation.
4. Run `npm run build` to verify the types.

## Code style

- TypeScript strict mode is on; no `any` unless unavoidable (and commented).
- Prefer Zod schemas at every tool boundary — they double as runtime validation and JSON-Schema for the MCP client.
- Avoid speculative abstractions; small focused tools beat one mega-tool.
- Don't break tool signatures without a CHANGELOG entry; agents in the wild may rely on them.

## Pull requests

- Branch from `main`. Keep PRs small and focused.
- Include a short rationale in the description.
- If your change touches MCP tools or env config, update `README.md` and `.env.example`.
- Add a `CHANGELOG.md` entry under `## [Unreleased]`.

## Reporting bugs

Open an issue with: platform (iOS/Android), Appium version, steps to reproduce, and the relevant snippet from `LOG_LEVEL=debug` output if you have it.

## Licensing

By contributing, you agree your work is licensed under the project's [MIT License](./LICENSE).
