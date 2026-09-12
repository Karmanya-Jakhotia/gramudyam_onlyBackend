import {
  READINESS_BASE_SCORE_BY_RISK,
  READINESS_BONUS_PER_AVAILABLE_MARKET_SOURCE,
  READINESS_MAX_MARKET_DATA_BONUS,
  READINESS_ESTIMATE_PENALTY,
  READINESS_SCORE_MIN,
  READINESS_SCORE_MAX,
} from '../config/scoringRules.js';

/**
 * Phase 5 — deterministic business readiness score.
 *
 * Never derived from Gemini output. See config/scoringRules.js for the
 * rationale. Pure function of Phase 4's guardrail result and Phase 2's
 * market snapshot — fully unit-testable without any network or model call.
 */

export class ScoringValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ScoringValidationError';
    this.status = 422;
    this.field = field;
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Counts how many independent real-world market data sources came back
 * `available: true` in a Phase 2 market snapshot ({ competitors, mandi }).
 * A missing/absent snapshot counts as zero available sources rather than
 * throwing — the report can still be produced without market data, per
 * the plan's "return a controlled error rather than fabricated values"
 * principle (here: no fabricated bonus, not a hard failure).
 */
export function countAvailableMarketSources(marketSnapshot) {
  if (!marketSnapshot || typeof marketSnapshot !== 'object') return 0;
  let count = 0;
  if (marketSnapshot.competitors?.available === true) count += 1;
  if (marketSnapshot.mandi?.available === true) count += 1;
  return count;
}

/**
 * @param {{repaymentRiskClassification: string, isEstimate: boolean}} guardrailResult
 * @param {{competitors?: object, mandi?: object}} [marketSnapshot]
 * @returns {number} an integer in [0, 100]
 */
export function calculateBusinessReadinessScore(guardrailResult, marketSnapshot = null) {
  if (!guardrailResult || typeof guardrailResult !== 'object') {
    throw new ScoringValidationError('guardrailResult is required', 'guardrailResult');
  }
  const risk = guardrailResult.repaymentRiskClassification;
  const base = READINESS_BASE_SCORE_BY_RISK[risk];
  if (base === undefined) {
    throw new ScoringValidationError(
      `Unknown repaymentRiskClassification "${risk}"`,
      'repaymentRiskClassification'
    );
  }

  const availableSources = countAvailableMarketSources(marketSnapshot);
  const marketBonus = Math.min(
    READINESS_MAX_MARKET_DATA_BONUS,
    availableSources * READINESS_BONUS_PER_AVAILABLE_MARKET_SOURCE
  );

  const estimatePenalty = guardrailResult.isEstimate ? READINESS_ESTIMATE_PENALTY : 0;

  const raw = base + marketBonus - estimatePenalty;
  return Math.round(clamp(raw, READINESS_SCORE_MIN, READINESS_SCORE_MAX));
}
