'use strict';
/* One tuner worker: runs tune-api.js on its own thread with its own bake cache. scripts/serve.js keeps a pool of these and
   sends each scene to the same worker, so its baked variants stay cached there while other scenes bake in parallel. */
const { parentPort, workerData } = require('node:worker_threads');
const api = require('./tune-api.js');

if (workerData?.budget) api.setBudget(workerData.budget);
parentPort.on('message', ({ id, op, input }) => {
  try {
    parentPort.postMessage({ id, result: api[op](input) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message, status: error.status });
  }
});
