/**
 * Phase 4 — Deterministic Risk & Stress-Test Guardrail constants.
 *
 * Centralized here (not scattered through guardrails.js, the orchestrator,
 * or a Gemini prompt) per the same production rule that governs
 * config/schemeRules.js: business rules live in exactly one place.
 *
 * IMPORTANT: these are the plan's illustrative stress-test parameters, not
 * figures from a verified lending-risk policy. Before relying on this in
 * production, have these confirmed against GramUdyam's actual risk policy.
 */

/** Revenue/demand shock applied during stress testing: -20% of base revenue. */
export const REVENUE_SHOCK_PERCENT = -20;

/** Operating cost shock applied during stress testing: +15% of base operating costs. */
export const COST_SHOCK_PERCENT = 15;

/** Maximum share of the *stressed* monthly surplus that may be committed to EMI. */
export const MAX_DEBT_SERVICE_RATIO = 0.40;

/**
 * Working capital reserve, expressed as a number of months of *stressed*
 * operating costs the recommendation should hold back as a buffer, on top
 * of loan repayment.
 */
export const WORKING_CAPITAL_MONTHS = 1;

/**
 * Deterministic demand-dilution model for nearby competition: each
 * competitor within the market tool's search radius is assumed to erode
 * expected daily units by this fraction, capped at
 * MAX_COMPETITOR_DEMAND_DILUTION so a large competitor count can never
 * imply "more than X% of customers lost to competition" — an explicit,
 * documented assumption, not a hidden one.
 */
export const COMPETITOR_DEMAND_DILUTION_PER_COMPETITOR = 0.05;
export const MAX_COMPETITOR_DEMAND_DILUTION = 0.60;

/**
 * Repayment-risk classification bands, expressed as
 * (recommended safe loan / max eligible loan). Below MODERATE the
 * classification is "high_risk"; a non-positive stressed surplus is always
 * "not_viable" regardless of these ratios.
 */
export const RISK_BAND_LOW_MIN_RATIO = 0.75;
export const RISK_BAND_MODERATE_MIN_RATIO = 0.40;
