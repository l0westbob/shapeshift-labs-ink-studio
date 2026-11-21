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
| `shades` | Shades per role ramp (default 4). |
| `hues` | Colour families for meshes with vertex colours (default 6). |
| `pixelSize` | Screen pixels per art pixel, written to `finish.look.pixelSize`. The renderer's default is 2, so a 128 × 128 render is a 64 × 64 sprite; use 1 to draw every pixel. |
| `pixelStyle` | `pixelStyle` for every role material. Default `true`: `{ "dither": "none", "shadeSteps": shades }` and the scene's palette dither off, which gives flat shade bands without speckle. `false` keeps the renderer defaults; an object is used as given. |
| `overwrite` | Replace an earlier model in `out` (stale part files are removed). |
| `preview`, `frames` | A turnaround image of the baked scene (default 4 views of 256 × 256), also written to `out/preview.png`. |

Every run also writes `out/raw.png`: the meshes as the script built them, before welding into distance fields and
baking, flat-shaded from the front and the back. Compare it with `preview.png` to tell a modelling problem from a baking
problem. `npm run serve` and `tools/raw-viewer.html?script=/path/model.mjs` show the raw model interactively in a browser.

The tool runs JavaScript, so the server needs `--allow-code` (or `INK_AGENT_ALLOW_CODE=1`), like JavaScript scenes. three
is an optional dependency: it is looked up next to the script, then in the project, then in ink-studio
(`npm install three`).

Then carry on with `scene_open` on the returned `scene` path: render, measure, edit (move parts with `setTransform`, add
a `ground`, parts and motion with `patch`), save, export an atlas.

## What carries over

- **Geometry**: every visible `Mesh`, with its world transform. Normals and UVs are dropped and vertices are welded, so
  three.js primitives (which split vertices along seams) become closed surfaces.
- **Colour**: every material becomes a palette role with its own ramp (see below). Meshes with vertex colours (and
  `vertexColors: true`) keep the automatic mesh look instead, whose colour families are added to the same palette.
  Textures are not read.
- **Light**: the first visible `DirectionalLight` becomes the diorama's sun (`light.sun`, pointing towards the light).
- **Not used**: lines, points, instanced and skinned meshes (instanced and skinned ones are reported in `warnings`).

## Materials become roles

A role is named by `material.userData.role`, else `material.name`, else the colour (`paint-5b6b2e`). Materials with the
same name share a role, and the first one gives it its colour. Each role gets a ramp of `shades` colours, dark to light:
the material colour is the second lightest shade (a face turned to the sun), shadows darken and lean cool, the top shade
leans warm. Palette index 0 is a near-black outline colour.

```js
const paint = new THREE.MeshStandardMaterial({ color: 0x5b6b2e });
paint.userData.role = 'hull';   // every part with this material shades on role "hull"
```

Because roles come from the script, they are stable across runs, and each solid's `mat` names its role, so recolouring a
whole material is one `setRole` edit. The built-in role names (`stone`, `metal`, `moss`, ...) are mapped onto the nearest
model ramp too, so changing the diorama's `style` changes light and finish without breaking the palette.

## Why one solid per mesh

The distance field of a mesh decides inside from outside by counting surface crossings. Where two closed shells overlap,
such as a turret sunk into a hull, a point inside both crosses an even number of surfaces and counts as outside. As
separate solids, the diorama unions their distance fields instead, so overlapping parts stay solid. It also means each
part has its own `slot:N` key, so it can be moved, recoloured or made a moving part afterwards.

## Tips

- Keep parts closed: `open` in the report is the share of edges that do not join two faces. Open parts bake as sheets
  with thickness and are listed in `warnings`.
- Name meshes (`mesh.name = 'turret'`): names end up in the part file names.
- Name materials (or set `userData.role`) and reuse one material for parts of one colour: fewer, clearer roles read
  better at sprite size than many near-identical ones.
- A model that looks dark: add a `DirectionalLight` above and in front of it, or set `light.amb` in the scene.
- Thin parts (barrels, antennas) need enough cells: raise `cells` if they break up.
- `model.glb` is the whole welded model, ready for other tools.
