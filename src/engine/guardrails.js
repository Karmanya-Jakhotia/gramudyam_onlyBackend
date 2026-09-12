import { MARGIN_RATIO } from '../config/schemeRules.js';
import {
  REVENUE_SHOCK_PERCENT,
  COST_SHOCK_PERCENT,
  MAX_DEBT_SERVICE_RATIO,
  WORKING_CAPITAL_MONTHS,
  COMPETITOR_DEMAND_DILUTION_PER_COMPETITOR,
  MAX_COMPETITOR_DEMAND_DILUTION,
  RISK_BAND_LOW_MIN_RATIO,
  RISK_BAND_MODERATE_MIN_RATIO,
} from '../config/guardrailRules.js';
import { calculateEmi, FinanceValidationError } from '../tools/finance.js';

/**
 * Phase 4 — Deterministic Risk & Stress-Test Guardrails.
 *
 * This module is GramUdyam's core financial safety layer:
 *
 *   Safe Loan  vs.  Maximum Eligible Loan
 *
 * Gemini (Phase 3) can recommend and explain a business plan, but it can
 * NEVER decide the final safe borrowing threshold — that number always
 * comes from this file, and this file never calls Gemini or any other
 * model. Every calculation here is plain deterministic arithmetic, unit
 * tested against known inputs.
 *
 * Processing flow (per the plan):
 *   Maximum Eligible Loan + Market Data
 *     -> Base Revenue Estimate
 *     -> Stress Revenue (demand/price shock)
 *     -> Operating Cost Shock
 *     -> Stressed Surplus
 *     -> Safe EMI Limit
 *     -> Safe Principal
 *     -> Recommended Safe Loan (never more than Maximum Eligible Loan)
 *
 * Production improvement over the prototype: the prototype silently
 * assumed `price * 30 * 20`. This module never assumes a selling price,
 * units/day, operating days/month, or costs on the caller's behalf —
 * `revenueAssumptions` and `costAssumptions` must be supplied explicitly.
 * The caller (Phase 5's report assembly / the orchestrator) is responsible
 * for sourcing those numbers and for setting `isEstimate: true` whenever
 * they are not verified local data. This module also flags its own
 * competitor-based demand adjustment as an estimate, since that dilution
 * is itself a modeling assumption, not observed fact.
 */

export class GuardrailValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'GuardrailValidationError';
    this.status = 422;
    this.field = field;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isNonNegativeFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

export function validateMaxEligibleLoan(maxEligibleLoan) {
  if (!isPositiveFiniteNumber(maxEligibleLoan)) {
    throw new GuardrailValidationError('maxEligibleLoan must be a positive finite number', 'maxEligibleLoan');
  }
  return maxEligibleLoan;
}

export function validateScheme(scheme) {
  if (!scheme || typeof scheme !== 'object') {
    throw new GuardrailValidationError('scheme is required', 'scheme');
  }
  if (!isNonNegativeFiniteNumber(scheme.interestRatePercent)) {
    throw new GuardrailValidationError('scheme.interestRatePercent must be a non-negative finite number', 'scheme.interestRatePercent');
  }
  if (!Number.isInteger(scheme.tenureMonths) || scheme.tenureMonths <= 0) {
    throw new GuardrailValidationError('scheme.tenureMonths must be a positive integer', 'scheme.tenureMonths');
  }
  return scheme;
}

