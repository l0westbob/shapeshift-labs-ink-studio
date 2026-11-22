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
| `openscad` | `.scad`, parts named in `PARTS` and drawn by `module part(name)` | CSG with robust booleans (Manifold); a huge body of examples. | yes |
| `sdf` | `.sdf.mjs` returning distance functions built from `library/sdf.mjs` | Smooth blends, repeats, twists and noise in the Shadertoy style. | yes |
| `subd` | `.subd.json`, or `.subd.mjs` with cage helpers | Characters and soft organic forms: Catmull-Clark subdivision, creased edges stay sharp. | `.mjs` only |
| `loft` | `.loft.json` or `.loft.mjs` with sections or revolved profiles | Taut, smooth bodies: hulls, fuselages, car bodies, barrels. | `.mjs` only |
| `grammar` | `.grammar.json`: an L-system or a split grammar | Rules instead of pieces: plants and branching things; buildings, shelves, fences. | no |
| `stack` | `.stack.json` naming PNG slices | Sprite stacking: draw horizontal slices in a pixel editor, keep every colour exact. | no |
| `splat` | `.ply` (Gaussian splats or a coloured point cloud), or `.splat.json` with settings | Real objects from photogrammetry or a splat trainer, turned into pixel art. | no |
| `crucible` | `.crucible.json`: a [Crucible](https://github.com/codepawl/crucible) scene recipe | Hard surfaces with bevels, holes and booleans as plain data: lathes, extrusions, curves, BMesh-style mesh edits. | no |
| `glb` | `.glb` or `.gltf`: a finished mesh, textured, vertex-coloured or with plain materials | Meshes made elsewhere: image-to-3D generators (TRELLIS.2, Hunyuan3D), photogrammetry, asset packs, other 3D tools. | no |
| `depth` | `.depth.json`: a drawn sprite plus a grey depth map, mirrored, flat or with a drawn back | Pixel first with relief: one picture says what it looks like, one how far each pixel stands out. | no |
| `terrain` | `.terrain.json`: a height picture or noise, colour bands, slope rock, water | Landscape tiles, islands, hills. | no |
| `level` | `.level.json`: a tile map and sectors with floor heights | Dungeons, interiors, town plans, in the manner of Wolfenstein's grids and Doom's sectors. | no |
| `vox` | `.json` with plans of letters and a colour per letter | Small props and characters at sprite size, exact colours. | no |
| `compose` | `.compose.json` listing parts from other engines and dioramas | The best tool for each part: a CAD hull, voxel markings, SDF sandbags. | per part |
| `paint` | `.paint.json` with brush strokes, dabs and scatters | Painterly trees, bushes, smoke, creatures, straight from splats. | no |
| `carve` | `.views.json` with orthographic views drawn as letter grids | Pixel first: draw how the sprite should read, get the solid that matches. | no |

The engine follows from the extension unless `engine` is given. `size`, `pixelSize`, `pixelStyle`, `shades`,
`overwrite`, `preview` and `frames` work the same for every engine (see [three-modeling.md](three-modeling.md#running-it)).

```bash
ink-agent call model_build '{"source":"/abs/examples/cadquery/tank.py","out":"/abs/studio/out/tank","size":6,"pixelSize":1}' --allow-code
```

Script engines (three.js, SDF, subdivision and loft scripts) re-read the script file on every build. A long-running
server (MCP) keeps modules the script imports cached, so after editing a helper module that a script imports, restart
the server or keep the model in one file.

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

## OpenSCAD

```openscad
PARTS = [["hull", "#5b6b2e", "olive"], ["tracks", "#2b2b2b", "track"]];   // name, colour, optional role
module part(name) {
  if (name == "hull") hull_shape();
  if (name == "tracks") for (s = [1, -1]) track(s);
}
if (is_undef(INK)) for (p = PARTS) color(p[1]) part(p[0]);              // what the OpenSCAD window shows
```

- Each part is rendered on its own to binary STL. `INK` is defined while rendering, so the preview line stays out of the
  parts. A file without `PARTS` is one grey part.
- OpenSCAD is found as `$INK_OPENSCAD`, `openscad` on the PATH or the macOS application. Recent development snapshots
  use the Manifold backend, which is many times faster on booleans than the 2021 release.
- Z up becomes Y up. Errors come back with the file and line in `hint`.
- [examples/openscad/tank.scad](../examples/openscad/tank.scad) uses `hull()` and `minkowski()` for soft edges.

## Distance functions as code

```js
export default ({ sdf }) => ({
  parts: [{ name: 'body', colour: '#5b6b2e', role: 'olive',
            field: sdf.smoothUnion(0.2, sdf.sphere(0.6), sdf.move(sdf.box([0.4, 0.2, 0.4]), [0, 0.6, 0])),
            bounds: [[-1, -1, -1], [1, 1.2, 1]] }] });
```

- `field` is a function of a point `[x, y, z]` (Y up), negative inside. `bounds` must hold the whole part, or the mesh is
  cut open at the box. `cells` (default 96) sets the meshing resolution along the longest side of all parts.
- [library/sdf.mjs](../library/sdf.mjs) has primitives (`sphere`, `box`, `roundBox`, `cylinder`, `capsule`, `torus`,
  `roundCone`, `ellipsoid`, `halfSpace`), combinations (`union`, `intersect`, `subtract` and their smooth forms, `round`,
  `shell`, `displace`), placement (`move`, `rotateX/Y/Z`, `scale`, `mirror`, `repeat`, `elongate`, `twist`, `bend`) and
  `noise`/`fbm`.
- Each field is meshed with the kit's implicit surface mesher and continues as a mesh part.
- [examples/sdf-code/tank.sdf.mjs](../examples/sdf-code/tank.sdf.mjs) builds a tank from 30 lines of functions.

## Subdivision cages

```json
{ "cages": [ { "name": "body", "colour": "#5b6b2e", "role": "olive", "levels": 3,
               "vertices": [[0, 0, 0], ...], "faces": [[0, 1, 2, 3], ...], "creases": [[0, 1], ...] } ] }
```

- A cage is a coarse polygon mesh (quads are best), faces counter-clockwise seen from outside. Each is subdivided
  `levels` times (default 3, at most 5) by Catmull-Clark; creased edges and the open borders stay sharp.
- A `.subd.mjs` script exports `({ cage }) => ({ cages })` and gets helpers: `cage.box(centre, half)`,
  `cage.prism(sides, radius, y0, y1, centre)`, `cage.outline(points, z0, z1)` (a 2D outline extruded, with its two
  `rings` to crease), `cage.ring(loop)` (crease pairs for a loop), `cage.extrude(mesh, faces, distance)` and
  `cage.map(mesh, f)`.
- Crease the outline loops of a flat-sided part and leave the rest smooth: the outline rounds, the faces stay flat.
- [examples/subd/tank.subd.mjs](../examples/subd/tank.subd.mjs) builds the tank from creased cages.

## Lofted surfaces

```json
{ "parts": [
    { "name": "hull", "axis": "x", "sections": [ { "at": -2.6, "rect": [0.6, 1.9], "round": 0.08, "centre": [1, 0] },
                                                 { "at": 0, "rect": [0.85, 2], "round": 0.08, "centre": [0.88, 0] },
                                                 { "at": 2.7, "ellipse": [0.15, 0.9] } ] },
    { "name": "barrel", "axis": "x", "at": [0, 1.6, 0], "revolve": [[0.12, 0.9], [0.085, 1.3], [0.085, 3.3]] } ] }
```

- A section is a closed ring across the axis: `points` [[up, across], ...], `ellipse` [half height, half width] or `rect`
  [height, width] with `round`, plus an optional `centre` [up, across]. Axis `x` has up = Y and across = Z; `y` has
  up = X, across = Z; `z` has up = Y, across = X.
- The surface is a uniform cubic B-spline, periodic around each ring and clamped along the sections, so it starts and
  ends exactly at the first and last; both ends are capped, so it is closed. `around` and `along` set the sampling.
- `revolve` turns a profile of [radius, position] points around the axis (through `at`).
- [examples/loft/tank.loft.json](../examples/loft/tank.loft.json) lofts the hull, tracks and turret and revolves the gun,
  cupola and wheels.

## Grammars

**L-systems** grow branching forms from an axiom and rewriting rules; a 3D turtle draws them and the result is painted
with splat strokes (see painting):

```json
{ "kind": "lsystem", "axiom": "FFA", "iterations": 4, "angle": 28, "step": 0.42, "width": 0.24, "seed": 5,
  "rules": { "A": [["F[&+AL][&-AL][^AL]/A", 0.6], ["F[&+AL][^-AL]\\A", 0.4]] },
  "shrink": { "step": 0.82, "width": 0.66 },
  "colours": { "wood": "#5a3a20", "leaf": "#4f7a2a" }, "wood": "wood", "leaf": { "colour": "leaf", "size": 0.22 } }
```

`F` draws forward, `f` moves, `+ -` turn, `& ^` pitch, `\ /` roll, `|` turns around, `[ ]` push and pop (each level
shrinks by `shrink`), `L` places a leaf. A rule is a string or a weighted list chosen by `seed`.

**Split grammars** (in the style of CGA shape grammars) divide boxes by rules until terminals emit geometry:

```json
{ "kind": "split", "axiom": "Lot", "size": [8, 7.5, 6], "colours": { "wall": "#c8b88a", "roof": "#8a3324", "glass": "#3a5a6a" },
  "rules": { "Lot": { "split": "y", "sizes": [3, 2.6, "~"], "into": ["Ground", "Floor", "Roof"] },
             "Floor": { "repeat": "x", "size": 2, "into": "Bay" },
             "Bay": [ { "box": "wall" }, { "inset": [0.5, 0.6, 0], "face": "front", "depth": 0.12, "into": "Window" } ],
             "Window": { "box": "glass" }, "Roof": { "roof": "gable", "colour": "roof", "overhang": 0.35 } } }
```

`split` divides along an axis (numbers are absolute, `"~"` and `"2~"` share what is left, `null` leaves a gap),
`repeat` fits as many parts of about `size` as fit, `inset` shrinks (with `face` and `depth` it makes a slab standing
proud of that face), `box` and `roof` (`gable` or `hip`) are terminals. Boxes become native box solids (exact, seamless),
roofs mesh parts. [examples/grammar/](../examples/grammar/) has a tree and a two-storey house.

## Sprite stacking

```json
{ "slices": "tank-slices.png", "slice": [50, 24], "cell": 0.125, "roles": { "#5b6b2e": "olive" } }
```

Slices are horizontal top-down pictures, bottom first: one sheet cut into `slice` [width, height] pieces (left to right,
top to bottom) or a list of files. In each, the top row is the back. Transparent pixels (or `background`) are empty;
every other colour stays exact, becomes a letter and a role (named by `roles`, else by its colour), and the stack
continues as a voxel model. [examples/stack/](../examples/stack/) stacks the voxel tank's 16 slices.

## Captures (Gaussian splats and point clouds)

```json
{ "ply": "capture.ply", "resolution": 56, "colours": 5, "up": "y", "opacity": 0.5, "fill": true, "close": 1,
  "hard": false, "crop": [[-1, 0, -1], [1, 2, 1]], "names": ["olive", "track", "steel", "dark-olive", "shade"] }
```

- The PLY is a 3DGS export (`f_dc_*` colours, `opacity`, `scale_*`) or a point cloud with `red`, `green`, `blue`;
  ascii and binary little endian are read. A `.ply` on its own uses the defaults.
- Points vote their colour into a grid of `resolution` blocks along the longest side (splats out to their size, at most
  two blocks). `opacity` drops faint splats, `crop` keeps a box, `up` says which way the capture's up points (many
  trainers write `-y`).
- `fill` makes the inside solid: gaps of up to `close` blocks in the shell are bridged first, then the outside grows
  back, so the size stays. Colours are reduced to `colours` families by k-means and named by `names`; the result
  continues as a voxel model (`hard: false` by default, so it reads as one soft solid).
- Captures come from your own photos (for example with OpenSplat, which runs on Apple GPUs) or any 3DGS trainer.
  [examples/splat/tank.ply](../examples/splat/tank.ply) is a stand-in: 28,000 points sampled from the CadQuery tank.

## Crucible recipes

[Crucible](https://github.com/codepawl/crucible) (MIT) is a 3D engine for agents whose scenes are JSON recipes. Its
recipe builder runs in Node without a browser, so `model_build` turns a `.crucible.json` straight into parts: no code
runs, and no code permission is needed. It is the data-only way to bevels, holes and booleans.

```json
{ "format": "crucible.scene", "schemaVersion": 1,
  "geometries": [
    { "id": "hull", "type": "extrude", "contour": [[-2.35, 0.45], [2.0, 0.45], [2.55, 0.8], [2.25, 1.1], [-2.3, 1.1]], "depth": 1.9, "bevel": 0.04 },
    { "id": "turret", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
      { "op": "transform_selection", "select": { "tag": "top" }, "scale": [0.78, 1, 0.8] },
      { "op": "inset_region", "select": { "tag": "top" }, "thickness": 0.12, "name": "roof" },
      { "op": "boolean", "operation": "union", "cutter": { "type": "cylinder" }, "scale": [0.06, 0.3, 0.05], "translation": [0.25, 0.55, -0.28] } ] },
    { "id": "wheel", "type": "cylinder", "segments": 24, "bevel": 0.03 } ],
  "materials": [{ "id": "olive", "color": [0.147, 0.195, 0.042] }],
  "nodes": [{ "id": "hull", "geometry": "hull", "material": "olive", "translation": [0, 0, -0.95] }] }
```

- Geometry types: `box` and `cylinder` (with `bevel`), `sphere`, `torus`, `lathe`, `extrude` (holes, bevel), `tube`,
  `curve` (Bezier with profile and taper, matched to Blender), `text`, `terrain`, and `mesh`: a base plus `edits`
  (extrude, inset, transform selections by tag, normal or box, booleans on Manifold, bevel, loop cuts, ...) and a
  modifier `stack`. Crucible's own docs (`node_modules/@codepawlhq/crucible/docs/agent-scene.md` and `mesh.md`) list
  every field.
- Sizes: a box is 1 across (-0.5 to 0.5), a cylinder has radius 1 and height 1 along Y, a sphere radius 1. Scale nodes
  accordingly: a wheel of radius 0.3 and width 0.12 is a cylinder with `scale: [0.3, 0.12, 0.3]`, turned onto Z.
- Nodes take `translation`, `rotation` (a quaternion `[x, y, z, w]`), `scale` and `parent`. Colours are linear RGB.
- Every mesh node becomes a part; its material id becomes its role. Vertex colours are kept; material patterns and image
  maps are not (the build warns).
- Crucible is an optional peer dependency, pinned because it changes its API between minor versions before 1.0:
  `npm install @codepawlhq/crucible@0.22.0 manifold-3d@3.5.4` (manifold-3d only for booleans). Without it the build
  fails with that command. [examples/crucible/tank.crucible.json](../examples/crucible/tank.crucible.json) is the tank.

## Finished meshes (glTF)

`model_build` reads a `.glb`, or a `.gltf` with its companion files in the same folder, node by node with the node
transforms of the default scene. Every triangle primitive becomes a part:

- **Textured or vertex-coloured**: the colour at each vertex (base colour factor × base colour texture × `COLOR_0`) goes
  in as a vertex colour, and the automatic mesh look clusters those colours into `hues` families (3 for textured
  models unless given: generated textures are mottled, and with six families every blotch gets its own). A vertex can only
  carry what the texture shows at that vertex, so textured triangles are split first until no edge is longer than about
  1.5 art pixels of the finished sprite (from `art`). A twelve-triangle crate keeps its painted planks; a dense
  generated mesh is left almost as it is. Splitting stops at 2 million triangles, with a warning. Each vertex then takes
  the texture averaged over its triangles and over half an art pixel around it, so a 4K map on a dense mesh does not
  come back as speckle.
- **Plain material**: one palette role, named after the material, as with the other mesh engines.

`colourSpace` says how textures store colour: glTF says sRGB (the default), but trellis2mlx writes TRELLIS.2's linear
albedo straight into its PNGs, which reads far too dark as sRGB, so pass `"linear"` for its output. `yaw` turns the model
about the up axis first (radians), for generators that face their output another way. `"yaw": "auto"` with `reference`
(the picture the generator was given) turns it for you: the model's silhouette, seen from the generated camera at a
range of turns and heights, is matched against the picture's silhouette (scaled to the same area, centred on the centre
of mass), first in 15 degree steps, then in 3. It takes a few seconds; the result reports the turn and how well the
silhouettes overlap, and warns below 60%.

Textures must be PNG: trellis2mlx, trimesh and Blender's exporter write PNG by default. Draco or meshopt compressed
meshes and JPEG, WebP or KTX2 textures are refused with a hint to export again. Open meshes (holes left by a generator)
bake as sheets with thickness; the build warns about them.

Image-to-3D generators are the main source: a picture of the object goes in, a textured mesh comes out, and this
engine turns it into pixel art. They redraw the surface rather than copy the picture, so give them softly lit,
shaded pictures on a transparent background; flat vector art tends to come back dark. On Apple Silicon,
[trellis2mlx](https://github.com/lyonsno/trellis2mlx) runs TRELLIS.2 locally (MIT code and weights, plus Meta's gated
DINOv3 encoder).

```bash
ink-agent call model_build '{"source":"/abs/generated/lantern.glb","out":"/abs/studio/out/lantern","size":2,"colourSpace":"linear","yaw":"auto","reference":"/abs/generated/lantern.png"}'
```

[examples/glb/tank-trellis.glb](../examples/glb/tank-trellis.glb) is a trellis2mlx preview (512, 8 steps, 68 s on an M5
Ultra, 18 GB peak) made from [a render of the three.js tank](../examples/glb/tank-trellis-input.png); it is the TRELLIS.2
entry in the method comparison (`colourSpace: "linear"`, `yaw: "auto"`). For pixel art at the default `art` of 128, the 512 preview is enough: a
768 cascade with 4K maps (about 2 minutes, 33 to 41 GB peak) gives finer geometry that the sprite cannot show, and its
paler colours drift towards khaki. At `art` 256 the detail run pays off: noise 0.144 against 0.185 for the preview,
close to the hand-written three.js tank's 0.135. TRELLIS.2 does not face its output the same way every time, so use
`yaw: "auto"` with the input picture.

## Depth maps (layered depth)

```json
{ "image": "tank-front.png", "depth": "tank-front-depth.png", "layers": 12, "cell": 0.125,
  "back": { "image": "tank-back.png", "depth": "tank-back-depth.png" },
  "roles": { "#5b6b2e": "olive" } }
```

Every opaque pixel becomes a column of blocks along z. The front depth (white near, unless `whiteNear: false`) says how
far it stands out, in `layers` steps; `back` closes it: `"flat"` (a relief on a plate), `"mirror"` (the same behind, for
round things) or its own picture and depth seen from behind, a second layer as in layered depth images (Shade et al.,
1998). Colours stay exact (or `colours: n` reduces them); `roles` names them. Carving needs silhouettes only and fills
hollows; depth maps say where the surface is, so they show dents and relief from one side. The CLI's `depth` command
is the other way in: it turns a photo-like depth map into a lit relief mesh. [examples/depth/](../examples/depth/) has
a tank drawn front and back.

## Terrain from height maps

```json
{ "height": { "noise": { "seed": 7, "size": [56, 56], "scale": 0.075, "octaves": 5, "island": 0.9 } },
  "levels": 14, "water": 0.22,
  "bands": [ { "below": 0.3, "colour": "#d8c890", "role": "sand" }, { "below": 0.62, "colour": "#5f8f3a", "role": "grass" },
             { "below": 1.01, "colour": "#e8ecef", "role": "snow" } ],
  "slope": { "above": 2, "colour": "#7a7470", "role": "rock" }, "soil": { "colour": "#6a4a30", "role": "soil" } }
```

`height` is a grey picture (white high, transparent pixels empty) or seeded noise (`island` sinks the edges into the
sea). Heights 0..1 map to `levels` blocks; a column's top takes the band of its height, or `slope` rock where it rises
more than `slope.above` blocks over a neighbour; below it is soil; water fills up to `water`. A heightfield cannot
overhang (edit the written voxel model for caves). The camera looks down at 0.6 unless `camera` says otherwise.
[examples/terrain/island.terrain.json](../examples/terrain/island.terrain.json).

## Levels from plans (2.5D)

```json
{ "tile": 1, "block": 0.25, "wall": 2.5,
  "tiles": { "#": { "wall": true, "colour": "#7a6a58", "role": "stone" }, ".": { "floor": 0, "colour": "#5a4a3a" },
             "=": { "floor": 0.75, "colour": "#8a7a68" }, "+": { "door": 1.75, "colour": "#7a6a58", "floorColour": "#5a4a3a" },
             "~": { "floor": -0.5, "liquid": -0.1, "colour": "#4a3a2a", "liquidColour": "#3a6a9a" } },
  "map": [ "#######", "#..=..#", "#~~+..#", "#######" ],
  "sectors": [ { "points": [[7, 0], [11, 0], [11, 4], [7, 4]], "floor": 0, "colour": "#6a7a4a", "walls": 1 } ] }
```

Tiles are `tile` metres square, built from blocks `block` metres across. Walls rise to `wall` (or their own `height`),
floors are slabs topped at `floor` (steps and platforms are higher floors), doors are walls with an opening up to
`door`, liquids fill a sunken floor up to `liquid`. Map rows run from the back to the front. Sectors are polygons on the
ground in metres with a floor height and, with `walls`, walls along their edges, drawn over the tiles in order. The
camera looks down at 1.0 so rooms read from above. [examples/level/dungeon.level.json](../examples/level/dungeon.level.json).

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

## The parts library

Tested, parametric parts so models start from pieces that already read well at sprite size, instead of from scratch each
time. Each part builds closed (checked by `tests/parts-library.test.js`).

| Part | CadQuery (`from inkparts import ...`) | three.js (`parts.<name>(options, material)`) |
| --- | --- | --- |
| Rounded box | `rounded_box(length, width, height, radius)` | `roundedBox({ length, width, height, radius })` |
| Road wheel with hub | `road_wheel(radius, width, hub, rim)` | `roadWheel({ radius, width, hub })` |
| Track loop with pads | `track_loop(length, height, width, pad_pitch, pad_depth)` | `trackLoop({ length, height, width })` |
| Barrel, sleeve, brake | `barrel(length, radius, brake, sleeve)` | `barrel({ length, radius, brake, sleeve })` |
| Hatch on a ring | `hatch(radius, thickness, ring)` | `hatch({ radius, thickness, ring })` |
| Crate with rails | `crate(length, width, height, frame)` | `crate({ length, width, height, frame })` |
| Door or window panel | `panel(width, height, depth, frame, inset)` | `panel({ width, height, depth, frame, inset })` |
| Bolt ring | `bolt_ring(radius, count, bolt, height)` | |

CadQuery parts are Z up ([library/inkparts.py](../library/inkparts.py)); three.js parts are Y up and named
([library/ink-parts.mjs](../library/ink-parts.mjs)). Each file documents where every part sits. Add a part with a test
when a model needed it and it came out well.

## Painting with splats

```json
{ "colours": { "bark": "#5a3a20", "leaf": { "colour": "#4f7a2a", "role": "leaf" } },
  "blend": 0.08,
  "strokes": [
    { "colour": "bark", "points": [[0, 0, 0], [0.05, 1, 0], [0, 2, 0.05]], "width": 0.4, "taper": [1, 0.45] },
    { "colour": "leaf", "dab": [0, 2.5, 0], "r": [1, 0.75, 0.95] },
    { "colour": "leaf", "scatter": { "around": [0, 2.8, 0.2], "radius": 0.9, "count": 26, "size": [0.18, 0.3], "seed": 7, "flatten": 0.6 } } ] }
```

- A stroke is a tube along its points: `width`, `depth` (a flat brush when smaller), `taper` [start, end] and `pressure`
  per point. A dab is a ball (`r` a number or [x, y, z]). A scatter places `count` dabs inside a ball by its `seed`;
  `flatten` below 1 squashes it vertically.
- Strokes of one colour melt into each other (`blend` is the softness); different colours meet with a hard edge. Every
  colour becomes a role with its own ramp.
- The diorama is the model; there is no mesh hand-off (mesh it with `scene_export` to compare).
- [examples/paint/tree.paint.json](../examples/paint/tree.paint.json) paints a tree in four colours.

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

- `params` are JSON pointers to numbers with a range; `paths` moves several fields that share a value together (the
  same height on several parts), `step` rounds values (cells, counts). Mirrored parts at +x and -x need one param each.
  A start value outside the range is an error.
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

## Resolution and live tuning

Two settings decide how fine the result reads, and they belong together:

- The **art resolution**: render size divided by `pixelSize`. A 128 × 128 render with `pixelSize: 1` is a 128-pixel
  sprite; the default `pixelSize` of 2 halves it.
- The **splat spacing**, `finish.res` (the renderer's default is 0.09 scene units). For a model a few units long that is
  coarser than a pixel already at 128 pixels, and at higher resolutions it shows as blotchy shading on large flat faces.
  `model_build` sets `finish.res` to the model size over `art` (default 128).

On the CadQuery tank at 384 pixels, noise fell from 0.085 with the default spacing to 0.075 with matched spacing, and
the flat faces lost their blotches; from 128 to 384 pixels it fell from 0.18 to 0.075. `node scripts/resolution-sweep.js`
renders every compared model at 64, 96, 128, 192 and 384 pixels with matched spacing; `/tools/sweep.html` shows them
side by side. Dioramas that set `res` on their solids keep those values.

### How much input detail a sprite wants

`node scripts/detail-sweep.js [art]` measured it on the CadQuery tank at 128 × 96 art pixels, where the tank is about
85 pixels wide. Fidelity is silhouette overlap and colour agreement with a reference render of the mesh at a fine field
and spacing (the mesh rows therefore start with an advantage; compare rows within each table).

| Voxelised at (blocks along the longest side) | 20 | 35 | 50 | 70 | 100 | 128 | 160 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Art pixels per block | 4.2 | 2.4 | 1.7 | 1.2 | 0.85 | 0.66 | 0.53 |
| Silhouette, three-quarter / side | 0.88 / 0.74 | 0.92 / 0.79 | 0.91 / 0.90 | 0.93 / 0.90 | 0.93 / 0.84 | 0.93 / 0.92 | 0.93 / 0.87 |
| Colour agreement, three-quarter / side | 0.44 / 0.51 | 0.63 / 0.74 | 0.66 / 0.77 | 0.70 / 0.81 | 0.61 / 0.60 | 0.51 / 0.66 | 0.48 / 0.60 |

| Mesh (CadQuery), field cells and splat spacing | 48, 1 px | 96, 1 px | 96, 2 px | 128, 0.5 px | 192, 0.5 px |
| --- | --- | --- | --- | --- | --- |
| Silhouette, three-quarter / side | 0.95 / 0.98 | 0.99 / 0.99 | 0.96 / 0.77 | 0.99 / 1.00 | 1.00 / 1.00 |
| Colour agreement, three-quarter / side | 0.82 / 0.91 | 0.91 / 0.92 | 0.82 / 0.74 | 0.94 / 0.93 | 0.97 / 0.97 |

- Grids: about 1.2 to 1.7 art pixels per block was best. Finer grids (one block per pixel or less) added nothing to the
  silhouette and lost colour agreement, because parts smaller than a pixel blend; much coarser grids lose shape. Plan
  the grid from the pixels the object will span, not from the image size: for an object 85 pixels wide, 50 to 70 blocks.
- Meshes: field cells at or above the object's pixel width (96 here) and splats one pixel apart hold the shape; half a
  pixel adds a little colour fidelity for twice the splats; two pixels clearly loses it.
- Noise alone misleads: the coarsest grid had the least noise because it is made of big flat blocks.

`model_build` applies this by default from `art`, the sprite width in art pixels (default 128): the model is taken to
span about two thirds of it at the generated camera (85 of 128), mesh engines get about that many field cells (`cells`
97 at 128, 195 at 256), splats are placed about a pixel apart (`finish.res`), captures are binned at about 1.4 pixels per
block, and grid engines (voxels, carving, stacking, depth, terrain, levels) report `detail.pixelsPerBlock` with a
warning and a suggested block count when it falls below 1 or above 2.5. Pass `cells` to override the field; a source's
own grid is never changed.

`/tools/tune.html` (with `npm run serve`) changes the finished result live with sliders: art resolution, zoom and camera
re-render the baked scene (about 0.1 to 0.3 s); splat spacing, shade steps, ramp and palette dithering, edge hardness,
sun direction and height, ambient and sky bake a variant (about 0.5 to 1 s) that stays cached, so going back is
instant. Save writes the settings as `<scene>.tuned.json` next to the scene. `?scene=/path/scene.json` opens any JSON
diorama in the repository.

`/tools/compare.html` has the same sliders behind "Tune the baked results": every method's baked image is rendered
again with one set of settings, visible rows first, each row with its tuned numbers and a link into the tuner. "Baked
camera follows the 3D view" turns the baked renders to the angle of the 3D viewers. The server bakes in a pool of worker
threads (`TUNE_WORKERS`, default up to 12), one scene per worker so its variants stay cached; on 36 cores a first pass
over the sixteen compared scenes at 256 pixels took about 36 s, a camera change about 4 s. "Auto spacing in pixels" set
to 2 bakes about four times fewer splats: a full pass then took 20 s, at a small cost in noise on mesh models.

## Comparing methods

`node scripts/compare-models.js` builds a model with every method from the examples (fourteen tanks, plus a painted tree, an island, a dungeon,
an L-system tree and a split-grammar house for the methods made for other subjects) and writes
`studio/out/compare-models/manifest.json`. `npm run serve` and `http://127.0.0.1:8765/tools/compare.html` then show one
row per method: what it is and who wrote it, the extracted `model.glb` in one shared viewer (drag any to turn them all),
the baked result from four sides, and the numbers for both. Methods that hand off no mesh (SDF dioramas, compositions,
paintings, L-systems) are meshed with `scene_export` for the viewer; their baking uses the scene itself. A config file
(`node scripts/compare-models.js my-methods.json out-dir`) compares your own sources; `model_rank` writes the same kind of
manifest for candidates of one brief.
