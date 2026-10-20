'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('../scripts/lib/load-core');
const { plain } = require('../test-support/sn-runtime');

const RiskScoringCore = loadCore();
const core = new RiskScoringCore();

const STRONG = { design: 'effective', operating: 'partially_effective' }; // 0.4 + 0.3 = 0.7
const STRONGER = { design: 'largely_effective', operating: 'effective' }; // 0.3 + 0.6 = 0.9

test('inherent score is likelihood x impact on the default 5x5 matrix', () => {
  const r = core.inherent(4, 5);
  assert.equal(r.score, 20);
  assert.equal(r.rating, 'Critical');
  assert.equal(r.likelihoodLabel, 'Likely');
  assert.equal(r.impactLabel, 'Severe');
});

test('rating bands use inclusive upper bounds', () => {
  assert.deepEqual([1, 4, 4.01, 9, 10, 16, 16.5, 25].map((s) => core.rating(s)), [
    'Low', 'Low', 'Moderate', 'Moderate', 'High', 'High', 'Critical', 'Critical',
  ]);
});

test('numeric strings from GlideRecord are accepted for likelihood and impact', () => {
  assert.equal(core.inherent('3', ' 3 ').score, 9);
});

test('likelihood and impact outside 1..5 or non-integers are rejected', () => {
  for (const bad of [0, 6, 2.5, '2.5', 'high', null, undefined, NaN, -1]) {
    assert.throws(() => core.inherent(bad, 3), { name: 'RiskScoringValidationError' }, `likelihood ${bad}`);
    assert.throws(() => core.inherent(3, bad), /impact must be an integer between 1 and 5/);
  }
});

test('control effectiveness combines design and operating with 40/60 weights', () => {
  assert.equal(core.controlEffectiveness(STRONG), 0.7);
  assert.equal(core.controlEffectiveness(STRONGER), 0.9);
  assert.equal(core.controlEffectiveness({ design: 0.5, operating: '1' }), 0.8);
});

test('rating labels are normalised (case, spaces, hyphens)', () => {
  assert.equal(core.controlEffectiveness({ design: 'Effective', operating: 'Partially Effective' }), 0.7);
  assert.equal(core.controlEffectiveness({ design: 'largely-effective', operating: 'EFFECTIVE' }), 0.9);
});

test('design gate: an ineffectively designed control contributes nothing', () => {
  assert.equal(core.controlEffectiveness({ design: 'ineffective', operating: 'effective' }), 0);
  const noGate = new RiskScoringCore({ designGate: false });
  assert.equal(noGate.controlEffectiveness({ design: 'ineffective', operating: 'effective' }), 0.6);
});

test('unknown effectiveness ratings and out-of-range factors are rejected', () => {
  assert.throws(() => core.controlEffectiveness({ design: 'excellent', operating: 'effective' }), /not a configured rating/);
  assert.throws(() => core.controlEffectiveness({ design: 1.5, operating: 'effective' }), /between 0 and 1/);
  assert.throws(() => core.controlEffectiveness(null), /control must be an object/);
});

test('multiple controls combine by complement and are capped at maxReduction', () => {
  const eff = core.combinedEffectiveness([STRONG, STRONGER]);
  assert.equal(eff.raw, 0.97);
  assert.equal(eff.applied, 0.8);
  assert.equal(eff.count, 2);
});

test('max and average control aggregation methods', () => {
  assert.equal(new RiskScoringCore({ controlAggregation: 'max' }).combinedEffectiveness([STRONG, STRONGER]).raw, 0.9);
  assert.equal(new RiskScoringCore({ controlAggregation: 'average' }).combinedEffectiveness([STRONG, STRONGER]).raw, 0.8);
});

test('inactive controls are ignored and no controls means no reduction', () => {
  const eff = core.combinedEffectiveness([{ design: 'effective', operating: 'effective', active: 'false' }]);
  assert.equal(eff.count, 0);
  assert.equal(eff.applied, 0);
  assert.equal(core.combinedEffectiveness(undefined).applied, 0);
  assert.throws(() => core.combinedEffectiveness('not-an-array'), /controls must be an array/);
});

