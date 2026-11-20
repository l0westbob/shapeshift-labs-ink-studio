# @shapeshift-labs/ink-studio

An agent-first toolkit for sculpting signed-distance solids, baking them into pixel-art Gaussian splats, rendering and measuring them on the CPU, and running deterministic world simulations. Scenes are JSON; every capability is a typed operation with JSON input and output.

**Agents start with [AGENTS.md](AGENTS.md).** The complete reference for the library, the CLI and the scene format is [docs/reference.md](docs/reference.md); feature guides live in [docs/](docs/).

## Use it from an agent

The repository is a Claude Code plugin and a local marketplace. The plugin bundles the MCP server, skills, slash commands, a critic subagent and a hook that validates scene JSON on write.

```bash
claude plugin marketplace add /absolute/path/to/ink-studio
```

```bash
claude plugin install ink-studio@ink-studio-local
```

Where local MCP servers are not allowed, the same tools run from the shell through `ink-agent` (on PATH while the plugin is enabled):

```bash
node bin/ink-agent call scene_render '{"scene":{"path":"examples/scene.json"},"t":1,"out":"studio/out/gem.png"}'
```

## Use it from Node or the classic CLI

Requires Node 18 or later and has no runtime dependencies.

```bash
node cli/ink-studio.js help
```

```bash
node cli/ink-studio.js render examples/scene.json --colored
```

```js
const studio = require('@shapeshift-labs/ink-studio');
const { makeBuilder, makeSculpt, KIT: K } = studio.load();
```

See [docs/reference.md](docs/reference.md) for the library API, every CLI command and the browser renderer.

## Development

```bash
npm test
```

```bash
npm run lint
```

```bash
node scripts/sync-catalog.js
```

`npm test` runs the unit tests, the agent and plugin tests, and the numerical self-checks. `scripts/sync-catalog.js` regenerates the agent and CLI entries of [catalog.json](catalog.json); a test fails when it is out of date. Agent evals live in [evals/](evals/) and run with `claude plugin eval` (see AGENTS.md).

Background on the agent-first redesign: [AGENT-FIRST-ANALYSIS.md](AGENT-FIRST-ANALYSIS.md).

## License

Licensed under the [MIT License](LICENSE).
