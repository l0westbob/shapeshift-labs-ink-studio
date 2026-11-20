---
name: new-scene
description: Create a new ink-studio diorama from a short brief, iterate until it validates, reads well and passes the pixel-art metrics, then save it.
argument-hint: "<brief> [path.json]"
disable-model-invocation: true
---

Create an ink-studio diorama for this brief: $ARGUMENTS

1. If no path ending in `.json` is given, save to `studio/scenes/<id>.json` in the current project. Always pass absolute paths to the tools: the MCP server may run from another directory.
2. Follow the scene-authoring skill: check `ink_discover` `schema: "solidKinds"`, write a small first version, `scene_validate` it and fix every problem.
3. `scene_open`, then `scene_render` with `mode: "turn"` and compare against the brief.
4. Improve it with `scene_edit` batches (with `render` and `measure`) following the look-tuning skill until `values.verdict` is `THREE_TONES`, `crisp.pass` is true or each remaining miss is a deliberate choice, and the turn sheet matches the brief from every side.
5. `scene_save`, then report the path, the final metrics and one rendered image.