test('residual score never drops below the lowest matrix cell', () => {
  assert.deepEqual(plain(core.residual(20, 0.7)), { score: 6, rating: 'Moderate' });
  assert.equal(core.residual(1, 0.8).score, 1);
  assert.throws(() => core.residual(30, 0.5), /inherentScore/);
  assert.throws(() => core.residual(10, 1.2), /appliedEffectiveness/);
});

test('appetite status uses appetite and tolerance thresholds', () => {
  assert.equal(core.appetiteStatus(6).status, 'Within Appetite');
  assert.equal(core.appetiteStatus(6.01).status, 'Within Tolerance');
  assert.equal(core.appetiteStatus(12).status, 'Within Tolerance');
  assert.equal(core.appetiteStatus(12.5).status, 'Exceeds Tolerance');
});

test('category-specific appetite overrides the default', () => {
  const strict = new RiskScoringCore({ appetiteByCategory: { Cyber: { appetite: 3, tolerance: 6 } } });
  assert.equal(strict.appetiteStatus(5, 'Cyber').status, 'Within Tolerance');
  assert.equal(strict.appetiteStatus(5, 'Operational').status, 'Within Appetite');
});

test('review due date adds the interval for the rating', () => {
  assert.equal(core.reviewDueDate('Critical', '2026-01-15'), '2026-02-14');
  assert.equal(core.reviewDueDate('Moderate', '2026-01-15'), '2026-07-14');
  assert.equal(core.reviewDueDate('Low', '2026-01-15'), '2027-01-15');
});

test('review due date handles leap years and month ends', () => {
  assert.equal(core.reviewDueDate('Critical', '2028-02-15'), '2028-03-16');
  assert.equal(core.reviewDueDate('High', '2026-11-30'), '2027-02-28');
});

test('review due date rejects invalid dates and unknown ratings', () => {
  assert.throws(() => core.reviewDueDate('High', '2026-02-30'), /not a valid calendar date/);
  assert.throws(() => core.reviewDueDate('High', '15/01/2026'), /YYYY-MM-DD/);
  assert.throws(() => core.reviewDueDate('Severe', '2026-01-15'), /no review interval/);
});

test('assess() returns the full assessment', () => {
  const result = plain(
    core.assess({ id: 'RSK-1', likelihood: 4, impact: 5, category: 'Cyber', controls: [STRONG], assessedOn: '2026-01-15' })
  );
  assert.equal(result.inherent.score, 20);
  assert.equal(result.controlEffectiveness.applied, 0.7);
  assert.deepEqual(result.residual, { score: 6, rating: 'Moderate' });
  assert.equal(result.appetite.status, 'Within Appetite');
  assert.equal(result.reviewDueDate, '2026-07-14');
});

test('assess() with capped controls lands in the Low band', () => {
  const r = core.assess({ likelihood: 4, impact: 5, controls: [STRONG, STRONGER], assessedOn: '2026-01-15' });
  assert.equal(r.residual.score, 4);
  assert.equal(r.residual.rating, 'Low');
  assert.equal(r.reviewDueDate, '2027-01-15');
});

test('assess() validates its input object', () => {
  assert.throws(() => core.assess(null), /risk must be an object/);
  assert.throws(() => core.assess({ likelihood: 3, impact: 3 }), /fromDate/);
});

test('entity aggregation: max, weighted average and average', () => {
  const risks = [
    { id: 'A', residualScore: 4, weight: 1 },
    { id: 'B', residualScore: '12', weight: '3' },
    { id: 'C', residualScore: 6.5, weight: 2 },
  ];
  assert.deepEqual(plain(core.aggregate(risks)), { score: 12, rating: 'High', method: 'max', count: 3, driverId: 'B' });
  assert.equal(core.aggregate(risks, 'weighted_average').score, 8.83);
  assert.equal(core.aggregate(risks, 'average').score, 7.5);
});

