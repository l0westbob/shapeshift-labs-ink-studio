---
name: best-of-n
description: Build one ink-studio model several ways in parallel (different engines and approaches), rank the results with model_rank, then refine the winner. Use when quality matters more than time.
argument-hint: "<brief> [n=4] [out-dir]"
disable-model-invocation: true
---

Build the best model you can for this brief by trying several approaches and keeping the strongest: $ARGUMENTS

Quality comes from the input, and single attempts vary a lot, so build several candidates, measure them the same way and refine only the winner.

## 1. Fix the target before building

- Write a short spec of the object: real proportions in metres (length, width, height, the main parts and their sizes), its colours and the three or four details that must read at sprite size.
- Draw the target sprite as a carve source (`<out>/target.views.json`: front, right and top views as letter grids, one letter per colour, see `ink_docs` topic `model-build`). It is both a candidate (engine `carve`) and the yardstick every other candidate is ranked against.

## 2. Build N candidates in parallel

Start one subagent per candidate (default 4) in a single message, so they run at the same time. Give each the brief, the spec, the target views file, its own output directory `<out>/<n>-<engine>` and one engine, picked so the approaches differ:

| Engine | Source | Strength |
| --- | --- | --- |
| `cadquery` | `.py` (CadQuery assembly with names, colours, `metadata={"role": ...}`) | precise hard surfaces, fillets, chamfers |
| `blender` | `.blender.py` (bpy, modifiers applied) | bevels, smooth and organic forms |
| `three` | `.mjs` (three.js, named materials) | quick low-poly hard surfaces |
| `vox` | `.json` (letter layers, colour per letter) | exact sprite-scale detail |
| `carve` | the target views themselves | matches the drawing by construction |
| diorama | SDF solids JSON | soft forms, native to the renderer |

Each subagent writes its source, runs `model_build` with `size` and `pixelSize: 1` (or writes the diorama and `scene_validate`s it), looks at `raw.png` and `preview.png`, fixes what reads badly, and reports the output directory. Without MCP tools they use the shell transport (`ink-agent call model_build '<json>'`).

## 3. Rank

```json
{ "candidates": [ { "dir": "<out>/1-cadquery" }, { "dir": "<out>/2-blender" }, { "dir": "<out>/3-vox" }, { "dir": "<out>/4-carve" } ],
  "targets": [ { "views": "<out>/target.views.json" } ], "out": "<out>/rank" }
```

`model_rank` scores cleanliness (pixel-art faults against the reference), tones and the match with the target views, writes `ranking.json`, a labelled `sheet.png` and a manifest for `tools/compare.html` (`npm run serve`, then `/tools/compare.html?manifest=/<out>/rank/manifest.json`). Read the sheet yourself too: the numbers rank, your eyes catch what they miss. The carve candidate matches its own drawing by construction, so weigh its match score with that in mind.

## 4. Refine the winner

- Proportions off: `scene_fit` against the target views, with the winner's main sizes and positions as params.
- Look off: the `look-tuning` skill (shade steps, roles, light).
- Detail missing: edit the winner's source and build it again, or add a small voxel part for sprite-scale detail.

Rank again after refining; stop when the winner no longer improves. Report the ranking, the winner's directory and what changed.
