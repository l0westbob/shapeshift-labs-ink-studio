---
name: review
description: Review an ink-studio scene: turn sheet, metrics and concrete fix suggestions, without editing it.
argument-hint: "<scene.json | built-in id>"
disable-model-invocation: true
---

Review the ink-studio scene $ARGUMENTS without changing it.

1. Open it with `scene_open` (`path` for a file, `builtin` for a demo id such as `watcher`).
2. `scene_render` with `mode: "turn"` and `frames: 8`, and one `single` render from the scene camera.
3. `scene_measure` with `metrics: ["stats", "lint", "crisp", "values"]`.
4. If the scene is animated, render `t` = 0, 1 and 2 to check motion reads.
5. Report: what reads well, the three most important problems (each with the metric or view that shows it), and for each a concrete `scene_edit` operation that would fix it. Do not apply them.
