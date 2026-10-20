/**
 * Business Rule: "Rescore risk on control change"
 *
 *   Table:     x_irmrs_control
 *   When:      after     Insert: true   Update: true   Delete: true   Order: 200
 *   Condition: current.design_effectiveness.changes() || current.operating_effectiveness.changes() ||
 *              current.active.changes() || current.risk.changes() || current.operation() != 'update'
 *
 * An after rule (rather than async) is used because `previous` is only available
 * in synchronous rules; if the control moved to another risk, the previous risk is
 * rescored too. The parent risk is saved through RiskScoringService.scoreRisk(), never
 * through current.update().
 */
(function executeRule(current, previous) {

    var service = new RiskScoringService();
    var riskIds = [current.getValue('risk')];
    if (previous && previous.getValue('risk') && previous.getValue('risk') != current.getValue('risk')) {
        riskIds.push(previous.getValue('risk'));
    }

    for (var i = 0; i < riskIds.length; i++) {
        try {
            service.scoreRisk(riskIds[i]);
        } catch (e) {
            gs.error('Rescore risk on control change: risk {0} failed: {1}', riskIds[i], e.message);
        }
    }

})(current, previous);
