/**
 * RiskScoringService
 *
 * Thin ServiceNow wrapper around RiskScoringCore. This is the only layer that touches
 * GlideRecord / gs: it reads risk, control and entity records, delegates every
 * calculation to the core, and writes results back.
 *
 * Script Include settings: scope x_irmrs, name RiskScoringService,
 * Accessible from "This application scope only", Client callable = false.
 *
 * Tables and fields used (create them in Studio; see README "Data model"):
 *   x_irmrs_risk    likelihood, impact, category, entity, weight, active,
 *                   inherent_score, inherent_rating, control_effectiveness,
 *                   residual_score, residual_rating, appetite_status, next_review_date
 *   x_irmrs_control risk, design_effectiveness, operating_effectiveness, active
 *   x_irmrs_entity  aggregate_score, aggregate_rating, risk_count, aggregate_driver
 */
var RiskScoringService = Class.create();

RiskScoringService.PROPERTIES = {
    CONFIG: 'x_irmrs.scoring_config',
    RISK_TABLE: 'x_irmrs.risk_table',
    CONTROL_TABLE: 'x_irmrs.control_table',
    ENTITY_TABLE: 'x_irmrs.entity_table',
    ENTITY_AGGREGATION: 'x_irmrs.entity_aggregation'
};

RiskScoringService.prototype = {

    /**
     * @param {Object} [options] { config, riskTable, controlTable, entityTable } (mainly for tests)
     */
    initialize: function(options) {
        options = options || {};
        var P = RiskScoringService.PROPERTIES;
        this.riskTable = options.riskTable || gs.getProperty(P.RISK_TABLE, 'x_irmrs_risk');
        this.controlTable = options.controlTable || gs.getProperty(P.CONTROL_TABLE, 'x_irmrs_control');
        this.entityTable = options.entityTable || gs.getProperty(P.ENTITY_TABLE, 'x_irmrs_entity');
        this.core = new RiskScoringCore(options.config || this._loadConfig());
    },

    /**
     * Active controls linked to a risk, in the shape RiskScoringCore expects.
     */
    getControlsForRisk: function(riskSysId) {
        var controls = [];
        var gr = new GlideRecord(this.controlTable);
        gr.addQuery('risk', riskSysId);
        gr.addActiveQuery();
        gr.query();
        while (gr.next()) {
            controls.push({
                id: gr.getUniqueValue(),
                design: gr.getValue('design_effectiveness'),
                operating: gr.getValue('operating_effectiveness')
            });
        }
        return controls;
    },

    /** Assess a risk GlideRecord without modifying it. */
    assessRecord: function(riskGr) {
        return this.core.assess({
            id: riskGr.getUniqueValue(),
            likelihood: riskGr.getValue('likelihood'),
            impact: riskGr.getValue('impact'),
            category: riskGr.getValue('category'),
            controls: this.getControlsForRisk(riskGr.getUniqueValue()),
            assessedOn: this._today()
        });
    },

    /**
     * Assess and copy the results onto the record. Does NOT save it, so it is safe to
     * call from a before Business Rule (where calling current.update() would recurse).
     */
    applyToRecord: function(riskGr) {
        var result = this.assessRecord(riskGr);
        riskGr.setValue('inherent_score', result.inherent.score);
        riskGr.setValue('inherent_rating', result.inherent.rating);
        riskGr.setValue('control_effectiveness', result.controlEffectiveness.applied);
        riskGr.setValue('residual_score', result.residual.score);
        riskGr.setValue('residual_rating', result.residual.rating);
        riskGr.setValue('appetite_status', result.appetite.status);
        riskGr.setValue('next_review_date', result.reviewDueDate);
        return result;
    },

    /**
     * Load, score and save a risk by sys_id (for async rules, flows and scheduled jobs).
     * @returns {Object|null} assessment, or null when the risk does not exist
     */
    scoreRisk: function(riskSysId) {
        if (!riskSysId) {
            return null;
        }
        var gr = new GlideRecord(this.riskTable);
        if (!gr.get(riskSysId)) {
            gs.warn('RiskScoringService: risk {0} not found in {1}', riskSysId, this.riskTable);
            return null;
        }
        var result = this.applyToRecord(gr);
        gr.update();
        return result;
    },

    /**
     * Recalculate an entity's aggregate score from its active, scored risks.
     * @returns {Object|null} aggregate, or null when the entity does not exist
     */
    rollUpEntity: function(entitySysId, method) {
        if (!entitySysId) {
            return null;
        }
        var entity = new GlideRecord(this.entityTable);
        if (!entity.get(entitySysId)) {
            gs.warn('RiskScoringService: entity {0} not found in {1}', entitySysId, this.entityTable);
            return null;
        }

        var risks = [];
        var gr = new GlideRecord(this.riskTable);
        gr.addQuery('entity', entitySysId);
        gr.addActiveQuery();
        gr.addNotNullQuery('residual_score');
        gr.query();
        while (gr.next()) {
            risks.push({
                id: gr.getUniqueValue(),
                residualScore: gr.getValue('residual_score'),
                weight: gr.getValue('weight')
            });
        }

        var aggMethod = method || gs.getProperty(RiskScoringService.PROPERTIES.ENTITY_AGGREGATION, '') || undefined;
        var agg = this.core.aggregate(risks, aggMethod);
        entity.setValue('aggregate_score', agg.score === null ? '' : agg.score);
        entity.setValue('aggregate_rating', agg.rating);
        entity.setValue('risk_count', agg.count);
        entity.setValue('aggregate_driver', agg.driverId || '');
        entity.update();
        return agg;
    },

    /** Stateless what-if assessment (no records read or written). */
    whatIf: function(input) {
        input = input || {};
        return this.core.assess({
            likelihood: input.likelihood,
            impact: input.impact,
            category: input.category,
            controls: input.controls || [],
            assessedOn: input.assessedOn || this._today()
        });
    },

    /**
     * Read the JSON configuration override from a system property. Invalid JSON is
     * logged and ignored so a bad property value cannot block record saves.
     */
    _loadConfig: function() {
        var raw = gs.getProperty(RiskScoringService.PROPERTIES.CONFIG, '');
        if (!raw) {
            return {};
        }
        try {
            return JSON.parse(raw);
        } catch (e) {
            gs.error('RiskScoringService: property {0} is not valid JSON ({1}); using defaults',
                RiskScoringService.PROPERTIES.CONFIG, e.message);
            return {};
        }
    },

    /** Today's date (yyyy-MM-dd) in the instance's internal format. */
    _today: function() {
        return new GlideDate().getValue();
    },

    type: 'RiskScoringService'
};
