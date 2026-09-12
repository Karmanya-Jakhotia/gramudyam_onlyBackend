import { z } from 'zod';

const numericOrNull = z.number().nonnegative().nullable();

export const intakePageOneSchema = z.object({
  villageOrDistrict: z.string().nullable(),
  savings: numericOrNull,
  business: z.string().nullable(),
  missingFields: z.array(z.string()),
  extractionConfidence: z.number().min(0).max(1),
  rawTranscript: z.string(),
});

export const intakePageTwoSchema = z.object({
  monthlyIncome: numericOrNull,
  aadharLastFour: z.string().regex(/^\d{4}$/).nullable(),
  phoneNumber: z.string().regex(/^[6-9]\d{9}$/).nullable(),
  existingDebt: numericOrNull,
  missingFields: z.array(z.string()),
  extractionConfidence: z.number().min(0).max(1),
  rawTranscript: z.string(),
});

export function redactAadhaar(transcript) {
  const patterns = [
    /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/g,
    /\b\d{12}\b/g,
  ];
  let redacted = transcript;
  let lastFour = null;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length !== 12) return match;
      lastFour = digits.slice(-4);
      console.warn('[intake] Aadhaar-like number redacted before Gemini call');
      return '[AADHAAR_REDACTED]';
    });
  }
  return { redacted, lastFour };
}

export const pageOneResponseSchema = {
  type: 'OBJECT',
  properties: {
    villageOrDistrict: { type: 'STRING', nullable: true },
    savings: { type: 'NUMBER', nullable: true },
    business: { type: 'STRING', nullable: true },
    missingFields: { type: 'ARRAY', items: { type: 'STRING' } },
    extractionConfidence: { type: 'NUMBER' },
    rawTranscript: { type: 'STRING' },
  },
  required: ['villageOrDistrict', 'savings', 'business', 'missingFields', 'extractionConfidence', 'rawTranscript'],
};

export const pageTwoResponseSchema = {
  type: 'OBJECT',
  properties: {
    monthlyIncome: { type: 'NUMBER', nullable: true },
    aadharLastFour: { type: 'STRING', nullable: true },
    phoneNumber: { type: 'STRING', nullable: true },
    existingDebt: { type: 'NUMBER', nullable: true },
    missingFields: { type: 'ARRAY', items: { type: 'STRING' } },
    extractionConfidence: { type: 'NUMBER' },
    rawTranscript: { type: 'STRING' },
  },
  required: ['monthlyIncome', 'aadharLastFour', 'phoneNumber', 'existingDebt', 'missingFields', 'extractionConfidence', 'rawTranscript'],
};
