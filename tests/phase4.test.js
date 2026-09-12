import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGuardrails,
  adjustDemandForCompetition,
  calculateBaseRevenue,
  calculateOperatingCosts,
  applyRevenueShock,
  applyCostShock,
  calculateStressedSurplus,
  calculateSafeEmiLimit,
  solvePrincipalFromEmi,
  classifyRepaymentRisk,
  validateMaxEligibleLoan,
  validateScheme,
  validateRevenueAssumptions,
  validateCostAssumptions,
  GuardrailValidationError,
} from '../src/engine/guardrails.js';
import { calculateEmi } from '../src/tools/finance.js';
import {
  REVENUE_SHOCK_PERCENT,
  COST_SHOCK_PERCENT,
  MAX_DEBT_SERVICE_RATIO,
  MAX_COMPETITOR_DEMAND_DILUTION,
} from '../src/config/guardrailRules.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}

const SCHEME = { interestRatePercent: 9, tenureMonths: 60 };

const NORMAL_REVENUE = { sellingPrice: 50, unitsPerDay: 20, operatingDaysPerMonth: 26 };
const NORMAL_COSTS = { fixedCostsPerMonth: 5000, variableCostPerUnit: 10 };

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

describe('guardrails: shock math building blocks', () => {
  test('applyRevenueShock reduces revenue by the configured percent (-20%)', () => {
    assert.equal(REVENUE_SHOCK_PERCENT, -20);
    assert.equal(applyRevenueShock(10000), 8000);
  });

  test('applyCostShock increases costs by the configured percent (+15%)', () => {
    assert.equal(COST_SHOCK_PERCENT, 15);
    assert.equal(applyCostShock(10000), 11500);
  });

  test('calculateBaseRevenue and calculateOperatingCosts are explicit, no hidden assumptions', () => {
    assert.equal(calculateBaseRevenue({ sellingPrice: 50, unitsPerDay: 20, operatingDaysPerMonth: 26 }), 26000);
    assert.equal(
      calculateOperatingCosts({ fixedCostsPerMonth: 5000, variableCostPerUnit: 10, unitsPerDay: 20, operatingDaysPerMonth: 26 }),
      10200
    );
  });

  test('calculateStressedSurplus is stressedRevenue - stressedCosts', () => {
    assert.equal(calculateStressedSurplus({ stressedRevenue: 20800, stressedCosts: 11730 }), 9070);
  });

  test('calculateSafeEmiLimit applies the max debt-service ratio and floors at zero', () => {
    assert.equal(MAX_DEBT_SERVICE_RATIO, 0.40);
    assert.equal(calculateSafeEmiLimit(9070), 3628);
    assert.equal(calculateSafeEmiLimit(-500), 0);
  });

  test('solvePrincipalFromEmi is the true inverse of calculateEmi', () => {
    const { monthlyEmi } = calculateEmi({ loanAmount: 500000, annualInterestRatePercent: 9, tenureMonths: 60 });
    const principal = solvePrincipalFromEmi({ emi: monthlyEmi, annualInterestRatePercent: 9, tenureMonths: 60 });
    assert.ok(Math.abs(principal - 500000) < 1); // rounding tolerance
  });

  test('solvePrincipalFromEmi handles the zero-interest fallback consistently with calculateEmi', () => {
    const { monthlyEmi } = calculateEmi({ loanAmount: 120000, annualInterestRatePercent: 0, tenureMonths: 12 });
    const principal = solvePrincipalFromEmi({ emi: monthlyEmi, annualInterestRatePercent: 0, tenureMonths: 12 });
    assert.equal(principal, 120000);
  });

  test('solvePrincipalFromEmi rejects invalid inputs', () => {
    assert.throws(() => solvePrincipalFromEmi({ emi: -1, annualInterestRatePercent: 9, tenureMonths: 60 }), GuardrailValidationError);
    assert.throws(() => solvePrincipalFromEmi({ emi: 1000, annualInterestRatePercent: -1, tenureMonths: 60 }), GuardrailValidationError);
    assert.throws(() => solvePrincipalFromEmi({ emi: 1000, annualInterestRatePercent: 9, tenureMonths: 0 }), GuardrailValidationError);
  });
});

describe('guardrails: classifyRepaymentRisk', () => {
  test('a non-positive stressed surplus is always not_viable, regardless of ratio', () => {
    assert.equal(classifyRepaymentRisk({ recommendedSafeLoan: 0, maxEligibleLoan: 900000, stressedSurplus: 0 }), 'not_viable');
    assert.equal(classifyRepaymentRisk({ recommendedSafeLoan: 0, maxEligibleLoan: 900000, stressedSurplus: -1 }), 'not_viable');
  });
  test('ratio >= 0.75 is low_risk', () => {
    assert.equal(classifyRepaymentRisk({ recommendedSafeLoan: 750000, maxEligibleLoan: 1000000, stressedSurplus: 1 }), 'low_risk');
  });
  test('0.40 <= ratio < 0.75 is moderate_risk', () => {
    assert.equal(classifyRepaymentRisk({ recommendedSafeLoan: 400000, maxEligibleLoan: 1000000, stressedSurplus: 1 }), 'moderate_risk');
  });
  test('ratio < 0.40 is high_risk', () => {
    assert.equal(classifyRepaymentRisk({ recommendedSafeLoan: 100000, maxEligibleLoan: 1000000, stressedSurplus: 1 }), 'high_risk');
  });
});

