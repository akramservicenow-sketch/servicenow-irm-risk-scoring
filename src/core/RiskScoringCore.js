/**
 * RiskScoringCore
 *
 * Platform-independent risk scoring engine. It uses only ES5 language features and
 * no Glide APIs, so the same file runs as a ServiceNow Script Include (Rhino / ES2021
 * engine) and under Node.js for unit tests.
 *
 * Model (see README for the full description):
 *   inherent score   = matrix[likelihood][impact]   (defaults to likelihood x impact)
 *   control eff.     = designWeight * D + operatingWeight * O   (0 when design is ineffective)
 *   combined eff.    = 1 - PRODUCT(1 - eff_i)   (or max / average), capped at maxReduction
 *   residual score   = inherent score * (1 - combined eff.)
 *   rating band      = first band whose upper bound >= score
 *   appetite status  = residual compared with appetite / tolerance thresholds
 *   review due date  = assessment date + review interval for the residual rating
 *
 * ServiceNow: create as Script Include "RiskScoringCore" in scope x_irmrs,
 * Accessible from "This application scope only", Client callable = false.
 */
var RiskScoringCore = Class.create();

RiskScoringCore.DEFAULT_CONFIG = {
    likelihoodLabels: ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost Certain'],
    impactLabels: ['Insignificant', 'Minor', 'Moderate', 'Major', 'Severe'],

    // Optional explicit matrix [likelihood - 1][impact - 1]. null = likelihood x impact.
    matrix: null,

    // Rating bands by inclusive upper bound, ascending. Works for fractional residual scores.
    bands: [
        { name: 'Low', max: 4 },
        { name: 'Moderate', max: 9 },
        { name: 'High', max: 16 },
        { name: 'Critical', max: 25 }
    ],

    // Effectiveness rating -> factor (0..1). Numeric factors are also accepted as input.
    effectivenessRatings: {
        effective: 1,
        largely_effective: 0.75,
        partially_effective: 0.5,
        ineffective: 0,
        not_tested: 0
    },
    designWeight: 0.4,
    operatingWeight: 0.6,
    // A control that is not designed effectively cannot operate effectively.
    designGate: true,

    // How multiple controls combine: 'complement' | 'max' | 'average'.
    controlAggregation: 'complement',
    // Controls can never reduce a risk by more than this fraction.
    maxReduction: 0.8,

    // Residual score thresholds. score <= appetite: within appetite;
    // score <= tolerance: within tolerance; otherwise exceeds tolerance.
    appetite: { appetite: 6, tolerance: 12 },
    appetiteByCategory: {},

    reviewIntervalDays: { Low: 365, Moderate: 180, High: 90, Critical: 30 },

    // Entity roll-up: 'max' | 'weighted_average' | 'average'.
    entityAggregation: 'max',

    scoreDecimals: 2
};

RiskScoringCore.APPETITE_STATUS = {
    WITHIN_APPETITE: 'Within Appetite',
    WITHIN_TOLERANCE: 'Within Tolerance',
    EXCEEDS_TOLERANCE: 'Exceeds Tolerance'
};

