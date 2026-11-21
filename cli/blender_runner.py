"""Runs a Blender Python script for ink-studio and writes its meshes as JSON triangles.

    blender -b --factory-startup --python blender_runner.py -- SCRIPT OUT.json

The scene starts empty. The script builds objects with bpy (it may also define build(), which is then called). Every
visible mesh, curve, surface, metaball or text object is evaluated with its modifiers (bevel, subdivision, mirror, array,
boolean, ...) and written in world space, split by material: one part per object and material. A part is named after
its object (plus the material when an object has several) and takes its colour from the material's Principled BSDF base
colour (or its viewport colour) and its role from the material's custom property "role", else the material name.

Blender is Z up; ink-studio is Y up, so (x, y, z) is written as (x, z, -y). The first sun lamp becomes the diorama's sun."""

import json
import runpy
import sys

import bpy


def srgb(channel):
    channel = max(0.0, min(1.0, channel))
    return channel * 12.92 if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055


def colour_of(material):
    if material is None:
        return None
    rgba = None
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                rgba = node.inputs["Base Color"].default_value
                break
    if rgba is None:
        rgba = material.diffuse_color
    r, g, b = (round(srgb(c) * 255) for c in rgba[:3])
    return (r << 16) | (g << 8) | b


def role_of(material):
    if material is None:
        return None
    return material.get("role") or material.name


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    script, out_file = args[0], args[1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scope = runpy.run_path(script, init_globals={"bpy": bpy}, run_name="__ink_studio__")
    if callable(scope.get("build")):
        scope["build"]()

    depsgraph = bpy.context.evaluated_depsgraph_get()
    parts, warnings, sun = [], [], None
    for ob in bpy.context.scene.objects:
        if ob.hide_render or ob.hide_get():
            continue
        if ob.type == "LIGHT" and ob.data.type == "SUN" and sun is None:
            d = ob.matrix_world.to_3x3() @ __import__("mathutils").Vector((0, 0, 1))
            d.normalize()
            sun = [round(d.x, 4), round(d.z, 4), round(-d.y, 4)]
            continue
        if ob.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
            continue
        evaluated = ob.evaluated_get(depsgraph)
        try:
            mesh = evaluated.to_mesh()
        except RuntimeError:
            continue
        if mesh is None:
            continue
        mesh.calc_loop_triangles()
        matrix = ob.matrix_world
        world = [matrix @ v.co for v in mesh.vertices]
        by_material = {}
        for tri in mesh.loop_triangles:
            by_material.setdefault(tri.material_index, []).append(tri.vertices[:])
        slots = [slot.material for slot in evaluated.material_slots]
        for index, triangles in by_material.items():
            material = slots[index] if index < len(slots) else None
            used = sorted({v for t in triangles for v in t})
            remap = {v: i for i, v in enumerate(used)}
            pos = []
            for v in used:
                p = world[v]
                pos += [round(p.x, 6), round(p.z, 6), round(-p.y, 6)]
            name = ob.name if len(by_material) == 1 or material is None else ob.name + "-" + material.name
            parts.append({
                "name": name,
                "colour": colour_of(material),
                "role": role_of(material),
                "pos": pos,
                "index": [remap[v] for t in triangles for v in t],
            })
        evaluated.to_mesh_clear()
    if not parts:
        warnings.append("the scene has no visible mesh objects")
    with open(out_file, "w") as handle:
        json.dump({"parts": parts, "warnings": warnings, "sun": sun, "blender": bpy.app.version_string}, handle)


try:
    main()
except SystemExit:
    raise
except BaseException:
    import traceback

    traceback.print_exc()
    sys.exit(1)
