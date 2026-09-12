import fetch from 'node-fetch';
import { feasibilityReportSchema, feasibilityReportResponseSchema } from './reportSchemas.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Builds the prompt that turns the entrepreneur's own form inputs (village,
 * business idea, savings, monthly income, existing debt) into the actual
 * feasibility report content — this is what the app used to fake with
 * hardcoded strings like "Demand: High" / "2 similar shops nearby".
 */
export function buildReportPrompt(input) {
  const { village, business, savings, monthlyIncome, existingDebt } = input;

  return `You are a business feasibility advisor for GramUdyam, an app that helps rural Indian entrepreneurs understand whether a small business idea is viable and how to fund it.

A user has entered the following details about their planned business:
- Village/area: ${village}
- Business idea: ${business}
- Savings available to invest: INR ${savings}
- Expected/current monthly income: INR ${monthlyIncome || 'not provided'}
- Existing debt: INR ${existingDebt || '0'}

Using general knowledge of small-town/rural Indian markets for this kind of business, write a short, honest, encouraging-but-realistic feasibility assessment. Be specific to the business type and village context where possible, not generic boilerplate.

Include:
- demandLevel: overall local demand (High/Moderate/Low)
- demandSummary: 1-2 plain-language sentences on why, specific to this business and area
- competitionLevel: expected local competition (High/Moderate/Low)
- competitionSummary: 1-2 sentences on the competitive landscape for this kind of business in a village/small-town setting
- profitPotentialStars: integer 1-5 rating of profit potential given the savings and income provided
- pricingStrategy: concrete, actionable pricing advice for this specific business
- recommendedLoanScheme: name a real, appropriate Indian government micro-finance/loan scheme (e.g. PM Mudra Yojana - Shishu/Kishor/Tarun, PMEGP, Stand-Up India) that best fits this savings/loan-size range, briefly say why
- nextStepRecommendation: one concrete next action the entrepreneur should take, considering their savings and income
- riskMitigation: one concrete risk-mitigation tip, considering their existing debt
- swotStrengths: 2-3 short strength/opportunity bullet points specific to this business and village
- swotRisks: 2-3 short risk/weakness bullet points specific to this business and village

Write for a low-literacy reader: short sentences, no jargon, no financial acronyms without explanation. Output nothing except the JSON object matching the schema.`;
}

async function callGemini(prompt) {
  const res = await fetch(`${BASE_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: feasibilityReportResponseSchema,
      },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    const error = new Error(`Gemini request failed (${res.status}): ${JSON.stringify(body)}`);
    error.status = 502;
    throw error;
  }

  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    const error = new Error('Gemini returned no structured content');
    error.status = 502;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    const error = new Error('Gemini returned invalid JSON');
    error.status = 502;
    throw error;
  }
}

/**
 * input: { village, business, savings, monthlyIncome, existingDebt }
 * (all strings/numbers as they come from the app's form fields)
 */
export async function generateFeasibilityReport(input) {
  if (!GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY is not configured on the server');
    error.status = 500;
    throw error;
  }

  const prompt = buildReportPrompt(input);
  let candidate = await callGemini(prompt);
  let parsed = feasibilityReportSchema.safeParse(candidate);

  if (!parsed.success) {
    // One retry, telling Gemini exactly what was wrong with its first answer.
    candidate = await callGemini(`${prompt}\n\nYour previous answer failed validation with these errors, fix them: ${JSON.stringify(parsed.error.issues)}`);
    parsed = feasibilityReportSchema.safeParse(candidate);
  }

  if (!parsed.success) {
    const error = new Error('Gemini response failed feasibility-report validation');
    error.status = 502;
    throw error;
  }

  return parsed.data;
}