describe('guardrails: adjustDemandForCompetition', () => {
  test('unavailable/missing market data leaves demand unadjusted', () => {
    assert.deepEqual(adjustDemandForCompetition({ baseUnitsPerDay: 20, marketData: null }), {
      adjustedUnitsPerDay: 20,
      applied: false,
      dilution: 0,
    });
    assert.equal(
      adjustDemandForCompetition({ baseUnitsPerDay: 20, marketData: { available: false } }).applied,
      false
    );
  });

  test('each competitor erodes demand by the configured per-competitor fraction', () => {
    const result = adjustDemandForCompetition({
      baseUnitsPerDay: 20,
      marketData: { available: true, competitorCount5km: 4 },
    });
    assert.equal(result.applied, true);
    assert.equal(result.dilution, 0.20); // 4 * 0.05
    assert.equal(result.adjustedUnitsPerDay, 16);
  });

  test('dilution is capped so competition can never wipe out more than the configured maximum', () => {
    const result = adjustDemandForCompetition({
      baseUnitsPerDay: 20,
      marketData: { available: true, competitorCount5km: 50 },
    });
    assert.equal(result.dilution, MAX_COMPETITOR_DEMAND_DILUTION);
    assert.equal(result.adjustedUnitsPerDay, round2(20 * (1 - MAX_COMPETITOR_DEMAND_DILUTION)));
  });
});

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

describe('guardrails: input validation', () => {
  test('maxEligibleLoan must be positive', () => {
    assert.throws(() => validateMaxEligibleLoan(0), GuardrailValidationError);
    assert.throws(() => validateMaxEligibleLoan(-1), GuardrailValidationError);
  });
  test('scheme requires a non-negative rate and a positive integer tenure', () => {
    assert.throws(() => validateScheme({ interestRatePercent: -1, tenureMonths: 60 }), GuardrailValidationError);
    assert.throws(() => validateScheme({ interestRatePercent: 9, tenureMonths: 0 }), GuardrailValidationError);
    assert.throws(() => validateScheme({ interestRatePercent: 9, tenureMonths: 12.5 }), GuardrailValidationError);
  });
  test('revenueAssumptions requires explicit sellingPrice, unitsPerDay, operatingDaysPerMonth', () => {
    assert.throws(() => validateRevenueAssumptions({}), GuardrailValidationError);
    assert.throws(() => validateRevenueAssumptions({ sellingPrice: 50, unitsPerDay: 20 }), GuardrailValidationError);
    assert.throws(
      () => validateRevenueAssumptions({ sellingPrice: 50, unitsPerDay: 20, operatingDaysPerMonth: 40 }),
      GuardrailValidationError
    );
  });
  test('costAssumptions requires explicit fixedCostsPerMonth and variableCostPerUnit', () => {
    assert.throws(() => validateCostAssumptions({}), GuardrailValidationError);
    assert.throws(() => validateCostAssumptions({ fixedCostsPerMonth: 5000 }), GuardrailValidationError);
  });
  test('applyGuardrails never silently defaults a missing assumption', () => {
    assert.throws(
      () => applyGuardrails({ maxEligibleLoan: 900000, scheme: SCHEME, revenueAssumptions: {}, costAssumptions: NORMAL_COSTS }),
      GuardrailValidationError
    );
  });
});

// ---------------------------------------------------------------------
// Full pipeline — the plan's required checkpoint scenarios
// ---------------------------------------------------------------------

