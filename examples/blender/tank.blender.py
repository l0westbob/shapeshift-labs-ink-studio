"""A small tank modelled with Blender's Python API, for model_build (engine "blender"). Blender is Z up: X runs forward,
Y across, Z up; units are metres. Modifiers do the work: bevels soften every edge, an array and a mirror place the road
wheels, a subdivision rounds the cupola. Materials carry the colour and a "role" property."""
import math

import bmesh
import bpy


def material(name, hex_colour, role):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    srgb = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*linear, 1)
    mat["role"] = role
    return mat


OLIVE = material("olive", "#5b6b2e", "olive")
DARK = material("dark-olive", "#3f4a22", "dark-olive")
TRACK = material("track", "#2b2b2b", "track")
STEEL = material("steel", "#777b72", "steel")


def finish(ob, mat, bevel=0.0, segments=2, subdivide=0):
    ob.data.materials.append(mat)
    if bevel:
        mod = ob.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
    if subdivide:
        ob.modifiers.new("subdivide", "SUBSURF").levels = subdivide
    return ob


def prism(name, outline_xz, width, y=0.0):
    """a closed solid from an outline in the XZ plane, extruded across Y"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    front = [bm.verts.new((x, y - width / 2, z)) for x, z in outline_xz]
    back = [bm.verts.new((x, y + width / 2, z)) for x, z in outline_xz]
    bm.faces.new(front[::-1])
    bm.faces.new(back)
    n = len(outline_xz)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(ob)
    return ob


def stadium(length, height, cx, cz, segments=12):
    r = height / 2
    pts = []
    for i in range(segments + 1):
        a = -math.pi / 2 + math.pi * i / segments
        pts.append((cx + length / 2 - r + r * math.cos(a), cz + r * math.sin(a)))
    for i in range(segments + 1):
        a = math.pi / 2 + math.pi * i / segments
        pts.append((cx - length / 2 + r + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def build():
    hull = prism("hull", [(-2.55, 0.45), (2.15, 0.45), (2.7, 0.92), (2.25, 1.3), (-2.45, 1.3), (-2.65, 1.02)], 2.0)
    finish(hull, OLIVE, bevel=0.06)

    for side in (1, -1):
        track = prism("track-left" if side > 0 else "track-right", stadium(5.15, 0.92, 0, 0.47), 0.54, y=side * 1.25)
        finish(track, TRACK, bevel=0.04)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0.05, side * 1.31, 1.03))
        fender = bpy.context.object
        fender.name = "fender-left" if side > 0 else "fender-right"
        fender.scale = (5.1, 0.62, 0.06)
        finish(fender, DARK, bevel=0.02)

    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.31, depth=0.1, location=(-1.9, 1.53, 0.43), rotation=(math.pi / 2, 0, 0))
    wheels = bpy.context.object
    wheels.name = "wheels"
    finish(wheels, STEEL, bevel=0.02)
    array = wheels.modifiers.new("array", "ARRAY")
    array.count = 6
    array.use_relative_offset = False
    array.use_constant_offset = True
    array.constant_offset_displace = (0.75, 0, 0)
    mirror = wheels.modifiers.new("mirror", "MIRROR")
    mirror.use_axis = (False, True, False)
    mirror.mirror_object = hull
    wheels.modifiers.move(wheels.modifiers.find("bevel"), 2)

    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=1.0, depth=0.6, location=(-0.35, 0, 1.6))
    turret = bpy.context.object
    turret.name = "turret"
    turret.scale = (1.15, 0.95, 1)
    for v in turret.data.vertices:
        if v.co.z > 0:
            v.co.x *= 0.78
            v.co.y *= 0.78
    finish(turret, OLIVE, bevel=0.08, segments=3)

    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.75, 0, 1.6))
    mantlet = bpy.context.object
    mantlet.name = "mantlet"
    mantlet.scale = (0.35, 0.8, 0.42)
    finish(mantlet, DARK, bevel=0.1, segments=4)

    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.085, depth=2.5, location=(2.15, 0, 1.6), rotation=(0, math.pi / 2, 0))
    finish(bpy.context.object, DARK).name = "barrel"
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.13, depth=0.32, location=(3.46, 0, 1.6), rotation=(0, math.pi / 2, 0))
    finish(bpy.context.object, DARK, bevel=0.03).name = "muzzle-brake"

    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.3, depth=0.2, location=(-0.7, 0.35, 1.98))
    finish(bpy.context.object, DARK, bevel=0.04).name = "cupola"
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.22, location=(-0.7, 0.35, 2.08))
    hatch = bpy.context.object
    hatch.name = "hatch"
    hatch.scale = (1, 1, 0.35)
    finish(hatch, STEEL, subdivide=1)

    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.0, 0, 1.36))
    deck = bpy.context.object
    deck.name = "engine-deck"
    deck.scale = (0.5, 1.4, 0.12)
    finish(deck, DARK, bevel=0.03)
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.015, depth=1.1, location=(-1.2, -0.55, 2.43))
    finish(bpy.context.object, STEEL).name = "antenna"

    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(40), 0, math.radians(-30)))