test('entity aggregation edge cases', () => {
  assert.equal(core.aggregate([]).rating, 'Not Assessed');
  assert.equal(core.aggregate([{ residualScore: 5 }], 'weighted_average').score, 5); // default weight 1
  assert.throws(() => core.aggregate([{ residualScore: 5, weight: 0 }], 'weighted_average'), /must not all be zero/);
  assert.throws(() => core.aggregate([{ residualScore: 5 }], 'median'), /unknown aggregation method/);
  assert.throws(() => core.aggregate({}), /risks must be an array/);
});

test('custom matrix overrides likelihood x impact', () => {
  const matrix = [
    [1, 2, 4, 7, 11],
    [2, 4, 7, 11, 16],
    [3, 6, 10, 15, 20],
    [4, 8, 13, 19, 23],
    [5, 10, 16, 22, 25],
  ];
  const custom = new RiskScoringCore({ matrix });
  assert.equal(custom.inherent(1, 5).score, 11);
  assert.equal(custom.inherent(1, 5).rating, 'High');
});

test('configuration validation catches inconsistent settings', () => {
  const bad = [
    [{ matrix: [[1, 2], [3, 4]] }, /matrix must have 5 rows/],
    [{ matrix: Array(5).fill([5, 4, 3, 2, 1]) }, /must not decrease/],
    [{ bands: [{ name: 'Low', max: 10 }, { name: 'High', max: 9 }] }, /strictly ascending/],
    [{ bands: [{ name: 'Low', max: 10 }] }, /highest band must cover/],
    [{ designWeight: 0.5, operatingWeight: 0.6 }, /sum to 1/],
    [{ maxReduction: 1 }, /maxReduction/],
    [{ appetite: { appetite: 10, tolerance: 5 } }, /tolerance must be greater/],
    [{ appetiteByCategory: { Cyber: { appetite: 2 } } }, /appetiteByCategory.Cyber/],
    [{ controlAggregation: 'sum' }, /controlAggregation/],
    [{ effectivenessRatings: { strong: 2 } }, /between 0 and 1/],
    [{ reviewIntervalDays: { Critical: 0 } }, /positive interval/],
    [{ likelihoodScale: 5 }, /unknown configuration key/],
  ];
  for (const [cfg, msg] of bad) {
    assert.throws(() => new RiskScoringCore(cfg), msg, JSON.stringify(cfg));
  }
});

test('a 4x4 matrix with custom bands is supported', () => {
  const small = new RiskScoringCore({
    likelihoodLabels: ['Low', 'Medium', 'High', 'Very High'],
    impactLabels: ['Low', 'Medium', 'High', 'Very High'],
    bands: [{ name: 'Low', max: 3 }, { name: 'Moderate', max: 6 }, { name: 'High', max: 11 }, { name: 'Critical', max: 16 }],
  });
  assert.equal(small.inherent(4, 4).score, 16);
  assert.throws(() => small.inherent(5, 1), /between 1 and 4/);
});

test('heat map counts inherent positions', () => {
  const assessments = [
    core.assess({ likelihood: 4, impact: 5, assessedOn: '2026-01-15' }),
    core.assess({ likelihood: 4, impact: 5, assessedOn: '2026-01-15' }),
    core.assess({ likelihood: 1, impact: 2, assessedOn: '2026-01-15' }),
  ];
  const grid = plain(core.heatMap(assessments));
  assert.equal(grid[3][4], 2);
  assert.equal(grid[0][1], 1);
  assert.equal(grid.flat().reduce((a, b) => a + b, 0), 3);
});

test('core can be required directly in Node with a Class shim', () => {
  global.Class = { create: () => function () { this.initialize.apply(this, arguments); } };
  try {
    delete require.cache[require.resolve('../src/core/RiskScoringCore.js')];
    const Direct = require('../src/core/RiskScoringCore.js');
    assert.equal(new Direct().inherent(2, 3).score, 6);
  } finally {
    delete global.Class;
  }
});
