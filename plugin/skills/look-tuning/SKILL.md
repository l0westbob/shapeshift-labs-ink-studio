---
name: look-tuning
description: Improve how an ink-studio diorama reads as pixel art using rendered images plus numeric metrics (lint, crisp, values, stats). Use when a scene looks muddy, noisy, flat or jagged, or when asked to polish, tune or quality-check an ink-studio render.
---

# Tuning the look of a diorama

Judge with both eyes and numbers: `scene_render` shows the picture, `scene_measure` returns metrics you can compare across edits. Measure before changing anything so you have a baseline.

## Metrics and what to do about them

| Metric | Good | When it is off |
| --- | --- | --- |
| `values.verdict` | `THREE_TONES` | `ONE_TONE` or `FLAT`: separate materials by value, use roles with lighter or darker ramps (`setRole`), adjust light in `finish`. `TWO_TONES`: add a mid or light accent. |
| `lint.orphans`, `lint.noise` | at or below `lint.reference` | Too many lone pixels: raise `res` on noisy solids, reduce `finish.dither`, avoid tiny solids far from the camera. |
| `lint.jaggies`, `lint.doubles` | at or below reference | Uneven staircases: try `look.colored: true` in the render, rotate thin solids off the 45° diagonal, thicken thin parts. |
| `lint.banding`, `lint.pillow` | near 0 | Shading follows outlines: give the form a clearer light direction rather than more tones. |
| `crisp.misses` | empty (`crisp.pass: true`) | Each miss names the metric, value and target. `flat` too low means too much texture; `edges` too low means silhouettes dissolve. |
| `stats.palette.unused` | few | Many unused colours from this view: drop roles nobody uses or move the camera. |
| `stats.warnings` | none | `SPLATS_HEAVY` above 150,000 splats: raise `res` on large surfaces. |

## Loop

1. `scene_measure` with `metrics: ["lint", "crisp", "values", "stats"]` for a baseline. Keep the numbers.
2. Change one thing per batch with `scene_edit`, passing `measure` and `render` so each step returns its own evidence.
3. Keep a change only if the metric you targeted improves and the image still reads; otherwise `revert` to the previous revision.
4. Check other angles with `scene_render` `mode: "turn"` before declaring victory; a fix from one view can break another.

Metrics compare a render with reference values taken from hand-made pixel art. They are guides, not goals: never trade a readable silhouette for a lower number.

Without the MCP tools, run the same loop from the shell: `ink-agent call scene_measure '{...}'`, `ink-agent call scene_edit` with a `path` (edits and saves in place), and `scene_render` with `out` followed by reading the PNG.
