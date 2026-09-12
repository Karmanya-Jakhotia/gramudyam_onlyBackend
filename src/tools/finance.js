import { SCHEME_TIERS, MARGIN_RATIO, KNOWN_BUSINESS_CATEGORIES } from '../config/schemeRules.js';

/**
 * Deterministic financial calculations for GramUdyam's margin-capital-based
 * loan scheme. This module must remain independent of Gemini reasoning —
 * nothing here calls an LLM, and nothing here should ever be replaced by
 * an LLM-generated number. Gemini may *ask* for a financial summary via
 * the orchestrator (Phase 3), but the math always comes from here.
 *
 * Core rule:
 *   Margin Capital = 10% of Project Cost
 *   Loan            = 90% of Project Cost
 * Therefore:
 *   Max Project Cost = Margin Capital / 0.10
 *   Max Loan          = Max Project Cost * 0.90
 */

export class FinanceValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'FinanceValidationError';
    this.status = 422;
    this.field = field;
  }
}

/**
 * Validates a margin-capital amount. Throws rather than silently clamping
 * or coercing — a wrong loan-eligibility number is a real-money mistake.
 */
export function validateMarginCapital(marginCapital) {
  if (typeof marginCapital !== 'number' || !Number.isFinite(marginCapital)) {
    throw new FinanceValidationError('marginCapital must be a finite number', 'marginCapital');
  }
  if (marginCapital <= 0) {
    throw new FinanceValidationError('marginCapital must be greater than zero', 'marginCapital');
  }
  return marginCapital;
}

/** Optional — the app doesn't currently collect a business category, but if one is passed, it must be recognized. */
export function validateBusinessCategory(category) {
  if (category === null || category === undefined) return null;
  if (typeof category !== 'string' || !KNOWN_BUSINESS_CATEGORIES.includes(category)) {
    throw new FinanceValidationError(
      `Unknown business category "${category}". Expected one of: ${KNOWN_BUSINESS_CATEGORIES.join(', ')}`,
      'businessCategory'
    );
  }
  return category;
}

/** Project Cost = Margin Capital / 0.10 */
export function calculateProjectCost(marginCapital) {
  validateMarginCapital(marginCapital);
  return round2(marginCapital / MARGIN_RATIO);
}

/** { maxProjectCost, maxLoan, marginRequired } from a margin-capital amount. */
export function calculateLoanBounds(marginCapital) {
  const maxProjectCost = calculateProjectCost(marginCapital);
  const maxLoan = round2(maxProjectCost * (1 - MARGIN_RATIO));
  const marginRequired = round2(maxProjectCost * MARGIN_RATIO);
  return { maxProjectCost, maxLoan, marginRequired };
}

/**
 * Looks up the applicable scheme tier for a given project cost.
 * Tiers are ordered ascending by maxProjectCost; the first tier that
 * covers the project cost applies (boundary value itself falls in the
 * lower tier, e.g. exactly 100000 is still "PMEGP (Micro)").
 */
export function selectScheme(projectCost) {
  if (typeof projectCost !== 'number' || !Number.isFinite(projectCost) || projectCost <= 0) {
    throw new FinanceValidationError('projectCost must be a positive finite number', 'projectCost');
  }
  const tier = SCHEME_TIERS.find((t) => projectCost <= t.maxProjectCost);
  // SCHEME_TIERS always ends in Infinity, so `tier` is never undefined for
  // a valid positive projectCost — this is a defensive guard, not a real path.
  if (!tier) {
    throw new FinanceValidationError('No scheme tier configured for this project cost', 'projectCost');
  }
  const { maxProjectCost, ...scheme } = tier;
  return scheme;
}

/**
 * Standard reducing-balance EMI formula:
 *   EMI = P * r * (1 + r)^n / ((1 + r)^n - 1)
 * where r is the monthly interest rate and n is the tenure in months.
 * Falls back to a straight-line P/n when the rate is 0 (formula above is
 * undefined at r=0).
 */
export function calculateEmi({ loanAmount, annualInterestRatePercent, tenureMonths }) {
  if (typeof loanAmount !== 'number' || !Number.isFinite(loanAmount) || loanAmount <= 0) {
    throw new FinanceValidationError('loanAmount must be a positive finite number', 'loanAmount');
  }
  if (typeof annualInterestRatePercent !== 'number' || !Number.isFinite(annualInterestRatePercent) || annualInterestRatePercent < 0) {
    throw new FinanceValidationError('annualInterestRatePercent must be a non-negative finite number', 'annualInterestRatePercent');
  }
  if (!Number.isInteger(tenureMonths) || tenureMonths <= 0) {
    throw new FinanceValidationError('tenureMonths must be a positive integer', 'tenureMonths');
  }

  const monthlyRate = annualInterestRatePercent / 12 / 100;
  let emi;
  if (monthlyRate === 0) {
    emi = loanAmount / tenureMonths;
  } else {
    const factor = Math.pow(1 + monthlyRate, tenureMonths);
    emi = (loanAmount * monthlyRate * factor) / (factor - 1);
  }

  const monthlyEmi = round2(emi);
  const totalRepayment = round2(monthlyEmi * tenureMonths);
  const totalInterest = round2(totalRepayment - loanAmount);
  return { monthlyEmi, totalRepayment, totalInterest };
}

/**
 * Orchestrates the full deterministic financial summary for a given
 * margin capital: eligibility bounds, applicable scheme, and EMI on the
 * maximum eligible loan. This is what the orchestrator (Phase 3) calls —
 * Gemini requests this tool, never recomputes the numbers itself.
 */
export function returnFinancialSummary({ marginCapital, businessCategory = null } = {}) {
  validateMarginCapital(marginCapital);
  validateBusinessCategory(businessCategory);

  const { maxProjectCost, maxLoan, marginRequired } = calculateLoanBounds(marginCapital);
  const scheme = selectScheme(maxProjectCost);
  const emi = calculateEmi({
    loanAmount: maxLoan,
    annualInterestRatePercent: scheme.interestRatePercent,
    tenureMonths: scheme.tenureMonths,
  });

  return {
    marginCapital,
    maxProjectCost,
    maxLoan,
    marginRequired,
    scheme,
    monthlyEmi: emi.monthlyEmi,
    totalInterest: emi.totalInterest,
    totalRepayment: emi.totalRepayment,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
