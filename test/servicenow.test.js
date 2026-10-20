'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, plain } = require('../test-support/sn-runtime');

// Obviously synthetic sys_ids.
const RISK_1 = 'fa4e0000000000000000000000000001';
const RISK_2 = 'fa4e0000000000000000000000000002';
const ENTITY_1 = 'fa4e0000000000000000000000000e01';

function seed() {
  return {
    x_irmrs_entity: [{ sys_id: ENTITY_1, name: 'Synthetic Payments Platform' }],
    x_irmrs_risk: [
      { sys_id: RISK_1, entity: ENTITY_1, likelihood: '4', impact: '5', category: 'Cyber', weight: '3', active: 'true' },
      { sys_id: RISK_2, entity: ENTITY_1, likelihood: '2', impact: '3', category: 'Operational', weight: '1', active: 'true', residual_score: '6' },
    ],
    x_irmrs_control: [
      { sys_id: 'fa4e0000000000000000000000000c01', risk: RISK_1, design_effectiveness: 'effective', operating_effectiveness: 'partially_effective', active: 'true' },
      { sys_id: 'fa4e0000000000000000000000000c02', risk: RISK_1, design_effectiveness: 'effective', operating_effectiveness: 'effective', active: 'false' },
    ],
  };
}

test('RiskScoringService reads only active controls for a risk', () => {
  const rt = createRuntime({ db: seed() });
  const controls = plain(new rt.RiskScoringService().getControlsForRisk(RISK_1));
  assert.equal(controls.length, 1);
  assert.equal(controls[0].design, 'effective');
});

test('applyToRecord sets result fields without saving the record', () => {
  const rt = createRuntime({ db: seed() });
  const gr = rt.record('x_irmrs_risk', RISK_1);
  new rt.RiskScoringService().applyToRecord(gr);
  const row = rt.db.x_irmrs_risk[0];
  assert.equal(row.inherent_score, 20);
  assert.equal(row.inherent_rating, 'Critical');
  assert.equal(row.residual_score, 6);
  assert.equal(row.residual_rating, 'Moderate');
  assert.equal(row.appetite_status, 'Within Appetite');
  assert.equal(row.next_review_date, '2026-07-14');
  assert.equal(rt.stats.updates.length, 0);
});

test('scoreRisk saves the record and returns null for unknown risks', () => {
  const rt = createRuntime({ db: seed() });
  const svc = new rt.RiskScoringService();
  assert.equal(svc.scoreRisk(RISK_1).residual.score, 6);
  assert.deepEqual(plain(rt.stats.updates), [{ table: 'x_irmrs_risk', sys_id: RISK_1 }]);
  assert.equal(svc.scoreRisk('fa4e00000000000000000000000000ff'), null);
  assert.match(rt.logs.warn[0], /not found/);
  assert.equal(svc.scoreRisk(''), null);
});

test('scoring configuration is read from the x_irmrs.scoring_config property', () => {
  const config = JSON.stringify({ appetiteByCategory: { Cyber: { appetite: 3, tolerance: 5 } } });
  const rt = createRuntime({ db: seed(), properties: { 'x_irmrs.scoring_config': config } });
  assert.equal(new rt.RiskScoringService().scoreRisk(RISK_1).appetite.status, 'Exceeds Tolerance');
});

test('invalid JSON in the config property falls back to defaults and logs an error', () => {
  const rt = createRuntime({ db: seed(), properties: { 'x_irmrs.scoring_config': '{not json' } });
  assert.equal(new rt.RiskScoringService().scoreRisk(RISK_1).residual.score, 6);
  assert.match(rt.logs.error[0], /not valid JSON/);
});

test('table names can be overridden by system properties', () => {
  const db = seed();
  db.u_custom_risk = db.x_irmrs_risk;
  delete db.x_irmrs_risk;
  const rt = createRuntime({ db, properties: { 'x_irmrs.risk_table': 'u_custom_risk' } });
  assert.equal(new rt.RiskScoringService().scoreRisk(RISK_1).inherent.score, 20);
});

test('rollUpEntity aggregates scored, active risks and updates the entity', () => {
  const rt = createRuntime({ db: seed() });
  const svc = new rt.RiskScoringService();
  svc.scoreRisk(RISK_1); // residual 6
  rt.db.x_irmrs_risk[1].residual_score = '4';
  const agg = plain(svc.rollUpEntity(ENTITY_1, 'weighted_average'));
  assert.equal(agg.score, 5.5); // (6*3 + 4*1) / 4
  assert.equal(agg.count, 2);
  const entity = rt.db.x_irmrs_entity[0];
  assert.equal(entity.aggregate_rating, 'Moderate');
  assert.equal(entity.aggregate_driver, RISK_1);
});

