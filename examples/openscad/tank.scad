// A small tank in OpenSCAD, for model_build (engine "openscad"). Z up, X forward, metres. Parts are named in PARTS
// (name, colour, role) and drawn by module part(name), so each becomes its own mesh solid and role.
$fn = 32;

PARTS = [
  ["hull", "#5b6b2e", "olive"],
  ["tracks", "#2b2b2b", "track"],
  ["wheels", "#777b72", "steel"],
  ["fenders", "#3f4a22", "dark-olive"],
  ["turret", "#5b6b2e", "olive"],
  ["gun", "#3f4a22", "dark-olive"],
  ["cupola", "#3f4a22", "dark-olive"],
  ["antenna", "#777b72", "steel"]
];

module hull_shape() {
  // side profile hulled from rounded rods: a sloped glacis and a raked rear
  minkowski() {
    hull() {
      for (p = [[-2.5, 0.5], [2.1, 0.5], [2.62, 0.9], [2.2, 1.25], [-2.4, 1.25], [-2.6, 1.0]])
        translate([p[0], 0, p[1]]) rotate([90, 0, 0]) cylinder(r = 0.01, h = 1.9, center = true);
    }
    sphere(r = 0.05, $fn = 12);
  }
}
module track(side) {
  translate([0, side * 1.25, 0]) hull() for (x = [-2.12, 2.12]) translate([x, 0, 0.46]) rotate([90, 0, 0]) cylinder(r = 0.46, h = 0.54, center = true);
}
module part(name) {
  if (name == "hull") hull_shape();
  if (name == "tracks") for (s = [1, -1]) track(s);
  if (name == "wheels") for (s = [1, -1], x = [-1.9 : 0.75 : 1.9]) translate([x, s * 1.53, 0.43]) rotate([90, 0, 0]) {
    cylinder(r = 0.31, h = 0.1, center = true);
    cylinder(r = 0.11, h = 0.18, center = true);
  }
  if (name == "fenders") for (s = [1, -1]) translate([0.05, s * 1.31, 1.03]) cube([5.1, 0.62, 0.06], center = true);
  if (name == "turret") translate([-0.35, 0, 1.25]) minkowski() {
    hull() {
      linear_extrude(0.01) offset(r = 0.15) square([1.8, 1.45], center = true);
      translate([0, 0, 0.5]) linear_extrude(0.01) offset(r = 0.12) square([1.3, 1.05], center = true);
    }
    sphere(r = 0.04, $fn = 10);
  }
  if (name == "gun") {
    translate([0.75, 0, 1.6]) cube([0.35, 0.8, 0.42], center = true);
    translate([0.9, 0, 1.6]) rotate([0, 90, 0]) cylinder(r = 0.085, h = 2.5);
    translate([0.9, 0, 1.6]) rotate([0, 90, 0]) cylinder(r = 0.12, h = 0.45);
    translate([3.3, 0, 1.6]) rotate([0, 90, 0]) cylinder(r = 0.13, h = 0.32);
  }
  if (name == "cupola") translate([-0.7, 0.35, 1.8]) {
    cylinder(r = 0.3, h = 0.2);
    translate([0, 0, 0.2]) scale([1, 1, 0.35]) sphere(r = 0.22);
  }
  if (name == "antenna") translate([-1.2, -0.55, 1.8]) cylinder(r = 0.015, h = 1.1, $fn = 8);
}

if (is_undef(INK)) for (p = PARTS) color(p[1]) part(p[0]);
