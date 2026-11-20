---
name: world-sim
description: Run, query, branch and debug deterministic ink-studio world simulations (ink-studio/world manifests, checkpoints and run recordings) with the world_* MCP tools. Use for scenarios, puzzles, simulated characters, logistics, weather or any fixed-tick world, and for finding where two runs diverge.
---

# Working with ink-studio worlds

A world is a JSON manifest (`format: "ink-studio/world"`) of systems advanced in fixed ticks (`dt` seconds). Runs are deterministic: the same world, seed and actions always give the same result. "Agents" inside a world are simulated characters, not you.

## Loop

1. `world_open` with `{ "path": "..." }`. Note `fields`, `traces` and `actions`: they are the only names `world_query` and `world_step` accept. `until` is the scenario's end tick, if any.
2. `world_step` with `steps`, `ticks` or `t`, and optionally `actions`: `{ "id": "open-gate", "tick": 12, "action": "world/input", "args": { "port": "system/port", "value": true } }`. Invalid actions are rejected before anything advances. The result lists the new events and the scenario status.
3. `world_query`: `inspect` for entities and names, `probe` a field at `target` (`{ "point": [x, y, z] }` or `{ "entity": "id" }`), `trace` to ask why (`world/cause`, or a system's own trace such as `lock/why`), `spatial` for entities near a point, `export` to sample a field over a line or grid.
4. Worlds only run forwards. To try alternatives, `world_sim` `fork` first and step each branch; `reset` returns to the opened state.

## Evidence and debugging

- `world_sim` `verify` replays the recording and confirms it reproduces.
- `world_sim` `save` with `kind: "recording"` writes a run that `world_open` can reopen; `kind: "checkpoint"` writes the current state.
- Two branches at the same tick: `diff` lists keyed state changes. Different histories: `diff` with `first: true` finds the first tick where they diverge.
- `world_sim` `plan` shows each system's reads, writes, emitted events and execution order.

Background reading: `ink_docs` topics `headless-worlds`, `agent-orders`, `agent-decisions`, `puzzles`, `simulation-scrubbing`, `first-divergence`.
