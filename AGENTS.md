# ink-studio for AI agents

ink-studio sculpts signed-distance solids, bakes them into pixel-art Gaussian splats, renders them on the CPU and runs deterministic world simulations. Agents use it through JSON operations, available as MCP tools, as `ink-studio agent call`, and from Node via `agent/ops/index.js`. Start with `ink_discover` (no arguments) for an overview.

## Connect

### As a Claude Code plugin

The repository is both a plugin and a local marketplace (`.claude-plugin/`). The plugin bundles the MCP server, five skills (`scene-authoring`, `look-tuning`, `world-sim`, and the slash commands `/ink-studio:new-scene` and `/ink-studio:review`), the `ink-art-director` subagent, and a hook that validates diorama and world JSON whenever Claude writes one.

```bash
claude plugin marketplace add /absolute/path/to/ink-studio
```

```bash
claude plugin install ink-studio@ink-studio-local
```

For a single session without installing: `claude --plugin-dir /absolute/path/to/ink-studio`. After editing the plugin, run `/reload-plugins` in a session.

### As a plain MCP server

Without the plugin, register just the server (use one or the other, or every tool appears twice):

```bash
claude mcp add ink-studio -- node /absolute/path/to/ink-studio/agent/mcp-server.js
```

Options: `--root DIR` resolves relative paths against DIR (default: `$CLAUDE_PROJECT_DIR`, else the working directory; absolute paths always work). `--allow-code` or `INK_AGENT_ALLOW_CODE=1` lets `scene_open` run JavaScript scene files and `model_three` run three.js scripts, which execute arbitrary code. JSON dioramas never need it.

### From Codex or another MCP client

The server speaks plain MCP over stdio, so any client works. For Codex, add it to `~/.codex/config.toml` (or run `codex mcp add ink-studio -- node /absolute/path/to/ink-studio/agent/mcp-server.js --root /absolute/path/to/project`):

```toml
[mcp_servers.ink-studio]
command = "node"
args = ["/absolute/path/to/ink-studio/agent/mcp-server.js", "--root", "/absolute/path/to/project"]
env = { INK_AGENT_ALLOW_CODE = "1" }   # only if three.js scripts or JavaScript scenes should run
```

Pass `--root`, because `$CLAUDE_PROJECT_DIR` is only set by Claude Code. The Claude plugin's skills, subagent and validation hook do not load in other clients: read `plugin/skills/*/SKILL.md` for the same guidance, and call `scene_validate` after writing a diorama yourself. Every tool writes PNGs to disk when given `out`, so clients that drop image content still see results by reading the file.

Without MCP, every tool is a one-shot shell call that prints JSON (exit 0 ok, 1 op error, 2 usage):

```bash
node cli/ink-studio.js agent list
```

```bash
node cli/ink-studio.js agent call scene_render '{"scene":{"path":"examples/scene.json"},"t":1,"out":"studio/out/gem.png"}'
```

The classic `stats`, `lint`, `crisp` and `values` commands print the same JSON as `scene_measure` when given `--json`.

## Tools

