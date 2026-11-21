"""Reusable, tested parts for CadQuery models (model_build engine "cadquery"). A script imports them directly:

    from ink_parts import road_wheel, track_loop, barrel, hatch, crate, panel, rounded_box

Every function returns a closed cq.Workplane in metres, Z up, centred as documented, so parts can be placed with
.translate() and added to an Assembly. tests/parts-library.test.js builds each one and checks it is closed. Sizes are
the visible dimensions; small details are kept large enough to survive at sprite size (about one art pixel at 6 m across
and 128 px)."""
import math

import cadquery as cq


def rounded_box(length, width, height, radius=0.05):
    """a box with every edge rounded, centred on the origin"""
    radius = min(radius, 0.45 * min(length, width, height))
    return cq.Workplane().box(length, width, height).edges().fillet(radius)


def road_wheel(radius=0.31, width=0.1, hub=0.35, rim=0.04):
    """a wheel facing Y with a raised hub and a rolled rim, centred on the origin"""
    disc = cq.Workplane("XZ").circle(radius).extrude(width / 2, both=True).edges().fillet(min(rim, width * 0.4))
    cap = cq.Workplane("XZ").circle(radius * hub).extrude(width / 2 + 0.03, both=True).faces(">Y or <Y").edges().fillet(0.01)
    return disc.union(cap)


def track_loop(length=5.15, height=0.92, width=0.54, pad_pitch=0.24, pad_depth=0.06):
    """a tank track as a stadium loop along X, facing Y, its bottom at z = 0, with tread pads cut into the top run"""
    loop = cq.Workplane("XZ").slot2D(length, height).extrude(width / 2, both=True).faces("<Y or >Y").edges().fillet(min(0.04, width * 0.1))
    loop = loop.translate((0, 0, height / 2))
    count = max(1, int((length - height) / pad_pitch))
    pads = cq.Workplane().rarray(pad_pitch, 1, count, 1).box(pad_pitch * 0.3, width * 1.2, pad_depth).translate((0, 0, height - pad_depth / 3))
    return loop.cut(pads)


def barrel(length=2.5, radius=0.085, brake=True, sleeve=True):
    """a gun barrel along +X starting at the origin, with an optional sleeve at the base and a muzzle brake at the end"""
    tube = cq.Workplane("YZ").circle(radius).extrude(length)
    if sleeve:
        tube = tube.union(cq.Workplane("YZ").circle(radius * 1.45).extrude(length * 0.18))
    if brake:
        tube = tube.union(cq.Workplane("YZ").circle(radius * 1.55).extrude(length * 0.13).translate((length * 0.92, 0, 0)).edges().chamfer(radius * 0.3))
    return tube


def hatch(radius=0.25, thickness=0.06, ring=0.05):
    """a round hatch on a ring, its bottom at z = 0"""
    base = cq.Workplane().circle(radius + ring).extrude(thickness).edges(">Z").fillet(thickness * 0.4)
    lid = cq.Workplane().circle(radius).extrude(thickness * 0.8).edges(">Z").fillet(thickness * 0.35).translate((0, 0, thickness))
    return base.union(lid)


def crate(length=1.0, width=1.0, height=1.0, frame=0.08):
    """a wooden crate: a box with raised frame edges on every face, its bottom at z = 0"""
    body = cq.Workplane().box(length - frame, width - frame, height - frame)
    rails = cq.Workplane().box(length, width, height).edges().fillet(frame * 0.3)
    hollow = (
        cq.Workplane().box(length - 2 * frame, width + 1, height - 2 * frame)
        .union(cq.Workplane().box(length + 1, width - 2 * frame, height - 2 * frame))
        .union(cq.Workplane().box(length - 2 * frame, width - 2 * frame, height + 1))
    )
    return rails.cut(hollow).union(body).translate((0, 0, height / 2))


def panel(width=0.9, height=1.2, depth=0.08, frame=0.07, inset=0.025):
    """a door or window panel facing -Y: a frame with an inset centre, its bottom at z = 0"""
    outer = cq.Workplane().box(width, depth, height).edges("|Y").fillet(frame * 0.3)
    recess = cq.Workplane().box(width - 2 * frame, depth, height - 2 * frame).translate((0, -depth + inset, 0))
    return outer.cut(recess).translate((0, 0, height / 2))


def bolt_ring(radius=0.3, count=8, bolt=0.025, height=0.03):
    """small bolt heads on a circle, for hubs and hatches; their bottom at z = 0"""
    bolts = cq.Workplane()
    for i in range(count):
        a = 2 * math.pi * i / count
        bolts = bolts.union(cq.Workplane().circle(bolt).extrude(height).translate((radius * math.cos(a), radius * math.sin(a), 0)))
    return bolts
