/**
 * Business Rule: "Roll up entity risk score"
 *
 *   Table:     x_irmrs_risk
 *   When:      after     Insert: true   Update: true   Delete: true   Order: 300
 *   Condition: current.residual_score.changes() || current.entity.changes() ||
 *              current.active.changes() || current.weight.changes() || current.operation() != 'update'
 *
 * Recalculates the aggregate score of the risk's entity, and of the previous entity
 * when a risk is reassigned (`previous` is only available in synchronous rules).
 * For very large registers, switch to async and schedule a nightly full roll-up.
 */
(function executeRule(current, previous) {

    var service = new RiskScoringService();
    var entityIds = [];
    if (current.getValue('entity')) {
        entityIds.push(current.getValue('entity'));
    }
    if (previous && previous.getValue('entity') && previous.getValue('entity') != current.getValue('entity')) {
        entityIds.push(previous.getValue('entity'));
    }

    for (var i = 0; i < entityIds.length; i++) {
        try {
            service.rollUpEntity(entityIds[i]);
        } catch (e) {
            gs.error('Roll up entity risk score: entity {0} failed: {1}', entityIds[i], e.message);
        }
    }

})(current, previous);
