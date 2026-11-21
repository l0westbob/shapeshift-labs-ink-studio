'use strict';
/* Puts a baked world at time t for the agent tools, on top of the CLI's own pose (cli/diarama-pose.js), so both show the
   same frame and share one stepping loop.

     pose(world, t, { direction, tap, kit })   direction: ArtDirection.prepare of the scene's own art direction (used to
                                               tell whether t is behind); tap(world, from, to) sees each fixed step;
                                               kit() returns KIT and is only called for worlds with bones
     behind(world, t, direction)              true when reaching t needs the past of a world that only runs forwards

   Asking a world that only runs forwards (anim.stateful) for an earlier time throws an error with code BACKWARDS, so the
   caller can rebuild it instead. */
const ArtDirection = require('../src/art-direction.js');
const DioramaPose = require('./diarama-pose.js');

/* the scene clock is held by the scene cadence, but cloth with its own cadence runs on raw time (clothClock): both must
   not have passed t */
function behind(world, t, direction) {
  if (!world.anim?.stateful) return false;
  return ArtDirection.time(direction, t) < (world.clock ?? 0) || (world.clothClock !== undefined && t < world.clothClock);
}

function pose(world, t, { direction, tap, kit } = {}) {
  if (!world.anim) return;
  if (behind(world, t, direction))
    throw Object.assign(new Error('this diorama cannot be run backwards: ask for times in order'), { code: 'BACKWARDS' });
  /* diarama-pose prepares the scene's own art direction, the same one `direction` holds here (the agent tools pass no
     command-line overrides); the kit is only read for worlds with bones */
  DioramaPose.pose(world, t, { kit: { get KIT() { return kit?.(); } }, tap: tap ?? (() => {}) });
}

module.exports = { pose, behind };
