'use strict';

/**
 * Load RiskScoringCore (written for the ServiceNow Script Include pattern) into Node.js.
 * The file only needs a `Class.create()` shim; no other platform APIs are used.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE_FILE = path.join(__dirname, '..', '..', 'src', 'core', 'RiskScoringCore.js');

function loadCore() {
  const context = vm.createContext({
    Class: {
      create() {
        return function () {
          this.initialize.apply(this, arguments);
        };
      },
    },
  });
  vm.runInContext(fs.readFileSync(CORE_FILE, 'utf8'), context, { filename: 'RiskScoringCore.js' });
  return context.RiskScoringCore;
}

module.exports = { loadCore };
