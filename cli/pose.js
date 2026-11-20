'use strict';
/* Puts a baked world at time t, shared by the CLI and the agent tools so both show the same frame.

     pose(world, t, { direction, tap, kit })   direction from ArtDirection.prepare; tap(world, from, to) sees each fixed step;
                                               kit() returns KIT and is only called for worlds with bones
     behind(world, t, direction)              true when reaching t needs the past of a world that only runs forwards

   A world that remembers its past (anim.stateful) is walked forwards a sixtieth of a second at a time. Asking such a world
   for an earlier time throws an error with code BACKWARDS; rebuild it instead. */
const ArtDirection = require('../src/art-direction.js');

const separateClothFor = (world, direction) =>
  !!(direction?.cadence.scene && direction.cadence.cloth !== undefined && world.anim.hasIndependentCloth?.());

/* the scene clock is held by the scene cadence, but cloth with its own cadence runs on raw time (clothClock): both must
   not have passed t */
function behind(world, t, direction) {
  if (!world.anim?.stateful) return false;
  return ArtDirection.time(direction, t) < world.clock || (world.clothClock !== undefined && t < world.clothClock);
}

function pose(world, t, { direction, tap, kit } = {}) {
  if (!world.anim) return;
  if (world.anim.motionSettings) world.anim.motionDirection = direction;
  const sceneTime = ArtDirection.time(direction, t);
  if (world.anim.stateful) {
    if (behind(world, t, direction))
      throw Object.assign(new Error('this diorama cannot be run backwards: ask for times in order'), { code: 'BACKWARDS' });
    const separateCloth = separateClothFor(world, direction);
    const advanceScene = to => {
      while (world.clock < to - 1e-9) {
        const dt = Math.min(1 / 60, to - world.clock), before = world.clock;
        world.clock += dt;
        tap?.(world, before, world.clock);
        if (separateCloth) world.anim.update(dt, world.clock, { separateCloth });
        else world.anim.update(dt, world.clock);
      }
    };
    if (separateCloth) {
      // Interleave fixed steps so cloth sees the held scene pose at each step.
      let at = world.clothClock ?? world.clock;
      while (at < t - 1e-9) {
        const dt = Math.min(1 / 60, t - at);
        at += dt;
        advanceScene(ArtDirection.time(direction, at));
        world.anim.advanceCloth(dt, at);
      }
      world.clothClock = t;
    } else advanceScene(sceneTime);
  } else world.anim.update(1 / 60, sceneTime);
  world.clock = sceneTime;
  /* splats carried by bones on the graphics card stay at rest in the data: the tools look at a copy with them put in place */
  if (world.anim.bones) {
    if (!world.rest) world.rest = world.data;
    world.data = kit().bones.posed({
      data: world.rest,
      anim: world.anim,
      get posedBuf() {
        return world.posedBuf;
      },
      set posedBuf(v) {
        world.posedBuf = v;
      }
    });
  }
}

module.exports = { pose, behind };
