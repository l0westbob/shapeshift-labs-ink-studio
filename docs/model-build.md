# Building models with other modellers

A diorama's own solids are one way to model. `model_build` adds others: a three.js script, a CadQuery or build123d script,
or a voxel model. Each one ends in the same hand-off, so everything after it is shared:

```text
three.js script ─┐
CadQuery script ─┼─> model.glb (+ raw.png) ──> palette roles, scene.json ──> bake, render, edit, export
voxel model     ─┘
```

| Engine | Source | Good for | Runs code |
| --- | --- | --- | --- |
| `three` | `.mjs`, `.js`, `.cjs` exporting `({ THREE, addon }) => Object3D` | Quick low-poly hard surfaces. See [three-modeling.md](three-modeling.md). | yes |
| `cadquery` | `.py` defining `build()`, `result` or `show_object()` | Precise parts: fillets, chamfers, lofts, sweeps, cut details. | yes |
| `blender` | `.blender.py` building objects with `bpy` | Bevelled hard surfaces and smooth organic forms: modifiers (bevel, subdivision, mirror, array, boolean) are applied. | yes |
| `vox` | `.json` with plans of letters and a colour per letter | Small props and characters at sprite size, exact colours. | no |
| `compose` | `.compose.json` listing parts from other engines and dioramas | The best tool for each part: a CAD hull, voxel markings, SDF sandbags. | per part |
| `carve` | `.views.json` with orthographic views drawn as letter grids | Pixel first: draw how the sprite should read, get the solid that matches. | no |

