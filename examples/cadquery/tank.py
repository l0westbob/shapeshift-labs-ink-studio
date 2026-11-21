"""A small tank modelled with CadQuery, for model_build (engine "cadquery"). CAD is Z up: X runs forward, Y across,
Z up; units are metres. Parts are named, coloured and given a role in an assembly, so each becomes its own mesh solid
and every role its own palette ramp."""
import cadquery as cq

OLIVE = dict(color=cq.Color("#5b6b2e"), metadata={"role": "olive"})
DARK = dict(color=cq.Color("#3f4a22"), metadata={"role": "dark-olive"})
TRACK = dict(color=cq.Color("#2b2b2b"), metadata={"role": "track"})
STEEL = dict(color=cq.Color("#777b72"), metadata={"role": "steel"})


def hull():
    # side profile with a sloped glacis and rear plate, extruded across, edges softened
    profile = [(-2.55, 0.45), (2.15, 0.45), (2.7, 0.92), (2.25, 1.3), (-2.45, 1.3), (-2.65, 1.02)]
    body = cq.Workplane("XZ").polyline(profile).close().extrude(1.0, both=True)
    return body.edges("|Y").fillet(0.05).faces(">Z").edges().chamfer(0.06)


def fender(side):
    return cq.Workplane().box(5.1, 0.62, 0.06).edges("|Z").fillet(0.05).translate((0.05, side * 1.31, 1.03))


def track(side):
    # a stadium loop with tread pads cut into its outer face
    loop = cq.Workplane("XZ").slot2D(5.15, 0.92).extrude(0.27, both=True).faces("<Y or >Y").edges().fillet(0.04)
    loop = loop.translate((0, side * 1.25, 0.47))
    pads = cq.Workplane().rarray(0.24, 1, 20, 1).box(0.07, 0.62, 0.06).translate((0, side * 1.25, 0.94))
    return loop.cut(pads)


def wheel(x, side):
    face = side * 1.53
    disc = cq.Workplane("XZ").circle(0.31).extrude(0.05, both=True).edges().fillet(0.02)
    hub = cq.Workplane("XZ").circle(0.11).extrude(0.08, both=True)
    return disc.union(hub).translate((x, face, 0.43))


def turret():
    base = cq.Workplane().rect(2.1, 1.75).workplane(offset=0.58).rect(1.55, 1.3).loft()
    base = base.edges("not(>Z or <Z)").fillet(0.16).faces(">Z").edges().fillet(0.05)
    return base.translate((-0.35, 0, 1.3))


def mantlet():
    return cq.Workplane().box(0.35, 0.8, 0.42).edges("|Y and >X").fillet(0.12).translate((0.75, 0, 1.6))


def barrel():
    tube = cq.Workplane("YZ").circle(0.085).extrude(2.5).translate((0.9, 0, 1.6))
    brake = cq.Workplane("YZ").circle(0.13).extrude(0.32).translate((3.3, 0, 1.6)).edges().chamfer(0.03)
    sleeve = cq.Workplane("YZ").circle(0.12).extrude(0.45).translate((0.9, 0, 1.6))
    return tube.union(brake).union(sleeve)


def cupola():
    ring = cq.Workplane().circle(0.3).extrude(0.18).edges(">Z").fillet(0.05).translate((-0.7, 0.35, 1.88))
    hatch = cq.Workplane().circle(0.22).extrude(0.05).edges(">Z").fillet(0.02).translate((-0.7, 0.35, 2.06))
    return ring, hatch


def build():
    assy = cq.Assembly(name="tank")
    assy.add(hull(), name="hull", **OLIVE)
    for side, label in ((1, "left"), (-1, "right")):
        assy.add(fender(side), name="fender-" + label, **DARK)
        assy.add(track(side), name="track-" + label, **TRACK)
        for i, x in enumerate((-1.9, -1.15, -0.4, 0.35, 1.1, 1.85)):
            assy.add(wheel(x, side), name="wheel-%s-%d" % (label, i + 1), **STEEL)
    assy.add(turret(), name="turret", **OLIVE)
    assy.add(mantlet(), name="mantlet", **DARK)
    assy.add(barrel(), name="barrel", **DARK)
    ring, hatch = cupola()
    assy.add(ring, name="cupola", **DARK)
    assy.add(hatch, name="hatch", **STEEL)
    assy.add(cq.Workplane().box(0.5, 1.4, 0.12).edges("|Z").fillet(0.04).translate((-2.0, 0, 1.36)), name="engine-deck", **DARK)
    assy.add(cq.Workplane().circle(0.015).extrude(1.1).translate((-1.2, -0.55, 1.88)), name="antenna", **STEEL)
    return assy
