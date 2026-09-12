import { runOrchestrator } from '../engine/orchestrator.js';
import { applyGuardrails, GuardrailValidationError } from '../engine/guardrails.js';
import { calculateBusinessReadinessScore } from '../engine/scoring.js';
import { generateReportNarrative } from './reportNarrative.js';
import { feasibilityReportSchema } from '../schemas/report.js';
import { userProfileSchema } from '../schemas/userProfile.js';

/**
 * Phase 5 — combines Phases 1-4 into the complete production pipeline:
 *
 *   UserProfile -> Gemini Orchestrator (Phase 3)
 *               -> Market Tools + Finance Tools (Phase 2, via the orchestrator)
 *               -> Guardrails (Phase 4)
 *               -> business_readiness_score (deterministic)
 *               -> Narrative (Gemini, qualitative-only)
 *               -> FeasibilityReport (validated)
 *
 * This module never computes a financial number itself and never lets the
 * narrative step influence one — every INR figure and the risk
 * classification arrive here already final, from applyGuardrails().
 */

export class ReportAssemblyError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message);
    this.name = 'ReportAssemblyError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/**
 * Pulls the structured result of a specific tool call out of the
 * orchestrator's toolTrace. Returns null if the tool was never called or
 * never succeeded — callers decide whether that's fatal.
 */
function findToolResult(toolTrace, toolName) {
  const entry = [...toolTrace].reverse().find((t) => t.tool === toolName && t.success);
  return entry ? entry.outcome.result : null;
}

/**
 * Runs the complete Phase 1(input)->5 pipeline for an already-validated,
 * complete UserProfile.
 *
 * @param {object} params
 * @param {object} params.userProfile - a complete (is_complete: true) UserProfile
 * @param {object} [params.marketContext] - { latitude, longitude, commodity, state, district } for the market tool
 * @param {object} params.revenueAssumptions - { sellingPrice, unitsPerDay, operatingDaysPerMonth, seasonalityFactor? }
 * @param {object} params.costAssumptions - { fixedCostsPerMonth, variableCostPerUnit }
 * @param {boolean} [params.isEstimate=false] - caller declares revenue/cost assumptions are not verified local data
 * @param {object} [deps] - test seams: { geminiCaller, toolDeps, narrativeGeminiCaller }
 * @returns {Promise<object>} a validated FeasibilityReport
 */
export async function assembleFeasibilityReport(
  { userProfile, marketContext = {}, revenueAssumptions, costAssumptions, isEstimate = false },
  { geminiCaller, toolDeps, narrativeGeminiCaller } = {}
) {
  const profile = userProfileSchema.parse(userProfile);
  if (!profile.is_complete) {
    throw new ReportAssemblyError('userProfile must be complete (is_complete: true) to run analysis', { status: 422 });
  }

  // Phase 3: orchestration (which itself only ever calls Phase 2's tools).
  const orchestration = await runOrchestrator(
    profile,
    marketContext,
    { geminiCaller, toolDeps }
  );

  if (orchestration.status !== 'complete') {
    throw new ReportAssemblyError(
      `Orchestration did not complete: ${orchestration.reason || 'unknown'} - ${orchestration.message || ''}`.trim(),
      { status: 502 }
    );
  }

  const financeSummary = findToolResult(orchestration.toolTrace, 'calculate_loan_bounds');
  if (!financeSummary) {
    // Financial numbers are non-negotiable — if the orchestrator never
    // actually called (or never succeeded at calling) calculate_loan_bounds,
    // we do not have a maxEligibleLoan/scheme to hand to the guardrail, and
    // we must not proceed with a fabricated one.
    throw new ReportAssemblyError(
      'Orchestration completed without a successful calculate_loan_bounds result; cannot determine loan eligibility',
      { status: 502 }
    );
  }

  const marketSnapshotResult = findToolResult(orchestration.toolTrace, 'fetch_geospatial_market_data');

  // Phase 4: the deterministic guardrail — the sole authority over the
  // final safe loan figure. marketData shape matches getMarketSnapshot()'s
  // `.competitors` sub-object (available flag + competitorCount5km).
  let guardrailResult;
  try {
    guardrailResult = applyGuardrails({
      maxEligibleLoan: financeSummary.maxLoan,
      scheme: financeSummary.scheme,
      revenueAssumptions,
      costAssumptions,
      marketData: marketSnapshotResult?.competitors ?? null,
      isEstimate,
    });
  } catch (error) {
    if (error instanceof GuardrailValidationError) {
      throw new ReportAssemblyError(error.message, { status: 422, cause: error });
    }
    throw error;
  }

  // Deterministic score — never Gemini-authored (see engine/scoring.js).
  const businessReadinessScore = calculateBusinessReadinessScore(guardrailResult, marketSnapshotResult);

  // Phase 5 narrative — qualitative content only, fed the already-final
  // numbers purely as read-only context (see reportNarrative.js).
  const narrative = await generateReportNarrative(
    {
      userProfile: profile,
      guardrailResult,
      marketSnapshot: marketSnapshotResult,
      schemeName: financeSummary.scheme.schemeName,
    },
    narrativeGeminiCaller ? { geminiCaller: narrativeGeminiCaller } : {}
  );

  const report = {
    business_readiness_score: businessReadinessScore,
    selected_business: profile.proposed_business,
    location: {
      state: profile.state,
      district: profile.district,
      block: profile.block,
      village: profile.village,
    },

    max_eligible_loan: guardrailResult.maxEligibleLoan,
    recommended_safe_loan: guardrailResult.recommendedSafeLoan,
    recommended_project_cost: guardrailResult.recommendedProjectCost,
    working_capital_reserve: guardrailResult.workingCapitalReserve,
    monthly_emi: guardrailResult.monthlySafeEmi,

    swot_analysis: narrative.swot_analysis,
    alternative_recommendations: narrative.alternative_recommendations,
    plain_language_explanation: narrative.plain_language_explanation,

    repayment_risk_classification: guardrailResult.repaymentRiskClassification,
    recommended_scheme_name: financeSummary.scheme.schemeName,
    is_estimate: guardrailResult.isEstimate,
    warnings: guardrailResult.warnings,
    generated_at: new Date().toISOString(),
  };

  const parsed = feasibilityReportSchema.safeParse(report);
  if (!parsed.success) {
    // Should be unreachable if every step above did its job, but the plan
    // requires the final contract to be validated, not merely assembled —
    // fail loudly rather than return a report that violates its own schema.
    throw new ReportAssemblyError('Assembled report failed schema validation', {
      status: 500,
      cause: parsed.error,
    });
  }
  return parsed.data;
}