export function validateRevenueAssumptions(revenueAssumptions) {
  if (!revenueAssumptions || typeof revenueAssumptions !== 'object') {
    throw new GuardrailValidationError('revenueAssumptions is required', 'revenueAssumptions');
  }
  const { sellingPrice, unitsPerDay, operatingDaysPerMonth, seasonalityFactor = 1 } = revenueAssumptions;
  if (!isPositiveFiniteNumber(sellingPrice)) {
    throw new GuardrailValidationError('revenueAssumptions.sellingPrice must be a positive finite number', 'revenueAssumptions.sellingPrice');
  }
  if (!isNonNegativeFiniteNumber(unitsPerDay)) {
    throw new GuardrailValidationError('revenueAssumptions.unitsPerDay must be a non-negative finite number', 'revenueAssumptions.unitsPerDay');
  }
  if (!Number.isInteger(operatingDaysPerMonth) || operatingDaysPerMonth <= 0 || operatingDaysPerMonth > 31) {
    throw new GuardrailValidationError('revenueAssumptions.operatingDaysPerMonth must be an integer between 1 and 31', 'revenueAssumptions.operatingDaysPerMonth');
  }
  if (!isPositiveFiniteNumber(seasonalityFactor)) {
    throw new GuardrailValidationError('revenueAssumptions.seasonalityFactor must be a positive finite number', 'revenueAssumptions.seasonalityFactor');
  }
  return { sellingPrice, unitsPerDay, operatingDaysPerMonth, seasonalityFactor };
}

export function validateCostAssumptions(costAssumptions) {
  if (!costAssumptions || typeof costAssumptions !== 'object') {
    throw new GuardrailValidationError('costAssumptions is required', 'costAssumptions');
  }
  const { fixedCostsPerMonth, variableCostPerUnit } = costAssumptions;
  if (!isNonNegativeFiniteNumber(fixedCostsPerMonth)) {
    throw new GuardrailValidationError('costAssumptions.fixedCostsPerMonth must be a non-negative finite number', 'costAssumptions.fixedCostsPerMonth');
  }
  if (!isNonNegativeFiniteNumber(variableCostPerUnit)) {
    throw new GuardrailValidationError('costAssumptions.variableCostPerUnit must be a non-negative finite number', 'costAssumptions.variableCostPerUnit');
  }
  return { fixedCostsPerMonth, variableCostPerUnit };
}

// ---------------------------------------------------------------------
// Deterministic demand adjustment for nearby competition
// ---------------------------------------------------------------------

/**
 * Applies the documented, explicit competitor-dilution model to a base
 * units/day figure. Never invents a competitor count itself — it only
 * transforms one that was actually returned by the Phase 2 market tool
 * (`available: true`). Absent or unavailable market data leaves demand
 * unadjusted and `applied: false`.
 */
export function adjustDemandForCompetition({ baseUnitsPerDay, marketData }) {
  if (!isNonNegativeFiniteNumber(baseUnitsPerDay)) {
    throw new GuardrailValidationError('baseUnitsPerDay must be a non-negative finite number', 'baseUnitsPerDay');
  }
  const competitorCount5km = marketData?.competitorCount5km;
  if (!marketData || marketData.available !== true || !isNonNegativeFiniteNumber(competitorCount5km)) {
    return { adjustedUnitsPerDay: baseUnitsPerDay, applied: false, dilution: 0 };
  }

  const dilution = Math.min(MAX_COMPETITOR_DEMAND_DILUTION, competitorCount5km * COMPETITOR_DEMAND_DILUTION_PER_COMPETITOR);
  return {
    adjustedUnitsPerDay: round2(baseUnitsPerDay * (1 - dilution)),
    applied: true,
    dilution,
  };
}

// ---------------------------------------------------------------------
// Revenue / cost / surplus math
// ---------------------------------------------------------------------

export function calculateBaseRevenue({ sellingPrice, unitsPerDay, operatingDaysPerMonth, seasonalityFactor = 1 }) {
  return round2(sellingPrice * unitsPerDay * operatingDaysPerMonth * seasonalityFactor);
}

export function calculateOperatingCosts({ fixedCostsPerMonth, variableCostPerUnit, unitsPerDay, operatingDaysPerMonth }) {
  return round2(fixedCostsPerMonth + variableCostPerUnit * unitsPerDay * operatingDaysPerMonth);
}

/** Revenue/demand shock: a negative REVENUE_SHOCK_PERCENT reduces revenue. */
export function applyRevenueShock(monthlyRevenue, shockPercent = REVENUE_SHOCK_PERCENT) {
  return round2(monthlyRevenue * (1 + shockPercent / 100));
}

/** Operating cost shock: a positive COST_SHOCK_PERCENT increases costs. */
export function applyCostShock(monthlyCosts, shockPercent = COST_SHOCK_PERCENT) {
  return round2(monthlyCosts * (1 + shockPercent / 100));
}

