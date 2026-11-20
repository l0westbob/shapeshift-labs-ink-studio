# ink-studio for AI agents

ink-studio sculpts signed-distance solids, bakes them into pixel-art Gaussian splats and renders them on the CPU. Agents use it through six JSON operations, available as MCP tools, as `ink-studio agent call`, and from Node via `agent/registry.js`.

## Connect

In this checkout, `.mcp.json` registers the server for Claude Code. From another project:

```bash
claude mcp add ink-studio -- node /absolute/path/to/ink-studio/agent/mcp-server.js
```

Options: `--root DIR` resolves relative paths against DIR (default: working directory). `--allow-code` or `INK_AGENT_ALLOW_CODE=1` lets `scene_open` run JavaScript scene files, which execute arbitrary code. JSON dioramas never need it.

Without MCP, every tool is a one-shot shell call that prints JSON (exit 0 ok, 1 op error, 2 usage):

```bash
node cli/ink-studio.js agent list
```

```bash
node cli/ink-studio.js agent call scene_render '{"scene":{"path":"examples/scene.json"},"t":1,"out":"studio/out/gem.png"}'
```

## Tools

| Tool | Effect | Use |
| --- | --- | --- |
| `scene_validate` | read | Check a diorama without baking. Every problem has `path`, `problem` and often a `hint` ("did you mean ball?"). |
| `scene_open` | read | Open a `path`, inline `spec` or `builtin` demo. Returns a `handle`, content `revision`, solid/part counts and palette roles. Baked worlds are cached per revision. |
| `scene_render` | read | PNG as image content. `mode: "turn"` draws `frames` views on one sheet. `measure` adds metrics. `out` also writes the file. |
| `scene_measure` | read | Numbers only: `stats` (splats, extent, palette use), `lint` (pixel-art faults vs reference), `crisp` (targets, `misses`, `pass`), `values` (tonal `verdict`). |
| `scene_edit` | write | Atomic batch on an open diorama. `baseRevision` guards staleness, `dryRun` previews, `render`/`measure` return the result in the same call. |
| `scene_save` | write | Write the current diorama JSON. Defaults to the source file; refuses to replace another file unless `overwrite`. |

Every scene-taking tool accepts `scene` as exactly one of `{ "handle" }`, `{ "path" }`, `{ "spec" }` or `{ "builtin" }`. Built-ins: `watcher`, `burn`, `idol`, `bench`, `stuff`, `cabinet`, `rehearsal` (render only, not editable).

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

Failures return `{ code, message, path?, hint?, details? }`. Codes: `INVALID_INPUT`, `INVALID_JSON`, `INVALID_SCENE`, `INVALID_PATCH`, `STALE_REVISION`, `NOT_FOUND`, `NOT_EDITABLE`, `CODE_NOT_ALLOWED`, `UNSUPPORTED`, `EXISTS`, `BUILD_FAILED`, `EDIT_FAILED`, `UNKNOWN_OP`, `INTERNAL`. Fix the input at `path` and retry; `details` lists every problem at once.

## Units and conventions

Positions are `[x, y, z]` in scene units with Y up; `box` takes half-extents; angles are radians; `res` is surface sampling spacing (smaller is denser and slower). "Agents" inside scene data means simulated characters (`docs/agent-*.md`), not you.
