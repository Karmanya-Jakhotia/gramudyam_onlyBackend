import fetch from 'node-fetch';
import { config, assertGeminiConfigured } from '../config.js';
import { narrativeSchema, narrativeResponseSchema } from '../schemas/report.js';

/**
 * Phase 5 — narrative content generation.
 *
 * This is the ONLY place in Phase 5 that calls Gemini, and it is scoped
 * narrowly: it asks for SWOT analysis, alternative business ideas, and a
 * plain-language explanation — never a number. Every monetary value and
 * the business_readiness_score are computed before this is called and are
 * only ever *handed to* the prompt as already-final context, explicitly
 * labeled as such, so Gemini has no opening to "helpfully" restate a
 * different figure.
 */

export class ReportNarrativeError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ReportNarrativeError';
    this.status = 502;
    if (cause) this.cause = cause;
  }
}

/**
 * @param {object} context
 * @param {object} context.userProfile - Phase 1 UserProfile
 * @param {object} context.guardrailResult - Phase 4 applyGuardrails() output
 * @param {object} context.marketSnapshot - Phase 2 getMarketSnapshot() output
 * @param {string} context.schemeName - the selected scheme's display name
 */
export function buildNarrativePrompt({ userProfile, guardrailResult, marketSnapshot, schemeName }) {
  const location = [userProfile.village, userProfile.block, userProfile.district, userProfile.state]
    .filter(Boolean)
    .join(', ');

  const competitorLine = marketSnapshot?.competitors?.available
    ? `${marketSnapshot.competitors.competitorCount5km} similar shop(s) within 5km, nearest at ${marketSnapshot.competitors.nearestCompetitorKm ?? 'unknown'} km`
    : 'not available';
  const mandiLine = marketSnapshot?.mandi?.available
    ? `average mandi price ~INR ${marketSnapshot.mandi.mandiPriceAvg}`
    : 'not available';

  return `You are a business feasibility advisor for GramUdyam, an app that helps rural Indian entrepreneurs understand whether a small business idea is viable and how to fund it.

These facts are FINAL and already deterministically calculated — do not restate them differently, recompute them, or contradict them anywhere in your answer:
- Location: ${location || 'unknown'}
- Proposed business: ${userProfile.proposed_business ?? 'unknown'}
- Maximum eligible loan: INR ${guardrailResult.maxEligibleLoan}
- Recommended safe loan: INR ${guardrailResult.recommendedSafeLoan}
- Recommended project cost: INR ${guardrailResult.recommendedProjectCost}
- Monthly safe EMI: INR ${guardrailResult.monthlySafeEmi}
- Working capital reserve: INR ${guardrailResult.workingCapitalReserve}
- Repayment risk classification: ${guardrailResult.repaymentRiskClassification}
- Applicable scheme: ${schemeName}
- Nearby competition: ${competitorLine}
- Local commodity pricing: ${mandiLine}

Using the facts above (never inventing different numbers), write:
- swot_analysis: strengths, weaknesses, opportunities, threats — 2-3 short bullet points each, specific to this business and location, consistent with the repayment risk classification given.
- alternative_recommendations: 1-3 alternative small business ideas that would suit this same location and this same margin capital, each with a one-sentence rationale. If the given business is already a strong fit, you may still suggest complementary or lower-risk alternatives.
- plain_language_explanation: 3-5 short sentences, for a low-literacy reader, explaining in plain words why this loan amount (and no more) is being recommended, referencing the risk classification and the working capital reserve. No financial jargon without explanation, no acronyms.

Output nothing except the JSON object matching the schema.`;
}

async function callGemini(prompt) {
  assertGeminiConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.gemini.timeoutMs);
  let res;
  try {
    res = await fetch(`${config.gemini.baseUrl}?key=${config.gemini.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: 'application/json',
          responseSchema: narrativeResponseSchema,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ReportNarrativeError(`Gemini request timed out after ${config.gemini.timeoutMs}ms`, { cause: error });
    }
    throw new ReportNarrativeError('Gemini request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  const body = await res.json();
  if (!res.ok) {
    throw new ReportNarrativeError(`Gemini request failed (${res.status})`, { cause: body });
  }
  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new ReportNarrativeError('Gemini returned no structured content');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReportNarrativeError('Gemini returned invalid JSON', { cause: error });
  }
}

/**
 * `geminiCaller` is injectable so tests never touch the network.
 * Retries once (mirroring intakeExtraction.js / reportService.js) with
 * the validation error appended, then fails safely rather than
 * fabricating narrative content.
 */
export async function generateReportNarrative(context, { geminiCaller = callGemini } = {}) {
  const prompt = buildNarrativePrompt(context);
  let candidate = await geminiCaller(prompt);
  let parsed = narrativeSchema.safeParse(candidate);

  if (!parsed.success) {
    candidate = await geminiCaller(
      `${prompt}\n\nYour previous answer failed validation with these errors, fix them: ${JSON.stringify(parsed.error.issues)}`
    );
    parsed = narrativeSchema.safeParse(candidate);
  }

  if (!parsed.success) {
    throw new ReportNarrativeError('Gemini narrative response failed validation after retry', { cause: parsed.error });
  }

  return parsed.data;
}
