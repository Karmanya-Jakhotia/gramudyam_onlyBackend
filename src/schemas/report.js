import { z } from 'zod';

/**
 * Phase 5.1 — Final Report Schema.
 *
 * This is the ONLY shape returned by /api/v1/analyze and the ONLY shape
 * accepted by /api/v1/download-dpr. Per the plan's field list:
 *
 *   business_readiness_score, selected_business, location,
 *   max_eligible_loan, recommended_safe_loan, recommended_project_cost,
 *   working_capital_reserve, monthly_emi, swot_analysis,
 *   alternative_recommendations, plain_language_explanation
 *
 * Production validation enforced here:
 *  - Monetary values are non-negative.
 *  - recommended_safe_loan never exceeds max_eligible_loan (the same
 *    invariant Phase 4 already enforces internally — re-checked here as a
 *    defensive, independent boundary check at the API-contract layer).
 *  - Required fields are present.
 *  - Lists/dicts (swot_analysis, alternative_recommendations) follow the
 *    expected structure.
 *  - business_readiness_score stays within its defined [0, 100] range.
 *
 * Not `.strict()`: a few extra, informative fields (repayment risk
 * classification, warnings, generatedAt, source metadata) are attached
 * alongside the plan's required fields rather than discarded, since they
 * are genuinely useful to the caller/UI and to the PDF generator. The
 * plan's named fields are always present and always validated; nothing
 * about them is optional or renamed.
 */

const locationSchema = z.object({
  state: z.string().min(1).nullable(),
  district: z.string().min(1).nullable(),
  block: z.string().min(1).nullable(),
  village: z.string().min(1).nullable(),
});

const swotAnalysisSchema = z.object({
  strengths: z.array(z.string().min(1)).min(1),
  weaknesses: z.array(z.string().min(1)).min(1),
  opportunities: z.array(z.string().min(1)).min(1),
  threats: z.array(z.string().min(1)).min(1),
});

const alternativeRecommendationSchema = z.object({
  business: z.string().min(1),
  rationale: z.string().min(1),
});

export const REPAYMENT_RISK_CLASSIFICATIONS = ['low_risk', 'moderate_risk', 'high_risk', 'not_viable'];

export const feasibilityReportSchema = z
  .object({
    business_readiness_score: z.number().int().min(0).max(100),
    selected_business: z.string().min(1),
    location: locationSchema,

    max_eligible_loan: z.number().nonnegative(),
    recommended_safe_loan: z.number().nonnegative(),
    recommended_project_cost: z.number().nonnegative(),
    working_capital_reserve: z.number().nonnegative(),
    monthly_emi: z.number().nonnegative(),

    swot_analysis: swotAnalysisSchema,
    alternative_recommendations: z.array(alternativeRecommendationSchema),
    plain_language_explanation: z.string().min(1),

    // Informative extras — always deterministic, never Gemini-authored.
    repayment_risk_classification: z.enum(REPAYMENT_RISK_CLASSIFICATIONS),
    recommended_scheme_name: z.string().min(1),
    is_estimate: z.boolean(),
    warnings: z.array(z.string()),
    generated_at: z.string().min(1),
  })
  .refine((report) => report.recommended_safe_loan <= report.max_eligible_loan, {
    message: 'recommended_safe_loan must never exceed max_eligible_loan',
    path: ['recommended_safe_loan'],
  });

/**
 * Gemini's responseSchema dialect (uppercase types), for the *qualitative*
 * fields only — swot_analysis, alternative_recommendations,
 * plain_language_explanation. Gemini is never asked to produce, and this
 * schema never accepts, any of the monetary or score fields above; those
 * come exclusively from Phase 2/3/4 deterministic tools.
 */
export const narrativeResponseSchema = {
  type: 'OBJECT',
  properties: {
    swot_analysis: {
      type: 'OBJECT',
      properties: {
        strengths: { type: 'ARRAY', items: { type: 'STRING' } },
        weaknesses: { type: 'ARRAY', items: { type: 'STRING' } },
        opportunities: { type: 'ARRAY', items: { type: 'STRING' } },
        threats: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['strengths', 'weaknesses', 'opportunities', 'threats'],
    },
    alternative_recommendations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          business: { type: 'STRING' },
          rationale: { type: 'STRING' },
        },
        required: ['business', 'rationale'],
      },
    },
    plain_language_explanation: { type: 'STRING' },
  },
  required: ['swot_analysis', 'alternative_recommendations', 'plain_language_explanation'],
};

export const narrativeSchema = z.object({
  swot_analysis: swotAnalysisSchema,
  alternative_recommendations: z.array(alternativeRecommendationSchema),
  plain_language_explanation: z.string().min(1),
});