describe('guardrails: applyGuardrails end-to-end scenarios', () => {
  test('normal market conditions produce a viable, capped safe loan', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: NORMAL_COSTS,
    });
    assert.equal(result.baseRevenue, 26000);
    assert.equal(result.operatingCosts, 10200);
    assert.equal(result.stressedRevenue, 20800);
    assert.equal(result.stressedCosts, 11730);
    assert.equal(result.stressedSurplus, 9070);
    assert.ok(result.recommendedSafeLoan > 0);
    assert.ok(result.recommendedSafeLoan <= result.maxEligibleLoan);
    assert.notEqual(result.repaymentRiskClassification, 'not_viable');
    assert.equal(result.isEstimate, false);
  });

  test('low-price conditions recommend a smaller safe loan than normal conditions', () => {
    const normal = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: NORMAL_COSTS,
    });
    const lowPrice = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: { ...NORMAL_REVENUE, sellingPrice: 40 },
      costAssumptions: NORMAL_COSTS,
    });
    assert.ok(lowPrice.recommendedSafeLoan < normal.recommendedSafeLoan);
    assert.ok(lowPrice.recommendedSafeLoan <= lowPrice.maxEligibleLoan);
  });

  test('high competitor density dilutes demand and recommends a smaller safe loan', () => {
    const noCompetition = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: NORMAL_COSTS,
    });
    const denseCompetition = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: NORMAL_COSTS,
      marketData: { available: true, competitorCount5km: 10 },
    });
    assert.ok(denseCompetition.recommendedSafeLoan < noCompetition.recommendedSafeLoan);
    assert.equal(denseCompetition.demandAdjustment.applied, true);
    assert.equal(denseCompetition.isEstimate, true); // demand dilution is a modeled estimate
    assert.ok(denseCompetition.recommendedSafeLoan <= denseCompetition.maxEligibleLoan);
  });

  test('high operating costs can push the business to not_viable even with positive base revenue', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: { fixedCostsPerMonth: 20000, variableCostPerUnit: 10 },
    });
    assert.ok(result.baseSurplus > 0); // still profitable unstressed
    assert.ok(result.stressedSurplus <= 0); // but not under stress
    assert.equal(result.repaymentRiskClassification, 'not_viable');
    assert.equal(result.recommendedSafeLoan, 0);
    assert.equal(result.monthlySafeEmi, 0);
    assert.equal(result.recommendedProjectCost, 0);
  });

  test('low revenue (low footfall) also yields not_viable rather than a fabricated small loan', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: { ...NORMAL_REVENUE, unitsPerDay: 2 },
      costAssumptions: NORMAL_COSTS,
    });
    assert.equal(result.repaymentRiskClassification, 'not_viable');
    assert.equal(result.recommendedSafeLoan, 0);
  });

  test('exactly zero stressed surplus is not_viable, never a positive/negative fabricated loan', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: { sellingPrice: 46, unitsPerDay: 10, operatingDaysPerMonth: 25 },
      costAssumptions: { fixedCostsPerMonth: 8000, variableCostPerUnit: 0 },
    });
    assert.equal(result.stressedSurplus, 0);
    assert.equal(result.repaymentRiskClassification, 'not_viable');
    assert.equal(result.recommendedSafeLoan, 0);
  });

  test('maximum eligible loan boundary: a very healthy business is still capped, never exceeds max eligible loan', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 100000,
      scheme: SCHEME,
      revenueAssumptions: { sellingPrice: 1000, unitsPerDay: 100, operatingDaysPerMonth: 30 },
      costAssumptions: { fixedCostsPerMonth: 1000, variableCostPerUnit: 10 },
    });
    assert.equal(result.recommendedSafeLoan, 100000);
    assert.equal(result.repaymentRiskClassification, 'low_risk');
  });

  test('the core invariant — recommended_safe_loan never exceeds max_eligible_loan — holds across a spread of scenarios', () => {
    const scenarios = [
      { maxEligibleLoan: 50000, revenueAssumptions: { sellingPrice: 5000, unitsPerDay: 200, operatingDaysPerMonth: 30 }, costAssumptions: { fixedCostsPerMonth: 100, variableCostPerUnit: 1 } },
      { maxEligibleLoan: 2500000, revenueAssumptions: NORMAL_REVENUE, costAssumptions: NORMAL_COSTS },
      { maxEligibleLoan: 1, revenueAssumptions: { sellingPrice: 100000, unitsPerDay: 500, operatingDaysPerMonth: 30 }, costAssumptions: { fixedCostsPerMonth: 1, variableCostPerUnit: 1 } },
    ];
    for (const scenario of scenarios) {
      const result = applyGuardrails({ scheme: SCHEME, ...scenario });
      assert.ok(
        result.recommendedSafeLoan <= result.maxEligibleLoan,
        `recommendedSafeLoan (${result.recommendedSafeLoan}) exceeded maxEligibleLoan (${result.maxEligibleLoan})`
      );
    }
  });

  test('recommendedProjectCost and workingCapitalReserve are derived deterministically from the final safe loan', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: NORMAL_COSTS,
    });
    assert.equal(result.recommendedProjectCost, round2(result.recommendedSafeLoan / 0.9));
    assert.equal(result.workingCapitalReserve, round2(result.stressedCosts)); // WORKING_CAPITAL_MONTHS = 1
  });

  test('the caller can flag assumptions as estimates, and the flag survives to the result with a warning', () => {
    const result = applyGuardrails({
      maxEligibleLoan: 900000,
      scheme: SCHEME,
      revenueAssumptions: NORMAL_REVENUE,
      costAssumptions: NORMAL_COSTS,
      isEstimate: true,
    });
    assert.equal(result.isEstimate, true);
    assert.ok(result.warnings.some((w) => /estimate/i.test(w)));
  });
});