| Tool | Effect | Use |
| --- | --- | --- |
| `ink_discover` | read | Overview; keyword search across tools, catalog and docs; `describe` a tool's input schema; `schema: "diorama"` for every field, solid kind, motion, effect, modifier, role and style. |
| `ink_docs` | read | List topics, full-text search, or read a topic page by page (`offset`, `maxChars`) or one `section`. |
| `scene_validate` | read | Check a diorama without baking. Every problem has `path`, `problem` and often a `hint` ("did you mean ball?"). |
| `scene_open` | read | Open a `path`, inline `spec` or `builtin` demo. Returns a `handle`, content `revision`, solid/part counts, palette roles and the scene `tree` with the keys edits take. Baked worlds are cached per revision. |
| `scene_render` | write | PNG as image content. `mode: "turn"` draws `frames` views on one sheet. `measure` adds metrics. `out` also writes the file (outside `studio/out` an existing file needs `overwrite`). |
| `scene_query` | read | Ask a baked scene: `select` look targets, `sample` the splat at a point (target, material, colour), look `output` or `provenance`. |
| `scene_measure` | read | Numbers only: `stats` (splats, extent, palette use), `lint` (pixel-art faults vs reference), `crisp` (targets, `misses`, `pass`), `values` (tonal `verdict`). |
| `scene_edit` | write | Atomic batch on an open diorama. `baseRevision` guards staleness, `dryRun` previews, `render`/`measure` return the result in the same call. |
| `scene_save` | write | Write the current diorama JSON. Defaults to the source file; refuses to replace another file unless `overwrite`. |
| `scene_export` | write | `format: "glb"` writes a UV-mapped model (JSON dioramas); `format: "atlas"` writes a directional sprite atlas with optional depth, normal, emission and silhouette maps and returns a preview. |
| `model_build` | write | Build a model with another modeller: `engine` `three` (three.js script), `cadquery` (CadQuery/build123d `.py`, runs in `.venv`) or `vox` (voxel JSON, no code needed). Writes `model.glb` (the shared hand-off), `raw.png` (before baking), a diorama with one palette role per material, and a preview. See [docs/model-build.md](docs/model-build.md). |
| `model_three` | write | `model_build` with engine `three`: run a three.js script (`({ THREE, addon }) => Object3D`) and write a diorama with one mesh solid per part and one palette role per material, plus `model.glb` and a preview. Needs code allowed. See [docs/three-modeling.md](docs/three-modeling.md). |
| `scene_fit` | write | Inverse modelling: tune numbers in a diorama (JSON pointers with ranges) until orthographic renders match target views (a carve source, letter grids or PNGs). Writes the best scene and a target, before, after sheet. Slow: every candidate rebakes. |
| `world_open` | read | Open a world manifest, checkpoint or run recording into a live simulation. Lists its fields, traces and action kinds. |
| `world_step` | write | Schedule `actions` and advance by `ticks`, `steps` or `t`. Invalid actions are rejected before anything moves. Returns scenario status and new events. |
| `world_query` | read | `inspect`, `spatial`, `select`, `probe`, `trace`, `export` on the current tick. |
| `world_sim` | write | `plan`, `fork`, `reset`, `save` (checkpoint or recording), `verify`, `diff` (same tick, or `first: true` for the first divergent tick), `close`. |
| `scene_review` | write | JSON reports of motion-review, clip-sequence, authored-contacts, motion-fx, animation-timeline, camera-rig, timeline, data-inputs and cloth-review. |
| `look` | write | Looks (LUTs, colour stacks, palettes, asset packs): `inspect`, `sample`, `bake`, `import`, `export`. |
| `ink_cli` | write | Any other CLI command (sheet, clip, passes, crisp, review, shimmer, compare, variants, paint, mesh, depth, snap, ...) as a JSON envelope with exit code, output and files written. `command: "help"` lists them. |

Every scene-taking tool accepts `scene` as exactly one of `{ "handle" }`, `{ "path" }`, `{ "spec" }` or `{ "builtin" }`. Built-ins: `watcher`, `burn`, `idol`, `bench`, `stuff`, `cabinet`, `rehearsal` (render only, not editable). World tools take `world` as `{ "handle" }`, `{ "path" }` or `{ "spec" }`; worlds only run forwards, so `fork` before trying alternatives.

## The loop

1. Write a diorama (start from `examples/scene.json`) and `scene_validate` it. For hard-surface models it can be easier to write a three.js or CadQuery script, and for sprite-sized props a voxel model, and turn it into a diorama with `model_build`.
2. `scene_open` it and keep the `handle` and `revision`.
3. `scene_render` to look; `scene_measure` for numbers you can compare across edits.
4. `scene_edit` with `baseRevision`, plus `render` and `measure`, until it looks right and the metrics hold.
5. `scene_save`.

## Edit operations