The engine follows from the extension unless `engine` is given. `size`, `pixelSize`, `pixelStyle`, `shades`,
`overwrite`, `preview` and `frames` work the same for every engine (see [three-modeling.md](three-modeling.md#running-it)).

```bash
ink-agent call model_build '{"source":"/abs/examples/cadquery/tank.py","out":"/abs/studio/out/tank","size":6,"pixelSize":1}' --allow-code
```

## What every engine writes

| File | What it is |
| --- | --- |
| `model.glb` | The extracted model: one mesh per part, material colours as glTF materials. The same hand-off for every engine. |
| `raw.png` | That model before baking, flat-shaded on the CPU from the front and the back. |
| `scene.json` | The diorama. Mesh engines: one `mesh` solid per part. Voxels: one `vox` solid, baked from the grid itself. |
| `parts/` | Mesh engines: one GLB per part, referenced by the solids. |
| `model.json` | Every part's name, role and bounds in scene units, for `model_check`. |
| `preview.png` | A turnaround of the baked scene. |

Every material becomes a palette role with its own ramp (see [three-modeling.md](three-modeling.md#materials-become-roles)):
`material.userData.role` or `material.name` in three.js, `metadata={"role": ...}` in CadQuery (else the colour), the
`role` of a colour entry in voxels (else the colour). Comparing `raw.png` with `preview.png` tells a modelling problem
from a baking problem.

## CadQuery and build123d

The script runs in the project's `.venv` (or `$INK_PYTHON`); see `requirements-modelling.txt`. It makes the model in any
of these ways, the first that applies wins:

```python
def build():               # a function returning the model
    ...
result = ...               # or a global called result
show_object(shape, name="hull", options={"color": "#5b6b2e", "role": "olive"})   # or CQ-editor style calls
```

A model is a `cq.Assembly` (names, colours, locations and `metadata={"role": ...}` are kept), a `Workplane`, a `Shape`,
a build123d object, a list of those, or a dict `{name: model | (model, colour) | {"shape", "color", "role"}}`. Colours
are `"#rrggbb"`, `0xrrggbb`, a colour name, an `(r, g, b)` tuple in 0..1 or a `cq.Color`.

```python
import cadquery as cq

def build():
    assy = cq.Assembly()
    hull = cq.Workplane().box(4, 2, 0.8).edges("|Z").fillet(0.2)
    assy.add(hull, name="hull", color=cq.Color("#5b6b2e"), metadata={"role": "olive"})
    return assy
```

- CAD is Z up; the model is turned so Z becomes Y. Units are kept unless `size` is given.
- `tolerance` (default 0.0015) is the largest chord error of the triangles as a share of the model's size. Lower it for
  smoother curves, raise it for fewer triangles.
- Python errors come back as `BUILD_FAILED` with the line of the script in `hint`. A shape OpenCascade reports as invalid
  is listed in `warnings`; it usually still bakes.
- [examples/cadquery/tank.py](../examples/cadquery/tank.py) is a complete assembly with 24 parts.

## Blender

The script runs headless (`blender -b`) in an empty scene, found as `$INK_BLENDER`, `blender` on the PATH or the macOS
application. It builds objects with `bpy` (or defines `build()`, which is then called).

- Every visible mesh, curve, surface, metaball and text object is evaluated with its modifiers, so a bevel, subdivision,
  mirror, array or boolean modifier is part of the result.
- One part per object and material. The colour is the material's Principled BSDF base colour; the role is the
  material's custom property `role` (`mat["role"] = "olive"`), else the material name.
- Blender is Z up; the model is turned so Z becomes Y. The first sun lamp becomes the diorama's sun.
- [examples/blender/tank.blender.py](../examples/blender/tank.blender.py) uses bevels, an array and a mirror modifier and
  a bmesh prism for the tracks.

## Voxels

```json
{ "cell": 0.125, "hard": true,
  "colours": { "o": { "colour": "#5b6b2e", "role": "olive" }, "t": "#2b2b2b" },
  "layers": [ "tttt/tttt", ["toot/t..t", 2], "oooo/oooo" ] }
```

- `layers` are plans from the bottom up: rows run from the back to the front, letters from left to right; a plan is a list
  of rows or one string with rows parted by `/`; `[plan, n]` repeats a plan n layers. `front` instead takes pictures seen
  from the front, nearest first. `.` and spaces are empty.
- `colours` gives every letter a colour, or `{ "colour", "role" }`. Letters of one colour share a role.
- `cell` is the block size (or `[x, y, z]`), `hard: true` (the default here) keeps flat faces and square corners; `false`
  rounds them into one soft solid. `mirror: "x"` finishes each row with itself reversed.
- [examples/vox/tank.json](../examples/vox/tank.json) is a 50 × 16 × 24 tank; generating the plans with a short script
  is easier than typing them.

The diorama gets one `vox` solid with the same fields and a `key` of materials, so it can also be written by hand:
`{ "kind": "vox", "at": [0, 0, 0], "cell": 0.1, "key": { "s": "stone" }, "layers": ["ss/ss"] }`.

## Carving drawn views (pixel first)

Draw the model the way the finished pixel art should read, as two or more orthographic views, and let the solid follow:

```json
{ "cell": 0.125,
  "colours": { "o": { "colour": "#5b6b2e", "role": "olive" }, "t": "#2b2b2b" },
  "views": { "front": ["..oo..", "tttttt"], "right": ["oo", "tt"], "top": ["tttttt", "tttttt"] } }
```

| View | Seen from | Letters run along | Rows run |
| --- | --- | --- | --- |
| `front` | +Z | +x | top to bottom (y) |
| `back` | -Z | -x | top to bottom |
| `right` | +X | -z | top to bottom |
| `left` | -X | +z | top to bottom |
| `top` | +Y | +x | back (-z) to front (+z) |
| `bottom` | -Y | +x | front to back |

- A block stays where every view sees something (the visual hull). Every axis must be seen by some view, and views that
  share an axis must agree on its length (pad with `.`).
- Each surface block takes the letter of the view that sees it; where several do, the majority wins, ties go to top,
  front, right, left, back, bottom. A side without its own view is painted like the opposite one.
- Hollows and undercuts no view can see are filled. The carved grid is written as `carved.vox.json`: edit it and build it
  with engine `vox` to cut them in. `views.png` shows the drawn views.
- [examples/carve/tank.views.json](../examples/carve/tank.views.json) draws a tank in three views.

## Composing parts from several engines

```json
{ "parts": [
    { "source": "../cadquery/tank.py", "size": 6, "pixelSize": 1 },
    { "source": "emblem.vox.json", "size": 0.6, "at": [-0.3, 1.3, 0.83] },
    { "diorama": "sandbags.json", "at": [-2.05, 1.14, 0.25], "yaw": 1.5708, "scale": 0.9 } ] }
```

- `source` parts are built with their engine (from the extension, or `engine`) into `out/sources/`, with `size`,
  `pixelSize` and further `options`; `diorama` parts are used as they are.
- Every solid gets a `transform` (yaw, uniform `scale`, then `at`, around the origin). Palettes merge colour by colour,
  index 0 stays the first part's background, roles keep their names (a clash with other colours gets the part number
  appended), materials, raw ramps and voxel keys are rewritten, mesh assets point at each part's files.
- `camera`, `light`, `finish` and `style` come from the composition, else from the first part. Motion, effects and
  groups of the parts are not carried over (listed in `warnings`).
- Code engines still need code allowed. A composition writes `scene.json` only; mesh it with `scene_export` for a GLB.
- [examples/compose/tank.compose.json](../examples/compose/tank.compose.json): the CadQuery tank, a voxel star and SDF
  sandbags.

## Spec sheets

Proportions are what agent models get wrong most, so write them down before building and check them after with
`model_check`:

```json
{ "dir": "studio/out/tank",
  "spec": { "size": { "x": [6.5, 7.2], "y": [2.2, 2.6] },
            "parts": { "hull": { "x": [5.6, 6.2] }, "wheel*": { "x": [4.2, 4.8] } },
            "ratios": [ { "a": "turret.x", "b": "hull.x", "range": [0.38, 0.46] } ] } }
```

`size` is measured from the baked splats, so it works for any diorama; `parts` and `ratios` use `model.json` (`*` matches
several parts, measured as their union; `size` names the whole model in a ratio). Units are scene units: build with
`size` equal to the real longest side, or without `size` to keep the source units. Each failed check carries the
`scale` that would bring it into range.

## Snapping to the pixel grid

`snap` (mesh engines and voxels) says how many art pixels the model's longest side spans in the final sprite. Part
positions and sizes (or voxel cells) round to whole pixels, so part edges land on the pixel grid instead of splitting
pixels. On the CadQuery tank, `snap: 96` lowered noise from 0.198 to 0.139 and jaggies from 0.33 to 0 in an orthographic
side view, and noise from 0.182 to 0.154 in the default three-quarter view.

## Fitting a scene to the drawing

`scene_fit` closes the loop from the other side: it tunes numbers in any diorama (from any engine, or hand-written)
until its orthographic renders match target views.

```json
{ "scene": { "path": "studio/out/hut/scene.json" },
  "targets": [ { "views": "examples/carve/tank.views.json" } ],
  "params": [ { "path": "/solids/1/half/1", "min": 0.1, "max": 1.5 },
              { "paths": ["/solids/4/at/0", "/solids/5/at/0"], "min": -2, "max": 2 } ],
  "out": "studio/out/hut-fit", "iterations": 30, "population": 8 }
```

- `params` are JSON pointers to numbers with a range; `paths` moves several fields together (mirrored parts), `step`
  rounds values (cells, counts).
- `targets` are the views of a carve source, letter grids `{ view, rows, colours }` or PNGs `{ view, image }`.
- The score is silhouette overlap plus colour agreement (`weights`, default 1 and 0.5; `lint` adds a pixel-art noise
  penalty). Each render is scaled to the area of its target and centred, so framing and overall scale do not matter but
  proportions do.
- A (1+λ) evolution strategy searches the box; every candidate is baked and rendered from every view, so it is slow by
  design. `budget` caps the seconds. `out/fit.png` shows per view the target, the start and the best; `out/fit.json` the
  values and the score history.

## Best of N

Single attempts vary a lot, so for quality build several candidates and keep the strongest. `model_rank` bakes, renders
and scores every candidate the same way: cleanliness (pixel-art faults against the reference), tones, and, with target
views, silhouette and colour match. It writes `ranking.json`, a labelled `sheet.png` and a manifest for
`tools/compare.html`.

```json
{ "candidates": [ { "dir": "studio/out/tank/1-cadquery" }, { "dir": "studio/out/tank/2-blender" }, { "scene": "scenes/tank.json" } ],
  "targets": [ { "views": "studio/out/tank/target.views.json" } ], "out": "studio/out/tank/rank" }
```

The plugin's `/ink-studio:best-of-n` command runs the whole procedure: a spec and a drawn target first, then one subagent
per engine in parallel, then the ranking, then `scene_fit` and look tuning on the winner. Other agents can follow
[plugin/skills/best-of-n/SKILL.md](../plugin/skills/best-of-n/SKILL.md) the same way.

## Comparing methods

`node scripts/compare-models.js` builds the same model with every method (by default the tanks in `examples/`) and
writes `studio/out/compare-models/manifest.json`. `npm run serve` and
`http://127.0.0.1:8765/tools/compare.html` then show, per method, the extracted `model.glb` in one viewer (drag to turn
them all together) and below it the baked result with its numbers. A diorama of SDF solids has no extracted model, so the
script meshes it with `scene_export` for the top row; its baking still uses the distance field.
