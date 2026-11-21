'use strict';
/* Loads every op family into the registry, in the order tools are listed to agents. */
require('./discover.js');
require('./scene.js');
require('./query.js');
require('./export.js');
require('./model.js');
require('./fit.js');
require('./rank.js');
require('./check.js');
require('./world.js');
require('./bridge.js');
module.exports = require('../registry.js');
