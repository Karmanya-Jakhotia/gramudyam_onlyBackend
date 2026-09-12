/**
 * Phase 5 — Business Readiness Score constants.
 *
 * Centralized here for the same reason as config/schemeRules.js and
 * config/guardrailRules.js: exactly one place owns the business rule.
 *
 * IMPORTANT PRODUCTION DECISION: the plan does not hand Gemini a formula
 * for `business_readiness_score`, and this implementation deliberately
 * does NOT ask Gemini to invent one either. A "readiness score" feeds the
 * same beneficiary-facing recommendation surface as `recommended_safe_loan`,
 * so it is computed deterministically from Phase 4's own guardrail output
 * (risk classification) plus Phase 2's market-data availability — never
 * from free-form model output. This keeps the guardrail-authority principle
 * ("Gemini must never be able to override recommended_safe_loan") intact
 * for the one other numeric signal in the final report that could
 * otherwise be mistaken for financial advice.
 */

/** Base score awarded purely from Phase 4's repayment risk classification. */
export const READINESS_BASE_SCORE_BY_RISK = Object.freeze({
  low_risk: 85,
  moderate_risk: 65,
  high_risk: 40,
  not_viable: 10,
});

/** Bonus for each independently-available real-world market data source (competitors, mandi price). */
export const READINESS_BONUS_PER_AVAILABLE_MARKET_SOURCE = 5;

/** Maximum total bonus from market-data availability, regardless of how many sources exist. */
export const READINESS_MAX_MARKET_DATA_BONUS = 10;

/** Penalty applied when the guardrail result is flagged as based on unverified/estimated assumptions. */
export const READINESS_ESTIMATE_PENALTY = 5;

export const READINESS_SCORE_MIN = 0;
export const READINESS_SCORE_MAX = 100;