export function calculateStressedSurplus({ stressedRevenue, stressedCosts }) {
  return round2(stressedRevenue - stressedCosts);
}

/** The share of the stressed surplus that may go toward EMI. Never negative. */
export function calculateSafeEmiLimit(stressedSurplus, ratio = MAX_DEBT_SERVICE_RATIO) {
  return round2(Math.max(0, stressedSurplus) * ratio);
}

/**
 * Inverse of the standard reducing-balance EMI formula: given a target EMI,
 * what principal does it support at this rate/tenure? Falls back to a
 * straight-line EMI*n when the rate is 0, mirroring calculateEmi's own
 * zero-rate fallback in finance.js so the two stay consistent inverses of
 * each other.
 */
export function solvePrincipalFromEmi({ emi, annualInterestRatePercent, tenureMonths }) {
  if (!isNonNegativeFiniteNumber(emi)) {
    throw new GuardrailValidationError('emi must be a non-negative finite number', 'emi');
  }
  if (!isNonNegativeFiniteNumber(annualInterestRatePercent)) {
    throw new GuardrailValidationError('annualInterestRatePercent must be a non-negative finite number', 'annualInterestRatePercent');
  }
  if (!Number.isInteger(tenureMonths) || tenureMonths <= 0) {
    throw new GuardrailValidationError('tenureMonths must be a positive integer', 'tenureMonths');
  }
  if (emi === 0) return 0;

  const monthlyRate = annualInterestRatePercent / 12 / 100;
  if (monthlyRate === 0) {
    return round2(emi * tenureMonths);
  }
  const factor = Math.pow(1 + monthlyRate, tenureMonths);
  return round2((emi * (factor - 1)) / (monthlyRate * factor));
}

/**
 * Repayment risk classification. A non-positive stressed surplus is always
 * "not_viable" — the business does not cover its own stressed operating
 * costs, so no loan amount is safe regardless of eligibility. Otherwise,
 * risk is banded by how much of the maximum eligible loan the safe
 * recommendation actually uses.
 */
export function classifyRepaymentRisk({ recommendedSafeLoan, maxEligibleLoan, stressedSurplus }) {
  if (stressedSurplus <= 0) return 'not_viable';
  const ratio = maxEligibleLoan > 0 ? recommendedSafeLoan / maxEligibleLoan : 0;
  if (ratio >= RISK_BAND_LOW_MIN_RATIO) return 'low_risk';
  if (ratio >= RISK_BAND_MODERATE_MIN_RATIO) return 'moderate_risk';
  return 'high_risk';
}

// ---------------------------------------------------------------------
// Full guardrail pipeline
// ---------------------------------------------------------------------

/**
 * Runs the complete Phase 4 pipeline and returns the final, authoritative
 * guardrail result. This is what Phase 5's report assembly must use for
 * `recommended_safe_loan` — never a Gemini-produced number.
 *
 * @param {number} maxEligibleLoan - from Phase 2's calculateLoanBounds().maxLoan
 * @param {{interestRatePercent:number, tenureMonths:number}} scheme - from Phase 2's selectScheme()
 * @param {{sellingPrice:number, unitsPerDay:number, operatingDaysPerMonth:number, seasonalityFactor?:number}} revenueAssumptions
 * @param {{fixedCostsPerMonth:number, variableCostPerUnit:number}} costAssumptions
 * @param {object} [marketData] - optional Phase 2 competitor snapshot ({available, competitorCount5km, ...})
 * @param {boolean} [isEstimate=false] - caller declares the assumptions above are not verified local data
 */
