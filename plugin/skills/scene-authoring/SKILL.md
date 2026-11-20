---
name: scene-authoring
description: Author and edit ink-studio JSON dioramas (SDF solids baked into pixel-art splats) with the ink-studio MCP tools. Use when creating, changing, validating or saving a diorama, adding solids, parts, motion or effects, or when a task mentions ink-studio scenes.
---

# Authoring ink-studio dioramas

A diorama is JSON: `id` (lowercase, digits, dashes), `name`, `seed`, `style` (`slate`, `moss`, `ember`), `camera`, `solids`, optional `parts`, `motion`, `effects`, `finish`. Positions are `[x, y, z]` in scene units, Y up. Angles are radians.

## Before writing anything

1. `ink_discover` with `schema: "solidKinds"` gives every solid kind with required (`need`) and optional (`may`) fields. `schema: "diorama"` gives everything (top level, common solid fields, motion, effects, modifiers, roles, styles).
2. `mat` is a palette role: `stone`, `dark`, `pale`, `earth`, `wood`, `moss`, `leaf`, `water`, `metal`, `bone`, `ember`, `glow`, `accent`.
3. Start small. Minimal working diorama:

```json
{
  "id": "floating-gem", "name": "Floating gem", "seed": 2, "style": "moss",
  "camera": { "target": [0, 1.5, 0], "dist": 12, "pitch": 0.2, "yaw": 0.4 },
  "solids": [
    { "kind": "ground", "mat": "earth", "rad": 4, "res": 0.2 },
    { "kind": "ball", "at": [0, 1.8, 0], "r": 0.7, "mat": "accent", "part": "gem", "res": 0.12 }
  ],
  "parts": { "gem": { "joint": [0, 1.8, 0] } },
  "motion": [{ "do": "spin", "part": "gem", "axis": [0, 1, 0], "speed": 0.8 }]
}
```

## Loop

1. `scene_validate` the spec. Every problem has a `path` and usually a `hint`; fix all of them in one pass.
2. `scene_open` to get `handle`, `revision` and `tree`. Tree keys (`slot:N` for solids by position, `part:name`) are what keyed edits take.
3. `scene_render` to look (images are small and cheap). Use `mode: "turn"` to check every side.
4. `scene_edit` with `baseRevision`, batching related operations. Add `render` and `measure` to see the result in the same call. Use `dryRun: true` when unsure.
5. `scene_save` when done. It writes back to the source file unless `path` is given. Use absolute paths: the MCP server may not run in the project directory.

## Editing

- Structural changes (add or remove solids, parts, motion, effects) use `patch` with RFC 6902: `{ "op": "patch", "patch": { "op": "add", "path": "/solids/-", "value": { ... } } }`.
- Moving, rotating and scaling existing solids use `setTransform` with `keys`; changing geometry uses `updateShape`; materials use `setMaterial`; palette ramps use `setRole`.
- A batch is atomic: if any operation or the final validation fails, nothing changes and the error names the operation (`/operations/N`).
- `revert` with an earlier `revision` undoes a batch within the session.

## Pitfalls

- `box` takes half-extents: `half: [1, 1.2, 1]` is 2 × 2.4 × 2 units.
- `res` is the surface sampling spacing. Smaller is denser and slower; 0.1 to 0.2 is typical, below 0.05 gets expensive.
- Built-in demos (`watcher`, `idol`, ...) render but are not editable. JavaScript scenes need the server started with code allowed.
- More detail: `ink_docs` with `topic: "scene-editor"` (modifiers, brushes, prefabs) or `query` for anything else.
