import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculateBusinessReadinessScore, countAvailableMarketSources, ScoringValidationError } from '../src/engine/scoring.js';
import { feasibilityReportSchema } from '../src/schemas/report.js';
import { generateDprPdf, formatInr, PdfGenerationError } from '../src/services/pdfGenerator.js';
import { assembleFeasibilityReport, ReportAssemblyError } from '../src/services/reportAssembly.js';
import { GuardrailValidationError } from '../src/engine/guardrails.js';

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const COMPLETE_PROFILE = {
  state: 'Maharashtra',
  district: 'Wardha',
  block: null,
  village: 'Rampura',
  available_capital: 100000,
  proposed_business: 'dairy',
  language: 'hi',
  is_complete: true,
  missing_fields: [],
  follow_up_question: null,
};

const VALID_REPORT = {
  business_readiness_score: 80,
  selected_business: 'dairy',
  location: { state: 'Maharashtra', district: 'Wardha', block: null, village: 'Rampura' },
  max_eligible_loan: 900000,
  recommended_safe_loan: 500000,
  recommended_project_cost: 555556,
  working_capital_reserve: 11730,
  monthly_emi: 10000,
  swot_analysis: {
    strengths: ['Low competition nearby'],
    weaknesses: ['Seasonal demand'],
    opportunities: ['Growing local market'],
    threats: ['Price volatility'],
  },
  alternative_recommendations: [{ business: 'Poultry', rationale: 'Lower upfront cost' }],
  plain_language_explanation: 'This loan amount is safe because it leaves a buffer even if sales drop.',
  repayment_risk_classification: 'moderate_risk',
  recommended_scheme_name: 'PMEGP (Small)',
  is_estimate: false,
  warnings: [],
  generated_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------
// Business readiness score (deterministic, never Gemini-authored)
// ---------------------------------------------------------------------

describe('scoring: calculateBusinessReadinessScore', () => {
  test('rejects an unknown risk classification rather than guessing a score', () => {
    assert.throws(
      () => calculateBusinessReadinessScore({ repaymentRiskClassification: 'bogus', isEstimate: false }),
      ScoringValidationError
    );
  });

  test('not_viable always yields a low base score regardless of market data', () => {
    const score = calculateBusinessReadinessScore(
      { repaymentRiskClassification: 'not_viable', isEstimate: false },
      { competitors: { available: true, competitorCount5km: 1 }, mandi: { available: true } }
    );
    assert.ok(score <= 20);
  });

  test('low_risk with both market sources available scores higher than low_risk with none', () => {
    const withMarketData = calculateBusinessReadinessScore(
      { repaymentRiskClassification: 'low_risk', isEstimate: false },
      { competitors: { available: true }, mandi: { available: true } }
    );
    const withoutMarketData = calculateBusinessReadinessScore(
      { repaymentRiskClassification: 'low_risk', isEstimate: false },
      null
    );
    assert.ok(withMarketData > withoutMarketData);
  });

  test('isEstimate applies a penalty', () => {
    const estimate = calculateBusinessReadinessScore({ repaymentRiskClassification: 'low_risk', isEstimate: true }, null);
    const verified = calculateBusinessReadinessScore({ repaymentRiskClassification: 'low_risk', isEstimate: false }, null);
    assert.ok(estimate < verified);
  });

  test('score is always clamped to [0, 100]', () => {
    const score = calculateBusinessReadinessScore(
      { repaymentRiskClassification: 'low_risk', isEstimate: false },
      { competitors: { available: true }, mandi: { available: true } }
    );
    assert.ok(score >= 0 && score <= 100);
  });

  test('countAvailableMarketSources handles missing/partial snapshots without throwing', () => {
    assert.equal(countAvailableMarketSources(null), 0);
    assert.equal(countAvailableMarketSources({}), 0);
    assert.equal(countAvailableMarketSources({ competitors: { available: true } }), 1);
    assert.equal(countAvailableMarketSources({ competitors: { available: true }, mandi: { available: true } }), 2);
  });
});

// ---------------------------------------------------------------------
// Report schema validation
// ---------------------------------------------------------------------

describe('schemas/report: feasibilityReportSchema', () => {
  test('accepts a well-formed report', () => {
    const result = feasibilityReportSchema.safeParse(VALID_REPORT);
    assert.equal(result.success, true);
  });

  test('rejects recommended_safe_loan exceeding max_eligible_loan', () => {
    const bad = { ...VALID_REPORT, recommended_safe_loan: VALID_REPORT.max_eligible_loan + 1 };
    const result = feasibilityReportSchema.safeParse(bad);
    assert.equal(result.success, false);
  });

  test('rejects a negative monetary value', () => {
    const bad = { ...VALID_REPORT, working_capital_reserve: -1 };
    assert.equal(feasibilityReportSchema.safeParse(bad).success, false);
  });

  test('rejects a business_readiness_score outside [0, 100]', () => {
    assert.equal(feasibilityReportSchema.safeParse({ ...VALID_REPORT, business_readiness_score: 101 }).success, false);
    assert.equal(feasibilityReportSchema.safeParse({ ...VALID_REPORT, business_readiness_score: -1 }).success, false);
  });

  test('rejects a missing required field', () => {
    const { plain_language_explanation, ...withoutExplanation } = VALID_REPORT;
    void plain_language_explanation;
    assert.equal(feasibilityReportSchema.safeParse(withoutExplanation).success, false);
  });

  test('rejects a swot_analysis missing a required bucket', () => {
    const bad = { ...VALID_REPORT, swot_analysis: { ...VALID_REPORT.swot_analysis, threats: undefined } };
    assert.equal(feasibilityReportSchema.safeParse(bad).success, false);
  });

  test('accepts an empty alternative_recommendations list', () => {
    const result = feasibilityReportSchema.safeParse({ ...VALID_REPORT, alternative_recommendations: [] });
    assert.equal(result.success, true);
  });
});

// ---------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------

describe('services/pdfGenerator', () => {
  test('formatInr applies Indian digit grouping', () => {
    assert.equal(formatInr(100000), 'Rs. 1,00,000');
    assert.equal(formatInr(1000000), 'Rs. 10,00,000');
    assert.equal(formatInr(500), 'Rs. 500');
    assert.equal(formatInr(0), 'Rs. 0');
  });

  test('generateDprPdf produces a well-formed, non-empty PDF buffer for a valid report', () => {
    const pdf = generateDprPdf(VALID_REPORT);
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 200);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(pdf.toString('latin1'), /%%EOF\s*$/);
    assert.match(pdf.toString('latin1'), /\/Type \/Catalog/);
  });

  test('generateDprPdf rejects an invalid report rather than emitting a corrupt/partial PDF', () => {
    assert.throws(() => generateDprPdf({ ...VALID_REPORT, recommended_safe_loan: -5 }), PdfGenerationError);
  });

  test('generateDprPdf handles a report with many SWOT/alternative items across a page break', () => {
    const longReport = {
      ...VALID_REPORT,
      swot_analysis: {
        strengths: Array.from({ length: 15 }, (_, i) => `Strength number ${i} with some extra descriptive text to force wrapping`),
        weaknesses: Array.from({ length: 15 }, (_, i) => `Weakness number ${i} with some extra descriptive text to force wrapping`),
        opportunities: Array.from({ length: 15 }, (_, i) => `Opportunity number ${i} with some extra descriptive text to force wrapping`),
        threats: Array.from({ length: 15 }, (_, i) => `Threat number ${i} with some extra descriptive text to force wrapping`),
      },
    };
    const pdf = generateDprPdf(longReport);
    assert.ok(Buffer.isBuffer(pdf));
    // A document this long must have spilled onto more than one page.
    const pageCount = (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;
    assert.ok(pageCount > 1);
  });
});

// ---------------------------------------------------------------------
// Full pipeline assembly (Phase 1 profile -> ... -> FeasibilityReport)
// ---------------------------------------------------------------------

function functionCallTurn(calls) {
  return { role: 'model', parts: calls.map((c) => ({ functionCall: c })) };
}
function textTurn(text) {
  return { role: 'model', parts: [{ text }] };
}

/** A geminiCaller fake that calls the given tool once, then finishes with a text turn. */
function singleToolThenDone(call, finalText = 'Feasibility assessed using the gathered figures.') {
  let step = 0;
  return async () => {
    step += 1;
    return step === 1 ? functionCallTurn([call]) : textTurn(finalText);
  };
}

const NORMAL_REVENUE = { sellingPrice: 50, unitsPerDay: 20, operatingDaysPerMonth: 26 };
const NORMAL_COSTS = { fixedCostsPerMonth: 5000, variableCostPerUnit: 10 };

const NARRATIVE_FIXTURE = {
  swot_analysis: {
    strengths: ['Steady local demand'],
    weaknesses: ['Limited storage'],
    opportunities: ['Nearby market growth'],
    threats: ['Seasonal price swings'],
  },
  alternative_recommendations: [{ business: 'Poultry', rationale: 'Lower capital needed' }],
  plain_language_explanation: 'This amount keeps a safety buffer even if sales fall.',
};

describe('services/reportAssembly: assembleFeasibilityReport', () => {
  test('assembles a valid FeasibilityReport end to end with fully injected dependencies', async () => {
    let call = 0;
    const geminiCaller = async () => {
      call += 1;
      if (call === 1) {
        return functionCallTurn([
          { name: 'calculate_loan_bounds', args: { marginCapital: 100000 } },
        ]);
      }
      return textTurn('Feasibility looks reasonable given the numbers gathered.');
    };
    const narrativeGeminiCaller = async () => NARRATIVE_FIXTURE;

    const report = await assembleFeasibilityReport(
      {
        userProfile: COMPLETE_PROFILE,
        revenueAssumptions: NORMAL_REVENUE,
        costAssumptions: NORMAL_COSTS,
      },
      { geminiCaller, narrativeGeminiCaller }
    );

    const parsed = feasibilityReportSchema.safeParse(report);
    assert.equal(parsed.success, true);
    assert.equal(report.selected_business, 'dairy');
    assert.equal(report.location.village, 'Rampura');
    assert.ok(report.recommended_safe_loan <= report.max_eligible_loan);
    assert.equal(report.max_eligible_loan, 900000); // margin 100000 / 0.10 * 0.90
  });

  test('rejects an incomplete UserProfile before ever calling Gemini or a tool', async () => {
    const incomplete = { ...COMPLETE_PROFILE, is_complete: false, missing_fields: ['available_capital'] };
    await assert.rejects(
      () =>
        assembleFeasibilityReport(
          { userProfile: incomplete, revenueAssumptions: NORMAL_REVENUE, costAssumptions: NORMAL_COSTS },
          { geminiCaller: async () => textTurn('should never be called') }
        ),
      ReportAssemblyError
    );
  });

  test('fails safely (no fabricated report) when the orchestrator never calls calculate_loan_bounds', async () => {
    const geminiCaller = async () => textTurn('I could not determine anything useful.');
    await assert.rejects(
      () =>
        assembleFeasibilityReport(
          { userProfile: COMPLETE_PROFILE, revenueAssumptions: NORMAL_REVENUE, costAssumptions: NORMAL_COSTS },
          { geminiCaller, narrativeGeminiCaller: async () => NARRATIVE_FIXTURE }
        ),
      ReportAssemblyError
    );
  });

  test('propagates a GuardrailValidationError as a controlled 422 error when assumptions are missing', async () => {
    const geminiCaller = singleToolThenDone({ name: 'calculate_loan_bounds', args: { marginCapital: 100000 } });
    await assert.rejects(
      () =>
        assembleFeasibilityReport(
          { userProfile: COMPLETE_PROFILE, revenueAssumptions: {}, costAssumptions: NORMAL_COSTS },
          { geminiCaller, narrativeGeminiCaller: async () => NARRATIVE_FIXTURE }
        ),
      (error) => {
        // reportAssembly.js deliberately wraps the underlying
        // GuardrailValidationError in a ReportAssemblyError so callers get
        // one consistent error type from the pipeline — but the original
        // validation failure (message + a 422, not a 502/500) must survive
        // the wrap intact.
        assert.ok(error instanceof ReportAssemblyError);
        assert.equal(error.status, 422);
        assert.match(error.message, /sellingPrice/);
        assert.ok(error.cause instanceof GuardrailValidationError);
        return true;
      }
    );
  });

  test('uninhabitable stress conditions still produce a valid (not_viable) report, never a fabricated positive loan', async () => {
    const geminiCaller = singleToolThenDone({ name: 'calculate_loan_bounds', args: { marginCapital: 100000 } });
    const report = await assembleFeasibilityReport(
      {
        userProfile: COMPLETE_PROFILE,
        revenueAssumptions: { ...NORMAL_REVENUE, unitsPerDay: 1 },
        costAssumptions: NORMAL_COSTS,
      },
      { geminiCaller, narrativeGeminiCaller: async () => NARRATIVE_FIXTURE }
    );
    assert.equal(report.repayment_risk_classification, 'not_viable');
    assert.equal(report.recommended_safe_loan, 0);
    assert.ok(feasibilityReportSchema.safeParse(report).success);
  });

  test('the assembled report can be turned directly into a PDF', async () => {
    const geminiCaller = singleToolThenDone({ name: 'calculate_loan_bounds', args: { marginCapital: 100000 } });
    const report = await assembleFeasibilityReport(
      { userProfile: COMPLETE_PROFILE, revenueAssumptions: NORMAL_REVENUE, costAssumptions: NORMAL_COSTS },
      { geminiCaller, narrativeGeminiCaller: async () => NARRATIVE_FIXTURE }
    );
    const pdf = generateDprPdf(report);
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 200);
  });
});
