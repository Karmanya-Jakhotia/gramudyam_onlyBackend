import { z } from 'zod';

// What we require back from Gemini, and what we validate the parsed JSON
// against before trusting it enough to show a rural entrepreneur.
export const feasibilityReportSchema = z.object({
  demandLevel: z.enum(['High', 'Moderate', 'Low']),
  demandSummary: z.string().min(1),
  competitionLevel: z.enum(['High', 'Moderate', 'Low']),
  competitionSummary: z.string().min(1),
  profitPotentialStars: z.number().int().min(1).max(5),
  pricingStrategy: z.string().min(1),
  recommendedLoanScheme: z.string().min(1),
  nextStepRecommendation: z.string().min(1),
  riskMitigation: z.string().min(1),
  swotStrengths: z.array(z.string()).min(1),
  swotRisks: z.array(z.string()).min(1),
});

// Gemini's responseSchema uses its own (uppercase-type) JSON-schema dialect,
// same convention already used in intakeSchemas.js.
export const feasibilityReportResponseSchema = {
  type: 'OBJECT',
  properties: {
    demandLevel: { type: 'STRING', enum: ['High', 'Moderate', 'Low'] },
    demandSummary: { type: 'STRING' },
    competitionLevel: { type: 'STRING', enum: ['High', 'Moderate', 'Low'] },
    competitionSummary: { type: 'STRING' },
    profitPotentialStars: { type: 'INTEGER' },
    pricingStrategy: { type: 'STRING' },
    recommendedLoanScheme: { type: 'STRING' },
    nextStepRecommendation: { type: 'STRING' },
    riskMitigation: { type: 'STRING' },
    swotStrengths: { type: 'ARRAY', items: { type: 'STRING' } },
    swotRisks: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'demandLevel',
    'demandSummary',
    'competitionLevel',
    'competitionSummary',
    'profitPotentialStars',
    'pricingStrategy',
    'recommendedLoanScheme',
    'nextStepRecommendation',
    'riskMitigation',
    'swotStrengths',
    'swotRisks',
  ],
};