export function applyGuardrails({
  maxEligibleLoan,
  scheme,
  revenueAssumptions,
  costAssumptions,
  marketData = null,
  isEstimate = false,
} = {}) {
  validateMaxEligibleLoan(maxEligibleLoan);
  const validScheme = validateScheme(scheme);
  const { sellingPrice, unitsPerDay, operatingDaysPerMonth, seasonalityFactor } = validateRevenueAssumptions(revenueAssumptions);
  const { fixedCostsPerMonth, variableCostPerUnit } = validateCostAssumptions(costAssumptions);

  const demandAdjustment = adjustDemandForCompetition({ baseUnitsPerDay: unitsPerDay, marketData });
  const effectiveUnitsPerDay = demandAdjustment.adjustedUnitsPerDay;

  const baseRevenue = calculateBaseRevenue({ sellingPrice, unitsPerDay: effectiveUnitsPerDay, operatingDaysPerMonth, seasonalityFactor });
  const operatingCosts = calculateOperatingCosts({ fixedCostsPerMonth, variableCostPerUnit, unitsPerDay: effectiveUnitsPerDay, operatingDaysPerMonth });
  const baseSurplus = round2(baseRevenue - operatingCosts);

  const stressedRevenue = applyRevenueShock(baseRevenue);
  const stressedCosts = applyCostShock(operatingCosts);
  const stressedSurplus = calculateStressedSurplus({ stressedRevenue, stressedCosts });

  let recommendedSafeLoan = 0;
  let safeEmiLimit = 0;

  if (stressedSurplus > 0) {
    safeEmiLimit = calculateSafeEmiLimit(stressedSurplus);
    const safePrincipal = solvePrincipalFromEmi({
      emi: safeEmiLimit,
      annualInterestRatePercent: validScheme.interestRatePercent,
      tenureMonths: validScheme.tenureMonths,
    });
    recommendedSafeLoan = round2(Math.min(safePrincipal, maxEligibleLoan));
  }

  // Core invariant. Gemini must never be able to override this: the final
  // API response always uses this clamped value, regardless of anything
  // computed above. Kept as an explicit, defensive re-clamp rather than
  // trusting the branch above to have gotten it right.
  recommendedSafeLoan = round2(Math.min(Math.max(recommendedSafeLoan, 0), maxEligibleLoan));

  const repaymentRiskClassification = classifyRepaymentRisk({ recommendedSafeLoan, maxEligibleLoan, stressedSurplus });

  const monthlySafeEmi = recommendedSafeLoan > 0
    ? calculateEmi({
        loanAmount: recommendedSafeLoan,
        annualInterestRatePercent: validScheme.interestRatePercent,
        tenureMonths: validScheme.tenureMonths,
      }).monthlyEmi
    : 0;

  const recommendedProjectCost = recommendedSafeLoan > 0
    ? round2(recommendedSafeLoan / (1 - MARGIN_RATIO))
    : 0;

  const workingCapitalReserve = round2(WORKING_CAPITAL_MONTHS * Math.max(stressedCosts, 0));

  const warnings = [];
  if (demandAdjustment.applied) {
    warnings.push('Expected demand was adjusted downward for nearby competitor density; treat as a modeled estimate, not verified local demand.');
  }
  if (isEstimate) {
    warnings.push('Revenue/cost assumptions were supplied as estimates, not verified local data.');
  }

  return {
    maxEligibleLoan,
    recommendedSafeLoan,
    recommendedProjectCost,
    workingCapitalReserve,
    monthlySafeEmi,
    repaymentRiskClassification,
    baseRevenue,
    operatingCosts,
    baseSurplus,
    stressedRevenue,
    stressedCosts,
    stressedSurplus,
    safeEmiLimit,
    demandAdjustment,
    isEstimate: isEstimate || demandAdjustment.applied,
    warnings,
    assumptions: {
      sellingPrice,
      unitsPerDay,
      effectiveUnitsPerDay,
      operatingDaysPerMonth,
      seasonalityFactor,
      fixedCostsPerMonth,
      variableCostPerUnit,
    },
    shockParameters: {
      revenueShockPercent: REVENUE_SHOCK_PERCENT,
      costShockPercent: COST_SHOCK_PERCENT,
      maxDebtServiceRatio: MAX_DEBT_SERVICE_RATIO,
    },
  };
}

// Re-exported so callers/tests that only import from guardrails.js can
// still recognize a Phase 2 finance error surfacing through calculateEmi.
export { FinanceValidationError };
