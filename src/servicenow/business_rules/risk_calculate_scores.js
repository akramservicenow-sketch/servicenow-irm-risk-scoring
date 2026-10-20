/**
 * Business Rule: "Calculate risk scores"
 *
 *   Table:     x_irmrs_risk
 *   When:      before    Insert: true   Update: true    Order: 100
 *   Condition: current.likelihood.changes() || current.impact.changes() ||
 *              current.category.changes() || current.operation() == 'insert'
 *
 * Runs before the save, so values set on `current` are persisted without calling
 * current.update(). Control changes are handled by "Rescore risk on control change".
 */
(function executeRule(current, previous /*null when async*/) {

    try {
        new RiskScoringService().applyToRecord(current);
    } catch (e) {
        // Validation errors from RiskScoringCore are user-facing (e.g. impact out of range).
        gs.addErrorMessage(gs.getMessage('Risk score could not be calculated: {0}', [e.message]));
        current.setAbortAction(true);
    }

})(current, previous);
