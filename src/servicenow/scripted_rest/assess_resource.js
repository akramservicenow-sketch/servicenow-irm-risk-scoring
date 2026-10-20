/**
 * Scripted REST API: "Risk Scoring" (scope x_irmrs, API ID risk_scoring)
 * Resource:          POST /api/x_irmrs/risk_scoring/assess
 *
 * Stateless what-if calculation: nothing is read from or written to risk records.
 *
 * Resource settings:
 *   Requires authentication: true
 *   Requires ACL authorization: true (REST_Endpoint ACL limited to role x_irmrs.risk_analyst)
 *
 * Request body:
 *   { "likelihood": 4, "impact": 5, "category": "Cyber",
 *     "controls": [ { "design": "effective", "operating": "partially_effective" } ] }
 *
 * Responses: 200 assessment | 400 validation error | 403 missing role
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {

    var REQUIRED_ROLE = 'x_irmrs.risk_analyst';
    var MAX_CONTROLS = 50;

    // Defence in depth: the resource ACL should already enforce this.
    if (!gs.hasRole(REQUIRED_ROLE)) {
        response.setStatus(403);
        response.setBody({ error: { message: 'Forbidden', detail: 'Role ' + REQUIRED_ROLE + ' is required' } });
        return;
    }

    var body = request.body ? request.body.data : null;
    if (!body || typeof body !== 'object') {
        response.setError(new sn_ws_err.BadRequestError('Request body must be a JSON object'));
        return;
    }
    if (body.controls && (Object.prototype.toString.call(body.controls) !== '[object Array]' || body.controls.length > MAX_CONTROLS)) {
        response.setError(new sn_ws_err.BadRequestError('controls must be an array of at most ' + MAX_CONTROLS + ' items'));
        return;
    }

    // Copy only the expected properties; ignore anything else the caller sends.
    var controls = [];
    var input = body.controls || [];
    for (var i = 0; i < input.length; i++) {
        controls.push({ design: input[i] && input[i].design, operating: input[i] && input[i].operating });
    }

    try {
        var result = new RiskScoringService().whatIf({
            likelihood: body.likelihood,
            impact: body.impact,
            category: typeof body.category === 'string' ? body.category : undefined,
            controls: controls
        });
        response.setStatus(200);
        response.setBody(result);
    } catch (e) {
        if (e.name === 'RiskScoringValidationError') {
            response.setError(new sn_ws_err.BadRequestError(e.message));
            return;
        }
        gs.error('Risk Scoring REST /assess failed: {0}', e.message);
        response.setStatus(500);
        response.setBody({ error: { message: 'Internal error' } });
    }

})(request, response);
