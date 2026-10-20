/**
 * Flow Designer custom action: "Calculate Risk Score" (scope x_irmrs)
 * Script step body.
 *
 * Action inputs  -> script step inputs:
 *   risk_sys_id (String, mandatory)
 *
 * Script step outputs (map each to an action output of the same name):
 *   inherent_score (Decimal), inherent_rating (String), control_effectiveness (Decimal),
 *   residual_score (Decimal), residual_rating (String), appetite_status (String),
 *   review_due_date (String, yyyy-MM-dd), exceeds_tolerance (True/False)
 *
 * Throwing an Error marks the step as failed so the flow's error handling can react.
 */
(function execute(inputs, outputs) {

    if (!inputs.risk_sys_id) {
        throw new Error('risk_sys_id is required');
    }

    var result = new x_irmrs.RiskScoringService().scoreRisk(inputs.risk_sys_id);
    if (!result) {
        throw new Error('Risk not found: ' + inputs.risk_sys_id);
    }

    outputs.inherent_score = result.inherent.score;
    outputs.inherent_rating = result.inherent.rating;
    outputs.control_effectiveness = result.controlEffectiveness.applied;
    outputs.residual_score = result.residual.score;
    outputs.residual_rating = result.residual.rating;
    outputs.appetite_status = result.appetite.status;
    outputs.review_due_date = result.reviewDueDate;
    outputs.exceeds_tolerance = result.appetite.status == x_irmrs.RiskScoringCore.APPETITE_STATUS.EXCEEDS_TOLERANCE;

})(inputs, outputs);
