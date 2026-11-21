# Modelling with three.js

Dioramas are usually built from ink-studio's own signed-distance solids. For hard-surface objects (vehicles, buildings,
furniture, machines) it is often easier to model with the three.js API, which agents know well: extruded profiles,
lathes, rounded boxes, groups and transforms. `model_three` runs such a script and hands the result to the normal
pipeline: the meshes become distance-field solids, bake to pixel-art splats and render like everything else.

```text
three.js script ──> welded meshes ──> parts/NN-name.glb ──> scene.json (one mesh solid per part) ──> bake, render, edit
```

## The script

A `.mjs`, `.cjs` or `.js` file that exports one function. It receives `THREE` (the three.js module) and `addon` (imports a
three.js addon from the same install) and returns an `Object3D`. It may be `async`. Do not import `three` yourself: use
the one passed in, so the exporter sees the same classes.

```js
export default async ({ THREE, addon }) => {
  const { RoundedBoxGeometry } = await addon('geometries/RoundedBoxGeometry');
  const crate = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(2, 1.4, 1.4, 3, 0.12), new THREE.MeshStandardMaterial({ color: 0x8a5a2b }));
  body.position.y = 0.7;
  body.name = 'body';
  crate.add(body);
  return crate;
};
```

[examples/three/tank.mjs](../examples/three/tank.mjs) is a complete model with 17 parts.

## Running it

```bash
ink-agent call model_three '{"script":"/abs/examples/three/tank.mjs","out":"/abs/studio/out/tank","size":6}' --allow-code
```

| Field | Meaning |
| --- | --- |
| `script`, `out` | The script and the directory for `scene.json`, `model.glb`, `parts/` and `preview.png`. |
| `size` | Largest side of the whole model in scene units. Without it, three.js units are kept. |
| `cells` | Distance-field cells along the model's longest side (default 96). Every part gets the same cell size, so small parts keep their detail. |
| `hues`, `shades` | Colour families taken from the materials (default 6) and shades per family (default 4). |
| `overwrite` | Replace an earlier model in `out` (stale part files are removed). |
| `preview`, `frames` | A turnaround image (default 4 views), also written to `out/preview.png`. |

The tool runs JavaScript, so the server needs `--allow-code` (or `INK_AGENT_ALLOW_CODE=1`), like JavaScript scenes. three
is an optional dependency: it is looked up next to the script, then in the project, then in ink-studio
(`npm install three`).

Then carry on with `scene_open` on the returned `scene` path: render, measure, edit (move parts with `setTransform`, add
a `ground`, parts and motion with `patch`), save, export an atlas.

## What carries over

- **Geometry**: every visible `Mesh`, with its world transform. Normals and UVs are dropped and vertices are welded, so
  three.js primitives (which split vertices along seams) become closed surfaces.
- **Colour**: material colours and vertex colours become one palette for the whole model (`palette` in the diorama).
  Textures are not read.
- **Not used**: lines, points, instanced and skinned meshes (instanced and skinned ones are reported in `warnings`).

## Why one solid per mesh

The distance field of a mesh decides inside from outside by counting surface crossings. Where two closed shells overlap,
such as a turret sunk into a hull, a point inside both crosses an even number of surfaces and counts as outside. As
separate solids, the diorama unions their distance fields instead, so overlapping parts stay solid. It also means each
part has its own `slot:N` key, so it can be moved, recoloured or made a moving part afterwards.

## Tips

- Keep parts closed: `open` in the report is the share of edges that do not join two faces. Open parts bake as sheets
  with thickness and are listed in `warnings`.
- Name meshes (`mesh.name = 'turret'`): names end up in the part file names.
- Thin parts (barrels, antennas) need enough cells: raise `cells` if they break up.
- `model.glb` is the whole welded model, ready for other tools.
