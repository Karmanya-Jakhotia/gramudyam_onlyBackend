import fetch from 'node-fetch';
import { intakePageOneSchema, intakePageTwoSchema, pageOneResponseSchema, pageTwoResponseSchema } from './intakeSchemas.js';
import { config, assertGeminiConfigured } from '../config.js';

const GEMINI_API_KEY = config.gemini.apiKey;
const BASE_URL = config.gemini.baseUrl;
const records = new Map();

const pageOneExample = '{"villageOrDistrict":"Wardha","savings":50000,"business":"vegetable vendor","missingFields":[],"extractionConfidence":0.96,"rawTranscript":"Mere gaon Wardha mein sabzi ka kaam..."}';
const pageTwoExample = '{"monthlyIncome":15000,"aadharLastFour":"9012","phoneNumber":"9876543210","existingDebt":0,"missingFields":[],"extractionConfidence":0.95,"rawTranscript":"Income pandrah hazar, aadhaar ... 9012, phone 09876543210, koi karz nahi"}';

export function buildPageOnePrompt(transcript) {
  return `You extract page one of a rural Indian business-loan form. Input may mix Hindi, Marathi, and English. Translate text values to standard English and normalize amounts to numeric INR values. Never guess: use null and list the field in missingFields. existing missing fields must be explicit. Return only JSON matching the schema. Example: ${pageOneExample}\nTranscript: """${transcript}"""`;
}

export function buildPageTwoPrompt(redactedTranscript) {
  return `You extract page two of a rural Indian business-loan form. Input may mix Hindi, Marathi, and English. It has already had any full Aadhaar number removed. Never reconstruct or guess Aadhaar. If [AADHAAR_REDACTED] is present, aadharLastFour may be supplied only from trusted metadata, otherwise use null. Normalize all amounts to numeric INR values, normalize phone to exactly 10 digits starting 6-9, distinguish omitted debt (null) from explicitly no debt (0), and return missingFields. Translate text to standard English. Return only JSON matching the schema. Example: ${pageTwoExample}\nTranscript: """${redactedTranscript}"""`;
}

async function callGemini(prompt, responseSchema) {
  assertGeminiConfigured();
  const res = await fetch(`${BASE_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Gemini request failed (${res.status}): ${JSON.stringify(body)}`);
  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned no structured content');
  return JSON.parse(raw);
}

async function extractValidated({ prompt, schema, responseSchema, retryPrompt }) {
  let candidate = await callGemini(prompt, responseSchema);
  let parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    candidate = await callGemini(`${retryPrompt}\nValidation errors: ${JSON.stringify(parsed.error.issues)}`, responseSchema);
    parsed = schema.safeParse(candidate);
  }
  if (!parsed.success) {
    const error = new Error('Gemini response failed intake validation');
    error.status = 502;
    throw error;
  }
  return parsed.data;
}

export async function extractPageOne({ applicationId, transcript }) {
  const data = await extractValidated({
    prompt: buildPageOnePrompt(transcript), schema: intakePageOneSchema, responseSchema: pageOneResponseSchema,
    retryPrompt: buildPageOnePrompt(transcript),
  });
  const record = records.get(applicationId) || {};
  records.set(applicationId, { ...record, pageOne: data });
  return data;
}

export async function extractPageTwo({ applicationId, redactedTranscript, lastFour }) {
  const data = await extractValidated({
    prompt: buildPageTwoPrompt(redactedTranscript), schema: intakePageTwoSchema, responseSchema: pageTwoResponseSchema,
    retryPrompt: buildPageTwoPrompt(redactedTranscript),
  });
    const result = { ...data, aadharLastFour: lastFour || data.aadharLastFour, rawTranscript: redactedTranscript };
  const record = records.get(applicationId) || {};
  records.set(applicationId, { ...record, pageTwo: result });
  return result;
}
