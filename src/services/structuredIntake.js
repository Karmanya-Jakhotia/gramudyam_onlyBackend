import fetch from 'node-fetch';
import { z } from 'zod';
import { redactAadhaar } from './intakeSchemas.js';
import { config, assertGeminiConfigured } from '../config.js';

const GEMINI_API_KEY = config.gemini.apiKey;
const GEMINI_TIMEOUT_MS = config.gemini.timeoutMs;
const BASE_URL = config.gemini.baseUrl;

const field = (value) => z.object({
  value: value.nullable(),
  confidence: z.number().min(0).max(1),
});

export const structuredIntakeSchema = z.object({
  page_1: z.object({
    village: field(z.string()),
    my_savings: field(z.number().nonnegative()),
    business: field(z.string()),
  }),
  page_2: z.object({
    monthly_income: field(z.number().nonnegative()),
    aadhar_number: field(z.string()),
    mobile_number: field(z.string()),
    debt: field(z.number().nonnegative()),
  }),
});

const responseSchema = {
  type: 'OBJECT',
  properties: {
    page_1: {
      type: 'OBJECT',
      properties: {
        village: { type: 'OBJECT', properties: { value: { type: 'STRING', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
        my_savings: { type: 'OBJECT', properties: { value: { type: 'NUMBER', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
        business: { type: 'OBJECT', properties: { value: { type: 'STRING', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
      },
      required: ['village', 'my_savings', 'business'],
    },
    page_2: {
      type: 'OBJECT',
      properties: {
        monthly_income: { type: 'OBJECT', properties: { value: { type: 'NUMBER', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
        aadhar_number: { type: 'OBJECT', properties: { value: { type: 'STRING', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
        mobile_number: { type: 'OBJECT', properties: { value: { type: 'STRING', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
        debt: { type: 'OBJECT', properties: { value: { type: 'NUMBER', nullable: true }, confidence: { type: 'NUMBER' } }, required: ['value', 'confidence'] },
      },
      required: ['monthly_income', 'aadhar_number', 'mobile_number', 'debt'],
    },
  },
  required: ['page_1', 'page_2'],
};

// System instruction: the rules the model should always follow, independent
// of any one transcript. Kept separate from the user message (Gemini's
// `systemInstruction` field) rather than folded into one long prompt, so the
// rules apply consistently and the transcript is clearly untrusted input.
export const structuredIntakeSystemInstruction = `You are a precise data extraction engine embedded in GramUdyam, a rural Indian business and micro-loan eligibility app. Your task is to process raw, spoken-word transcripts (already converted from audio to text) and map the entities directly into the provided JSON schema.

The seven fields you extract, split across two form pages:
PAGE 1: village (village/district name), my_savings (numeric INR), business (the business idea).
PAGE 2: monthly_income (numeric INR), aadhar_number (string), mobile_number (10-digit string), debt (numeric INR, existing loans).

Follow these strict extraction rules:
1. No Hallucinations: If a specific field is not explicitly stated or clearly implied in the transcript, set its value to null and confidence to 0. Never guess a village name, amount, or number. Never invent an eighth field.
2. Number Normalization: The transcript may mix Hindi, Marathi, Hinglish, and English. Convert spoken number expressions ("10 hazaar", "10k", "one lakh", "₹10,000") into plain numeric INR values. Never confuse savings, monthly income, and debt with each other — they are three different amounts and may all appear in the same sentence.
3. Identity Numbers: Preserve Aadhaar and mobile numbers as digit strings, never as numbers. Normalize mobile to exactly 10 digits with no +91 prefix, spaces, dashes, or leading trunk 0. The transcript has already been checked for Aadhaar-like numbers before it reaches you — any such number is replaced with the literal text [AADHAAR_REDACTED]. Never attempt to reconstruct, guess, or output a redacted Aadhaar value.
4. Data Standardization: Capitalize proper nouns (village/district names). Translate the business idea into a short, standard English description (e.g. "dairy", "grocery shop", "tailoring").
5. Ignore Spoken Filler: Discard verbal stumbles (um, ah, like), conversational pleasantries, and irrelevant tangents. Keep only the actionable value for each field.
6. Repeated Values: If a field's value is mentioned more than once in the transcript, use the clearest and most recent statement.
7. Confidence: 0 when the field is missing entirely, 0.5-0.7 when ambiguous or inferred indirectly, 0.7-0.9 when reasonably clear, 0.9-1 when explicitly and unambiguously stated.

Return ONLY valid JSON matching the response schema — no prose, no markdown, no explanation.

Example transcript: "Rampura mein rehta hoon, 50 hazaar savings hai, dairy karunga, mahine ka 15 hazaar kamata hoon, 20 hazaar loan hai, mobile 9876543210."
Example output: {"page_1":{"village":{"value":"Rampura","confidence":0.98},"my_savings":{"value":50000,"confidence":0.97},"business":{"value":"Dairy","confidence":0.96}},"page_2":{"monthly_income":{"value":15000,"confidence":0.97},"aadhar_number":{"value":null,"confidence":0},"mobile_number":{"value":"9876543210","confidence":1},"debt":{"value":20000,"confidence":0.96}}}`;

export function buildStructuredIntakePrompt(transcript) {
  const { redacted } = redactAadhaar(transcript);
  return `Extract the required fields from the following spoken transcript:
<transcript>
${redacted}
</transcript>`;
}

async function callGemini(prompt, { systemInstruction = structuredIntakeSystemInstruction } = {}) {
  assertGeminiConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`Gemini request failed (${res.status})`);
  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned no structured content');
  return JSON.parse(raw);
}

function normalize(data, transcript) {
  const output = structuredIntakeSchema.parse(data);
  const mobile = output.page_2.mobile_number.value?.replace(/\D/g, '') || null;
  const normalizedMobile = mobile?.startsWith('91') && mobile.length === 12 ? mobile.slice(2) : mobile?.startsWith('0') ? mobile.slice(1) : mobile;
  if (normalizedMobile && !/^[6-9]\d{9}$/.test(normalizedMobile)) {
    output.page_2.mobile_number = { value: null, confidence: 0 };
  } else {
    output.page_2.mobile_number = { ...output.page_2.mobile_number, value: normalizedMobile };
  }
  if (output.page_2.aadhar_number.value === '[AADHAAR_REDACTED]') {
    output.page_2.aadhar_number = { value: null, confidence: 0 };
  }
  return output;
}

export async function extractStructuredIntake(transcript) {
  const prompt = buildStructuredIntakePrompt(transcript);
  const { lastFour } = redactAadhaar(transcript);
  let raw = await callGemini(prompt);
  try {
    const result = normalize(raw, transcript);
    if (lastFour) {
      result.page_2.aadhar_number = { value: lastFour, confidence: 1 };
    }
    return result;
  } catch (error) {
    raw = await callGemini(`${prompt}\nThe previous response failed validation. Return the exact schema only. Validation error: ${error.message}`);
    const result = normalize(raw, transcript);
    if (lastFour) {
      result.page_2.aadhar_number = { value: lastFour, confidence: 1 };
    }
    return result;
  }
}
