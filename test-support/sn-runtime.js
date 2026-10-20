'use strict';

/**
 * Lightweight ServiceNow runtime for unit tests.
 *
 * Platform scripts are loaded unchanged into a node:vm context that provides small
 * mocks of Class, gs, GlideRecord, GlideDate and sn_ws_err. Only the API surface used
 * by this project is implemented.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCES = {
  core: 'src/core/RiskScoringCore.js',
  service: 'src/servicenow/script_includes/RiskScoringService.js',
  brCalculate: 'src/servicenow/business_rules/risk_calculate_scores.js',
  brControl: 'src/servicenow/business_rules/control_rescore_risk.js',
  brRollup: 'src/servicenow/business_rules/risk_rollup_entity.js',
  flowStep: 'src/servicenow/flow_actions/calculate_risk_score_step.js',
  restAssess: 'src/servicenow/scripted_rest/assess_resource.js',
};

function formatMessage(msg, args) {
  return String(msg).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
}

/** In-memory GlideRecord bound to a `db` object: { tableName: [rows] }. */
function createGlideRecord(db, stats) {
  let idCounter = 0;

  function GlideRecord(table) {
    this._table = table;
    this._conditions = [];
    this._rows = [];
    this._index = -1;
    this._current = null;
    this._limit = null;
  }

  GlideRecord.prototype = {
    addQuery(field, op, value) {
      if (arguments.length === 2) {
        value = op;
        op = '=';
      }
      this._conditions.push({ field, op, value });
      return this;
    },
    addActiveQuery() {
      return this.addQuery('active', 'true');
    },
    addNotNullQuery(field) {
      return this.addQuery(field, 'ISNOTEMPTY', null);
    },
    setLimit(n) {
      this._limit = n;
    },
    query() {
      stats.queries++;
      const rows = (db[this._table] || []).filter((row) => this._conditions.every((c) => matches(row, c)));
      this._rows = this._limit ? rows.slice(0, this._limit) : rows;
      this._index = -1;
    },
    next() {
      this._index++;
      this._current = this._index < this._rows.length ? this._rows[this._index] : null;
      return this._current !== null;
    },
    get(sysId) {
      stats.queries++;
      this._current = (db[this._table] || []).filter((r) => r.sys_id === sysId)[0] || null;
      return this._current !== null;
    },
    isValidRecord() {
      return this._current !== null;
    },
    getValue(field) {
      const v = this._current ? this._current[field] : undefined;
      return v === undefined || v === null || v === '' ? null : String(v);
    },
    setValue(field, value) {
      this._current[field] = value;
    },
    getUniqueValue() {
      return this._current ? this._current.sys_id : null;
    },
    getTableName() {
      return this._table;
    },
    initialize() {
      this._current = {};
    },
    insert() {
      idCounter++;
      this._current.sys_id = this._current.sys_id || `fa4e0000${String(idCounter).padStart(24, '0')}`;
      (db[this._table] = db[this._table] || []).push(this._current);
      return this._current.sys_id;
    },
    update() {
      stats.updates.push({ table: this._table, sys_id: this._current.sys_id });
      return this._current.sys_id;
    },
  };

  function matches(row, c) {
    const v = row[c.field];
    switch (c.op) {
      case '=':
        return String(v) === String(c.value);
      case '!=':
        return String(v) !== String(c.value);
      case 'ISNOTEMPTY':
        return v !== undefined && v !== null && v !== '';
      case 'IN':
        return String(c.value).split(',').indexOf(String(v)) !== -1;
      default:
        throw new Error(`GlideRecord mock: operator ${c.op} not supported`);
    }
  }

  return GlideRecord;
}

/**
 * Create a runtime.
 * @param {{db?: object, properties?: object, roles?: string[], today?: string}} options
 */
function createRuntime(options = {}) {
  const db = options.db || {};
  const properties = options.properties || {};
  const roles = options.roles || [];
  const logs = { info: [], warn: [], error: [], debug: [], uiErrors: [] };
  const stats = { queries: 0, updates: [] };

  const gs = {
    getProperty: (name, def) => (Object.prototype.hasOwnProperty.call(properties, name) ? properties[name] : def),
    info: (msg, ...args) => logs.info.push(formatMessage(msg, args)),
    warn: (msg, ...args) => logs.warn.push(formatMessage(msg, args)),
    error: (msg, ...args) => logs.error.push(formatMessage(msg, args)),
    debug: (msg, ...args) => logs.debug.push(formatMessage(msg, args)),
    hasRole: (role) => roles.indexOf(role) !== -1 || roles.indexOf('admin') !== -1,
    getMessage: (msg, args) => formatMessage(msg, args || []),
    addErrorMessage: (msg) => logs.uiErrors.push(msg),
  };

  function GlideDate() {}
  GlideDate.prototype.getValue = () => options.today || '2026-01-15';

  const sn_ws_err = {
    BadRequestError: function BadRequestError(message) {
      this.status = 400;
      this.message = message;
    },
  };

  const context = vm.createContext({
    Class: {
      create() {
        return function () {
          this.initialize.apply(this, arguments);
        };
      },
    },
    gs,
    GlideRecord: createGlideRecord(db, stats),
    GlideDate,
    sn_ws_err,
  });

  const loaded = new Set();
  function load(key) {
    if (loaded.has(key)) return;
    const file = path.join(ROOT, SOURCES[key]);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: SOURCES[key] });
    loaded.add(key);
  }

  // Script Includes are always available, as on the platform; expose the scope namespace too.
  load('core');
  load('service');
  context.x_irmrs = { RiskScoringCore: context.RiskScoringCore, RiskScoringService: context.RiskScoringService };

  /** Run a platform script (Business Rule, flow step, REST resource) with extra globals. */
  function run(key, globals) {
    const file = path.join(ROOT, SOURCES[key]);
    Object.assign(context, globals);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: SOURCES[key] });
  }

  /** GlideRecord positioned on an existing row (like `current`). */
  function record(table, sysId) {
    const gr = new context.GlideRecord(table);
    if (!gr.get(sysId)) throw new Error(`No ${table} row ${sysId}`);
    return gr;
  }

  return { context, db, logs, stats, run, record, RiskScoringCore: context.RiskScoringCore, RiskScoringService: context.RiskScoringService };
}

/** Convert cross-realm vm objects to plain Node objects for deepStrictEqual. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { createRuntime, plain, SOURCES, ROOT };