test('rollUpEntity honours the x_irmrs.entity_aggregation property', () => {
  const rt = createRuntime({ db: seed(), properties: { 'x_irmrs.entity_aggregation': 'max' } });
  assert.equal(new rt.RiskScoringService().rollUpEntity(ENTITY_1).score, 6); // only RISK_2 is scored
});

test('before Business Rule applies scores to current', () => {
  const rt = createRuntime({ db: seed() });
  const current = rt.record('x_irmrs_risk', RISK_1);
  rt.run('brCalculate', { current, previous: null });
  assert.equal(rt.db.x_irmrs_risk[0].residual_rating, 'Moderate');
  assert.equal(rt.stats.updates.length, 0, 'before rule must not call update()');
});

test('before Business Rule aborts the save on invalid input', () => {
  const db = seed();
  db.x_irmrs_risk[0].impact = '9';
  const rt = createRuntime({ db });
  let aborted = false;
  const current = rt.record('x_irmrs_risk', RISK_1);
  current.setAbortAction = (v) => (aborted = v);
  rt.run('brCalculate', { current, previous: null });
  assert.equal(aborted, true);
  assert.match(rt.logs.uiErrors[0], /impact must be an integer between 1 and 5/);
});

test('control Business Rule rescores the current and previous parent risks', () => {
  const rt = createRuntime({ db: seed() });
  const current = rt.record('x_irmrs_control', 'fa4e0000000000000000000000000c01');
  const previous = { getValue: (f) => (f === 'risk' ? RISK_2 : null) };
  rt.run('brControl', { current, previous });
  assert.deepEqual(plain(rt.stats.updates.map((u) => u.sys_id)), [RISK_1, RISK_2]);
});

test('roll-up Business Rule recalculates the entity', () => {
  const rt = createRuntime({ db: seed() });
  rt.run('brRollup', { current: rt.record('x_irmrs_risk', RISK_2), previous: null });
  assert.equal(rt.db.x_irmrs_entity[0].aggregate_score, 6);
});

test('Flow Designer script step maps results to outputs', () => {
  const rt = createRuntime({ db: seed() });
  const outputs = {};
  rt.run('flowStep', { inputs: { risk_sys_id: RISK_1 }, outputs });
  assert.equal(outputs.inherent_rating, 'Critical');
  assert.equal(outputs.residual_score, 6);
  assert.equal(outputs.review_due_date, '2026-07-14');
  assert.equal(outputs.exceeds_tolerance, false);
});

test('Flow Designer script step fails for missing or unknown risks', () => {
  const rt = createRuntime({ db: seed() });
  assert.throws(() => rt.run('flowStep', { inputs: {}, outputs: {} }), /risk_sys_id is required/);
  assert.throws(() => rt.run('flowStep', { inputs: { risk_sys_id: 'fa4e00000000000000000000000000ff' }, outputs: {} }), /Risk not found/);
});

function restCall(rt, body) {
  const res = { status: null, body: null, error: null };
  const response = {
    setStatus: (s) => (res.status = s),
    setBody: (b) => (res.body = plain(b)),
    setError: (e) => {
      res.status = e.status;
      res.error = e.message;
    },
  };
  rt.run('restAssess', { request: { body: { data: body } }, response });
  return res;
}

test('Scripted REST /assess returns a what-if assessment', () => {
  const rt = createRuntime({ roles: ['x_irmrs.risk_analyst'] });
  const res = restCall(rt, { likelihood: 5, impact: 5, controls: [{ design: 'effective', operating: 'effective', extra: 'ignored' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.inherent.score, 25);
  assert.equal(res.body.residual.score, 5);
  assert.equal(rt.stats.queries, 0, 'what-if must not query records');
});

test('Scripted REST /assess validates input and enforces the role', () => {
  const analyst = createRuntime({ roles: ['x_irmrs.risk_analyst'] });
  assert.equal(restCall(analyst, { likelihood: 7, impact: 1 }).status, 400);
  assert.equal(restCall(analyst, null).status, 400);
  assert.equal(restCall(analyst, { likelihood: 2, impact: 2, controls: 'x' }).status, 400);
  assert.equal(restCall(analyst, { likelihood: 2, impact: 2, controls: new Array(51).fill({}) }).status, 400);
  assert.equal(restCall(createRuntime({ roles: [] }), { likelihood: 2, impact: 2 }).status, 403);
});