RiskScoringCore.prototype = {

    /**
     * @param {Object} [config] partial configuration merged over DEFAULT_CONFIG
     */
    initialize: function(config) {
        this.config = this._mergeConfig(RiskScoringCore.DEFAULT_CONFIG, config || {});
        this._validateConfig(this.config);
    },

    /* ------------------------------------------------------------------ */
    /* Public API                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Inherent score for a likelihood / impact pair.
     * @returns {{likelihood:number, impact:number, likelihoodLabel:string, impactLabel:string, score:number, rating:string}}
     */
    inherent: function(likelihood, impact) {
        var l = this._parseLevel(likelihood, 'likelihood', this.config.likelihoodLabels.length);
        var i = this._parseLevel(impact, 'impact', this.config.impactLabels.length);
        var score = this.config.matrix ? this.config.matrix[l - 1][i - 1] : l * i;
        return {
            likelihood: l,
            impact: i,
            likelihoodLabel: this.config.likelihoodLabels[l - 1],
            impactLabel: this.config.impactLabels[i - 1],
            score: score,
            rating: this.rating(score)
        };
    },

    /**
     * Effectiveness (0..1) of one control from its design and operating ratings.
     * @param {{design:(string|number), operating:(string|number)}} control
     */
    controlEffectiveness: function(control) {
        if (!control || typeof control !== 'object') {
            this._fail('control must be an object with design and operating ratings');
        }
        var d = this._parseEffectiveness(control.design, 'design');
        var o = this._parseEffectiveness(control.operating, 'operating');
        if (this.config.designGate && d === 0) {
            return 0;
        }
        return this._round(this.config.designWeight * d + this.config.operatingWeight * o, 4);
    },

    /**
     * Combined effectiveness of a set of controls, capped at maxReduction.
     * Controls with active === false (or 'false') are ignored.
     * @returns {{raw:number, applied:number, count:number, method:string}}
     */
    combinedEffectiveness: function(controls) {
        if (controls === undefined || controls === null) {
            controls = [];
        }
        if (!this._isArray(controls)) {
            this._fail('controls must be an array');
        }
        var values = [];
        for (var c = 0; c < controls.length; c++) {
            var ctrl = controls[c];
            if (ctrl && (ctrl.active === false || ctrl.active === 'false')) {
                continue;
            }
            values.push(this.controlEffectiveness(ctrl));
        }

        var method = this.config.controlAggregation;
        var raw = 0;
        if (values.length > 0) {
            if (method === 'max') {
                raw = Math.max.apply(Math, values);
            } else if (method === 'average') {
                raw = this._sum(values) / values.length;
            } else {
                var remaining = 1;
                for (var v = 0; v < values.length; v++) {
                    remaining = remaining * (1 - values[v]);
                }
                raw = 1 - remaining;
            }
        }
        return {
            raw: this._round(raw, 4),
            applied: this._round(Math.min(raw, this.config.maxReduction), 4),
            count: values.length,
            method: method
        };
    },

    /**
     * Residual score from an inherent score and a combined effectiveness factor.
     * Never below the lowest cell of the matrix.
     */
    residual: function(inherentScore, appliedEffectiveness) {
        var score = this._parseNumber(inherentScore, 'inherentScore', 0, this._maxScore());
        var eff = this._parseNumber(appliedEffectiveness, 'appliedEffectiveness', 0, 1);
        var value = Math.max(this._minScore(), score * (1 - eff));
        value = this._round(value, this.config.scoreDecimals);
        return { score: value, rating: this.rating(value) };
    },

    /** Rating band name for a score. */
    rating: function(score) {
        var s = this._parseNumber(score, 'score', 0, this._maxScore());
        var bands = this.config.bands;
        for (var b = 0; b < bands.length; b++) {
            if (s <= bands[b].max) {
                return bands[b].name;
            }
        }
        return bands[bands.length - 1].name;
    },

    /**
     * Compare a residual score with the risk appetite for an optional category.
     * @returns {{status:string, appetite:number, tolerance:number}}
     */
    appetiteStatus: function(residualScore, category) {
        var s = this._parseNumber(residualScore, 'residualScore', 0, this._maxScore());
        var limits = this.config.appetite;
        if (category && this.config.appetiteByCategory.hasOwnProperty(category)) {
            limits = this.config.appetiteByCategory[category];
        }
        var status = RiskScoringCore.APPETITE_STATUS.EXCEEDS_TOLERANCE;
        if (s <= limits.appetite) {
            status = RiskScoringCore.APPETITE_STATUS.WITHIN_APPETITE;
        } else if (s <= limits.tolerance) {
            status = RiskScoringCore.APPETITE_STATUS.WITHIN_TOLERANCE;
        }
        return { status: status, appetite: limits.appetite, tolerance: limits.tolerance };
    },

    /**
     * Next review date for a rating.
     * @param {string} rating band name
     * @param {string} fromDate 'YYYY-MM-DD'
     * @returns {string} 'YYYY-MM-DD'
     */
    reviewDueDate: function(rating, fromDate) {
        var days = this.config.reviewIntervalDays[rating];
        if (typeof days !== 'number') {
            this._fail('no review interval configured for rating "' + rating + '"');
        }
        var start = this._parseDate(fromDate, 'fromDate');
        return this._formatDate(new Date(start.getTime() + days * 86400000));
    },

    /**
     * Full assessment of one risk.
     * @param {{id?:string, likelihood:(number|string), impact:(number|string), category?:string,
     *          controls?:Array, assessedOn:string}} risk
     */
    assess: function(risk) {
        if (!risk || typeof risk !== 'object') {
            this._fail('risk must be an object');
        }
        var inh = this.inherent(risk.likelihood, risk.impact);
        var eff = this.combinedEffectiveness(risk.controls);
        var res = this.residual(inh.score, eff.applied);
        var appetite = this.appetiteStatus(res.score, risk.category);
        return {
            id: risk.id || null,
            category: risk.category || null,
            inherent: inh,
            controlEffectiveness: eff,
            residual: res,
            appetite: appetite,
            reviewDueDate: this.reviewDueDate(res.rating, risk.assessedOn)
        };
    },

    /**
     * Roll up risks to an entity (business unit, application, vendor...).
     * @param {Array<{id?:string, residualScore:(number|string), weight?:(number|string)}>} risks
     * @param {string} [method] overrides config.entityAggregation
     * @returns {{score:(number|null), rating:string, method:string, count:number, driverId:(string|null)}}
     */
    aggregate: function(risks, method) {
        if (!this._isArray(risks)) {
            this._fail('risks must be an array');
        }
        method = method || this.config.entityAggregation;
        if (method !== 'max' && method !== 'weighted_average' && method !== 'average') {
            this._fail('unknown aggregation method "' + method + '"');
        }
        if (risks.length === 0) {
            return { score: null, rating: 'Not Assessed', method: method, count: 0, driverId: null };
        }

        var max = -1;
        var driverId = null;
        var weightedSum = 0;
        var weightTotal = 0;
        var plainSum = 0;
        for (var r = 0; r < risks.length; r++) {
            var score = this._parseNumber(risks[r].residualScore, 'residualScore', 0, this._maxScore());
            var hasWeight = risks[r].weight !== undefined && risks[r].weight !== null && risks[r].weight !== '';
            var weight = hasWeight ? this._parseNumber(risks[r].weight, 'weight', 0, Infinity) : 1;
            if (score > max) {
                max = score;
                driverId = risks[r].id || null;
            }
            weightedSum += score * weight;
            weightTotal += weight;
            plainSum += score;
        }

        var result;
        if (method === 'max') {
            result = max;
        } else if (method === 'average') {
            result = plainSum / risks.length;
        } else {
            if (weightTotal === 0) {
                this._fail('weights must not all be zero for weighted_average');
            }
            result = weightedSum / weightTotal;
        }
        result = this._round(result, this.config.scoreDecimals);
        return { score: result, rating: this.rating(result), method: method, count: risks.length, driverId: driverId };
    },

    /**
     * Likelihood x impact count grid of inherent positions.
     * @returns {Array<Array<number>>} grid[likelihood - 1][impact - 1]
     */
    heatMap: function(assessments) {
        var grid = [];
        var l;
        for (l = 0; l < this.config.likelihoodLabels.length; l++) {
            grid.push([]);
            for (var i = 0; i < this.config.impactLabels.length; i++) {
                grid[l].push(0);
            }
        }
        for (var a = 0; a < assessments.length; a++) {
            var inh = assessments[a].inherent;
            grid[inh.likelihood - 1][inh.impact - 1]++;
        }
        return grid;
    },

    /** Score shown in a matrix cell (used by reports). */
    cellScore: function(likelihood, impact) {
        return this.inherent(likelihood, impact).score;
    },

    /* ------------------------------------------------------------------ */
    /* Validation and helpers                                              */
    /* ------------------------------------------------------------------ */

    _fail: function(message) {
        var err = new Error('RiskScoringCore: ' + message);
        err.name = 'RiskScoringValidationError';
        throw err;
    },

    _isArray: function(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    },

    /** Integer level 1..max; numeric strings are accepted (GlideRecord returns strings). */
    _parseLevel: function(value, name, max) {
        var n = (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) ? parseInt(value, 10) : value;
        if (typeof n !== 'number' || isNaN(n) || Math.floor(n) !== n || n < 1 || n > max) {
            this._fail(name + ' must be an integer between 1 and ' + max + ' (got "' + value + '")');
        }
        return n;
    },

    _parseNumber: function(value, name, min, max) {
        var n = (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) ? parseFloat(value) : value;
        if (typeof n !== 'number' || isNaN(n) || n < min || n > max) {
            this._fail(name + ' must be a number between ' + min + ' and ' + max + ' (got "' + value + '")');
        }
        return n;
    },

    _parseEffectiveness: function(value, name) {
        if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
            return this._parseNumber(value, name + ' effectiveness', 0, 1);
        }
        var key = String(value === undefined || value === null ? '' : value).toLowerCase().replace(/[\s-]+/g, '_');
        if (!this.config.effectivenessRatings.hasOwnProperty(key)) {
            this._fail(name + ' effectiveness "' + value + '" is not a configured rating');
        }
        return this.config.effectivenessRatings[key];
    },

    _parseDate: function(value, name) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value === undefined || value === null ? '' : value));
        if (!m) {
            this._fail(name + ' must be a date in YYYY-MM-DD format (got "' + value + '")');
        }
        var y = parseInt(m[1], 10);
        var mo = parseInt(m[2], 10) - 1;
        var d = parseInt(m[3], 10);
        var date = new Date(Date.UTC(y, mo, d));
        if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo || date.getUTCDate() !== d) {
            this._fail(name + ' is not a valid calendar date (got "' + value + '")');
        }
        return date;
    },

    _formatDate: function(date) {
        return date.toISOString().substring(0, 10);
    },

    _round: function(value, decimals) {
        var f = Math.pow(10, decimals);
        return Math.round((value + 1e-9) * f) / f;
    },

    _sum: function(values) {
        var total = 0;
        for (var i = 0; i < values.length; i++) {
            total += values[i];
        }
        return total;
    },

    _maxScore: function() {
        return this._cellMax;
    },

    _minScore: function() {
        return this._cellMin;
    },

    /** Shallow-per-key merge: nested plain objects merge one level deep, arrays replace. */
    _mergeConfig: function(base, override) {
        var out = {};
        var key;
        for (key in base) {
            if (base.hasOwnProperty(key)) {
                out[key] = base[key];
            }
        }
        for (key in override) {
            if (!override.hasOwnProperty(key)) {
                continue;
            }
            if (!base.hasOwnProperty(key)) {
                this._fail('unknown configuration key "' + key + '"');
            }
            var b = base[key];
            var o = override[key];
            if (b && o && typeof b === 'object' && typeof o === 'object' && !this._isArray(b) && !this._isArray(o)) {
                var merged = {};
                var k;
                for (k in b) {
                    if (b.hasOwnProperty(k)) {
                        merged[k] = b[k];
                    }
                }
                for (k in o) {
                    if (o.hasOwnProperty(k)) {
                        merged[k] = o[k];
                    }
                }
                out[key] = merged;
            } else {
                out[key] = o;
            }
        }
        return out;
    },

    _validateConfig: function(cfg) {
        if (!this._isArray(cfg.likelihoodLabels) || !this._isArray(cfg.impactLabels) ||
            cfg.likelihoodLabels.length < 2 || cfg.impactLabels.length < 2) {
            this._fail('likelihoodLabels and impactLabels must be arrays with at least 2 levels');
        }
        var nL = cfg.likelihoodLabels.length;
        var nI = cfg.impactLabels.length;

        var min = Infinity;
        var max = -Infinity;
        var l;
        var i;
        if (cfg.matrix !== null && cfg.matrix !== undefined) {
            if (!this._isArray(cfg.matrix) || cfg.matrix.length !== nL) {
                this._fail('matrix must have ' + nL + ' rows (one per likelihood level)');
            }
            for (l = 0; l < nL; l++) {
                if (!this._isArray(cfg.matrix[l]) || cfg.matrix[l].length !== nI) {
                    this._fail('matrix row ' + (l + 1) + ' must have ' + nI + ' columns');
                }
                for (i = 0; i < nI; i++) {
                    var cell = cfg.matrix[l][i];
                    if (typeof cell !== 'number' || isNaN(cell) || cell <= 0) {
                        this._fail('matrix cell [' + (l + 1) + '][' + (i + 1) + '] must be a positive number');
                    }
                    if ((l > 0 && cell < cfg.matrix[l - 1][i]) || (i > 0 && cell < cfg.matrix[l][i - 1])) {
                        this._fail('matrix must not decrease as likelihood or impact increases');
                    }
                    min = Math.min(min, cell);
                    max = Math.max(max, cell);
                }
            }
        } else {
            min = 1;
            max = nL * nI;
        }
        this._cellMin = min;
        this._cellMax = max;

        if (!this._isArray(cfg.bands) || cfg.bands.length === 0) {
            this._fail('bands must be a non-empty array');
        }
        for (var b = 0; b < cfg.bands.length; b++) {
            var band = cfg.bands[b];
            if (!band || typeof band.name !== 'string' || typeof band.max !== 'number') {
                this._fail('each band needs a name and a numeric max');
            }
            if (b > 0 && band.max <= cfg.bands[b - 1].max) {
                this._fail('band upper bounds must be strictly ascending');
            }
            if (typeof cfg.reviewIntervalDays[band.name] !== 'number' || cfg.reviewIntervalDays[band.name] <= 0) {
                this._fail('reviewIntervalDays must define a positive interval for band "' + band.name + '"');
            }
        }
        if (cfg.bands[cfg.bands.length - 1].max < max) {
            this._fail('the highest band must cover the maximum matrix score (' + max + ')');
        }

        var weightTotal = cfg.designWeight + cfg.operatingWeight;
        if (typeof cfg.designWeight !== 'number' || typeof cfg.operatingWeight !== 'number' ||
            cfg.designWeight < 0 || cfg.operatingWeight < 0 || Math.abs(weightTotal - 1) > 1e-9) {
            this._fail('designWeight and operatingWeight must be non-negative and sum to 1');
        }
        for (var r in cfg.effectivenessRatings) {
            if (cfg.effectivenessRatings.hasOwnProperty(r)) {
                var f = cfg.effectivenessRatings[r];
                if (typeof f !== 'number' || f < 0 || f > 1) {
                    this._fail('effectiveness rating "' + r + '" must be between 0 and 1');
                }
            }
        }
        if (cfg.controlAggregation !== 'complement' && cfg.controlAggregation !== 'max' && cfg.controlAggregation !== 'average') {
            this._fail('controlAggregation must be complement, max or average');
        }
        if (typeof cfg.maxReduction !== 'number' || cfg.maxReduction < 0 || cfg.maxReduction >= 1) {
            this._fail('maxReduction must be >= 0 and < 1');
        }

        this._validateAppetite(cfg.appetite, 'appetite');
        for (var cat in cfg.appetiteByCategory) {
            if (cfg.appetiteByCategory.hasOwnProperty(cat)) {
                this._validateAppetite(cfg.appetiteByCategory[cat], 'appetiteByCategory.' + cat);
            }
        }
    },

    _validateAppetite: function(a, name) {
        if (!a || typeof a.appetite !== 'number' || typeof a.tolerance !== 'number') {
            this._fail(name + ' must define numeric appetite and tolerance');
        }
        if (a.appetite < 0 || a.tolerance < a.appetite) {
            this._fail(name + ': tolerance must be greater than or equal to appetite, and both non-negative');
        }
    },

    type: 'RiskScoringCore'
};

// Lets Node.js tooling load this file; ignored on the ServiceNow platform.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RiskScoringCore;
}
