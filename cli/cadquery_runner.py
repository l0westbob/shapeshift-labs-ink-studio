"""Runs a CadQuery (or build123d) script for ink-studio and writes its parts as JSON triangles.

    python cadquery_runner.py SCRIPT OUT.json [TOLERANCE]

The script makes the model in any of these ways (the first that applies wins):
    def build(): return model          a function returning the model
    result = model                     a global called result
    show_object(model, name, options)  calls, as in CQ-editor; options may hold {"color": ...}

A model is a cq.Assembly (names, colours, locations and metadata={"role": ...} are kept), a Workplane, a Shape, a
build123d object, a list of those, or a dict {name: model | (model, colour) | {"shape", "color", "role"}}. Colours are
"#rrggbb", 0xrrggbb, a CSS or OCC colour name, an (r, g, b) tuple in 0..1, or a cq.Color.

CAD is Z up; ink-studio is Y up, so (x, y, z) is written as (x, z, -y). TOLERANCE is the largest chord error of the
triangles, as a share of the model's size (default 0.0015)."""

import json
import math
import runpy
import sys


def colour_of(value, cq):
    """sRGB 0xrrggbb, or None"""
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("#"):
        return int(value[1:7], 16)
    if isinstance(value, (tuple, list)):
        r, g, b = (float(c) for c in value[:3])
        if max(r, g, b) > 1:
            r, g, b = r / 255, g / 255, b / 255
        return (round(r * 255) << 16) | (round(g * 255) << 8) | round(b * 255)
    if isinstance(value, str):
        value = cq.Color(value)
    if hasattr(value, "toTuple"):
        return colour_of(value.toTuple(), cq)
    raise ValueError("not a colour: %r" % (value,))


def shapes_of(obj, cq):
    """the OCC shapes inside a Workplane, Shape, build123d object or list"""
    if obj is None:
        return []
    if isinstance(obj, (list, tuple)):
        return [s for item in obj for s in shapes_of(item, cq)]
    if isinstance(obj, cq.Workplane):
        return [s for v in obj.vals() for s in shapes_of(v, cq)]
    if isinstance(obj, cq.Shape):
        return [obj]
    wrapped = getattr(obj, "wrapped", None)
    if wrapped is not None:
        return [cq.Shape.cast(wrapped)]
    raise TypeError("not a shape: %s" % type(obj).__name__)


def parts_of(model, cq, name="", colour=None, role=None):
    """(name, shape, colour, role) for every shape, with assembly locations applied"""
    out = []
    if isinstance(model, cq.Assembly):

        def walk(assy, loc, inherited, path):
            here = loc * assy.loc if assy.loc is not None else loc
            col = colour_of(assy.color, cq) if assy.color is not None else inherited
            meta = getattr(assy, "metadata", None) or {}
            material = getattr(assy, "material", None)
            role_name = meta.get("role") or getattr(material, "name", None)
            if assy.obj is not None:
                for shape in shapes_of(assy.obj, cq):
                    out.append((assy.name or path, shape.moved(here), col, role_name))
            for child in assy.children:
                walk(child, here, col, child.name)

        walk(model, cq.Location(), colour_of(colour, cq), name)
        return out
    if isinstance(model, dict) and not ("shape" in model and len(model) <= 3):
        for key, value in model.items():
            out += parts_of(value, cq, str(key), colour, role)
        return out
    if isinstance(model, dict):
        return parts_of(model["shape"], cq, name, model.get("color", colour), model.get("role", role))
    if isinstance(model, tuple) and len(model) == 2 and not hasattr(model[1], "wrapped") and not isinstance(model[1], cq.Workplane):
        return parts_of(model[0], cq, name, model[1], role)
    if isinstance(model, list):
        for i, item in enumerate(model):
            out += parts_of(item, cq, name or "part-%d" % (i + 1), colour, role)
        return out
    label = getattr(model, "label", "") or name
    col = colour if colour is not None else getattr(model, "color", None)
    return [(label, shape, colour_of(col, cq), role) for shape in shapes_of(model, cq)]


def main():
    script, out_file = sys.argv[1], sys.argv[2]
    tolerance = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0015
    import os

    import cadquery as cq

    # the parts library (library/inkparts.py) is importable from every script
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "library"))
    shown = []

    def show_object(obj, name=None, options=None, **_):
        options = options or {}
        shown.append({"shape": obj, "color": options.get("color"), "role": options.get("role"), "name": name})

    scope = runpy.run_path(script, init_globals={"cq": cq, "show_object": show_object}, run_name="__ink_studio__")
    if callable(scope.get("build")):
        model = scope["build"]()
    elif "result" in scope:
        model = scope["result"]
    elif shown:
        model = {item["name"] or "part-%d" % (i + 1): item for i, item in enumerate(shown)}
    else:
        raise SystemExit("The script makes no model: define build(), set result, or call show_object()")

    parts = parts_of(model, cq)
    if not parts:
        raise SystemExit("The model has no shapes")
    box = cq.Compound.makeCompound([shape for _, shape, _, _ in parts]).BoundingBox()
    size = max(box.xlen, box.ylen, box.zlen) or 1
    result, warnings = [], []
    for name, shape, colour, role in parts:
        if not shape.isValid():
            warnings.append("%s: the shape is not valid; it may bake with holes" % (name or "a part"))
        vertices, triangles = shape.tessellate(tolerance * size, 0.2)
        if not triangles:
            continue
        pos = []
        for v in vertices:
            pos += [v.x, v.z, -v.y]
        result.append({
            "name": name,
            "colour": colour,
            "role": role,
            "pos": [round(p, 6) for p in pos],
            "index": [i for t in triangles for i in t],
        })
    with open(out_file, "w") as handle:
        json.dump({"parts": result, "warnings": warnings, "cadquery": cq.__version__}, handle)


if __name__ == "__main__":
    main()