| `op` | Fields |
| --- | --- |
| `patch` | `patch`: one RFC 6902 operation on the diorama JSON. Add a solid with `{ "op": "add", "path": "/solids/-", "value": { "kind": "ball", "at": [0, 1, 0], "r": 0.5, "mat": "accent" } }`. |
| `setTransform` | `keys`, `patch`: `translation`, `rotation` (yaw, tilt, roll in radians), `scale`, `pivot` |
| `updateShape` | `keys`, `patch`: geometry fields of a solid or operand |
| `setModifiers` / `updateModifier` | `keys`, `modifiers` / `id`, `patch` (join, mask, fold, warp, shell, swell, rough, bubbles) |
| `setMaterial` | `keys`, `material`: a role name or material object |
| `setRole` | `name`, `ramp`: palette indices |
| `revert` | `revision`: restore an earlier revision from this session (only operation in the batch) |

Tree keys look like `slot:1` (solids by position) or `part:gem`. See [docs/scene-editor.md](docs/scene-editor.md) for field details.

## Errors

Failures return `{ code, message, path?, hint?, details? }`. Codes: `INVALID_INPUT`, `INVALID_JSON`, `CLI_FAILED`, `CLI_TIMEOUT`, `INVALID_SCENE`, `INVALID_PATCH`, `INVALID_WORLD`, `INVALID_ACTIONS`, `STALE_REVISION`, `NOT_FOUND`, `NOT_EDITABLE`, `CODE_NOT_ALLOWED`, `UNSUPPORTED`, `EXISTS`, `BUILD_FAILED`, `EDIT_FAILED`, `EXPORT_FAILED`, `STEP_FAILED`, `QUERY_FAILED`, `VERIFY_FAILED`, `DIFF_FAILED`, `UNKNOWN_OP`, `INTERNAL`. Fix the input at `path` and retry; `details` lists every problem at once.

## Units and conventions

Positions are `[x, y, z]` in scene units with Y up; `box` takes half-extents; angles are radians; `res` is surface sampling spacing (smaller is denser and slower). "Agents" inside scene data means simulated characters (`docs/agent-*.md`), not you.

## Shell transport

Organizations can restrict Claude Code to managed MCP servers (`allowManagedMcpServersOnly`); then the plugin's MCP server does not start. An administrator can allow it with an `allowedMcpServers` entry `{ "serverName": "ink-studio" }`. Until then, every tool runs as `ink-agent call <tool> '<json>'` with identical input and output. Handles do not survive between shell calls, so:

- edit dioramas with `scene_edit` and `{"scene":{"path":...}}` (validated, atomic, saved in place), or with your file tools (the plugin hook validates every write),
- render with `out` and read the PNG to see it,
- chain world steps through files with `world_step` `save`, and `verify` a saved recording with `world_sim` and a `path`.

## Python tools and previews

Modelling front ends that use Python (CadQuery, build123d, trimesh, manifold3d) run in a local venv. Python 3.12, because CadQuery's kernel has no wheels for newer versions yet:

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv -r requirements-modelling.txt
```

Call the tools as `.venv/bin/python`, never a global Python. `.venv/` is not committed.

To judge a model before it is baked, `model_build` and `model_three` write `out/raw.png`: the meshes as the script built them, flat-shaded from the front and the back, rendered on the CPU. For an interactive look, `npm run serve` serves the repository on `http://127.0.0.1:8765/` (no dependencies) and `tools/raw-viewer.html?script=/path/model.mjs&baked=/path/preview.png` runs a three.js script in the browser next to its baked image. `node scripts/compare-models.js` builds the same model with every method and `tools/compare.html` shows each method's `model.glb` and baked result side by side.

## Evals

`evals/` holds end-to-end tasks for agents (discover the format, repair a broken scene, build from a brief, tune the look with metrics, win a puzzle world, export an atlas). Each case is graded on the tools it used and on the files it produced. Runs are real Claude Code sessions and cost usage:

```bash
claude plugin eval . --runs 1 --ablation none --scaffold --mocks off --allow-tools "Bash(./ink-agent *)" "Bash(ink-agent *)" Write Edit --no-publish --max-cost-usd 8
```

The graders check the shell transport, because that is what runs where MCP servers are restricted. The eval sandbox only executes files inside the workspace, so each case's scaffold copies the runtime and a node binary into the workspace and agents call `./ink-agent`. Where the MCP server may run, add `--allow-tools "mcp__plugin_ink-studio_ink-studio__*"`; the MCP transport itself is covered by `tests/agent-ops.test.js`.

