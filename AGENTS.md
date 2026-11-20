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

Options: `--root DIR` resolves relative paths against DIR (default: `$CLAUDE_PROJECT_DIR`, else the working directory; absolute paths always work). `--allow-code` or `INK_AGENT_ALLOW_CODE=1` lets `scene_open` run JavaScript scene files, which execute arbitrary code. JSON dioramas never need it.

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
| `world_open` | read | Open a world manifest, checkpoint or run recording into a live simulation. Lists its fields, traces and action kinds. |
| `world_step` | write | Schedule `actions` and advance by `ticks`, `steps` or `t`. Invalid actions are rejected before anything moves. Returns scenario status and new events. |
| `world_query` | read | `inspect`, `spatial`, `select`, `probe`, `trace`, `export` on the current tick. |
| `world_sim` | write | `plan`, `fork`, `reset`, `save` (checkpoint or recording), `verify`, `diff` (same tick, or `first: true` for the first divergent tick), `close`. |
| `scene_review` | write | JSON reports of motion-review, clip-sequence, authored-contacts, motion-fx, animation-timeline, camera-rig, timeline, data-inputs and cloth-review. |
| `look` | write | Looks (LUTs, colour stacks, palettes, asset packs): `inspect`, `sample`, `bake`, `import`, `export`. |
| `ink_cli` | write | Any other CLI command (sheet, clip, passes, crisp, review, shimmer, compare, variants, paint, mesh, depth, snap, ...) as a JSON envelope with exit code, output and files written. `command: "help"` lists them. |

Every scene-taking tool accepts `scene` as exactly one of `{ "handle" }`, `{ "path" }`, `{ "spec" }` or `{ "builtin" }`. Built-ins: `watcher`, `burn`, `idol`, `bench`, `stuff`, `cabinet`, `rehearsal` (render only, not editable). World tools take `world` as `{ "handle" }`, `{ "path" }` or `{ "spec" }`; worlds only run forwards, so `fork` before trying alternatives.

## The loop

1. Write a diorama (start from `examples/scene.json`) and `scene_validate` it.
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

Failures return `{ code, message, path?, hint?, details? }`. Codes: `INVALID_INPUT`, `INVALID_JSON`, `INVALID_SCENE`, `INVALID_PATCH`, `INVALID_WORLD`, `INVALID_ACTIONS`, `STALE_REVISION`, `NOT_FOUND`, `NOT_EDITABLE`, `CODE_NOT_ALLOWED`, `UNSUPPORTED`, `EXISTS`, `BUILD_FAILED`, `EDIT_FAILED`, `EXPORT_FAILED`, `STEP_FAILED`, `QUERY_FAILED`, `VERIFY_FAILED`, `DIFF_FAILED`, `UNKNOWN_OP`, `INTERNAL`. Fix the input at `path` and retry; `details` lists every problem at once.

## Units and conventions

Positions are `[x, y, z]` in scene units with Y up; `box` takes half-extents; angles are radians; `res` is surface sampling spacing (smaller is denser and slower). "Agents" inside scene data means simulated characters (`docs/agent-*.md`), not you.
