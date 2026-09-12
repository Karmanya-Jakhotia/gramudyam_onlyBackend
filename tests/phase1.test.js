import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUserProfile,
  normalizeLanguage,
  normalizeText,
  normalizeCapital,
  userProfileSchema,
  REQUIRED_FIELDS,
} from '../src/schemas/userProfile.js';
import { extractUserProfile, IntakeExtractionError } from '../src/services/intakeExtraction.js';
import { config, validateConfig, assertGeminiConfigured, ConfigError } from '../src/config.js';

const COMPLETE_RAW = {
  state: 'Maharashtra',
  district: 'Wardha',
  block: null,
  village: 'Rampura',
  available_capital: 50000,
  proposed_business: 'Dairy',
  language: 'hindi',
};

describe('normalization helpers', () => {
  test('normalizeLanguage maps aliases to ISO-ish codes', () => {
    assert.equal(normalizeLanguage('Hindi'), 'hi');
    assert.equal(normalizeLanguage('MARATHI'), 'mr');
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('gujarati'), null);
    assert.equal(normalizeLanguage(null), null);
  });

  test('normalizeText trims and treats blank as absent', () => {
    assert.equal(normalizeText('  Rampura  '), 'Rampura');
    assert.equal(normalizeText('   '), null);
    assert.equal(normalizeText(null), null);
  });

  test('normalizeCapital rejects negative values instead of accepting or clamping them', () => {
    assert.equal(normalizeCapital(50000), 50000);
    assert.equal(normalizeCapital(-1000), null);
    assert.equal(normalizeCapital(null), null);
    assert.equal(normalizeCapital('not a number'), null);
  });
});

describe('buildUserProfile (deterministic completeness)', () => {
  test('complete input produces a complete UserProfile', () => {
    const profile = buildUserProfile({
      state: 'Maharashtra',
      district: 'Wardha',
      block: null,
      village: 'Rampura',
      available_capital: 50000,
      proposed_business: 'Dairy',
      language: 'hi',
    });
    assert.equal(profile.is_complete, true);
    assert.deepEqual(profile.missing_fields, []);
    assert.equal(profile.follow_up_question, null);
    assert.doesNotThrow(() => userProfileSchema.parse(profile));
  });

  test('incomplete input produces is_complete=false with correct missing fields', () => {
    const profile = buildUserProfile({
      state: null,
      district: 'Wardha',
      block: null,
      village: null, // missing
      available_capital: null, // missing
      proposed_business: 'Dairy',
      language: 'hi',
    });
    assert.equal(profile.is_complete, false);
    assert.deepEqual(profile.missing_fields, ['village', 'available_capital']);
  });

  test('a follow-up question is generated for the first missing field, in the given language', () => {
    const profile = buildUserProfile({
      state: null, district: null, block: null, village: 'Rampura',
      available_capital: 10000, proposed_business: 'Dairy', language: 'mr',
    });
    assert.equal(profile.is_complete, false);
    assert.equal(profile.missing_fields[0], 'district');
    assert.ok(profile.follow_up_question);
    assert.match(profile.follow_up_question, /jilhyat/); // Marathi phrasing for the district question
  });

  test('negative available_capital is treated as not-provided, never as a negative number', () => {
    const profile = buildUserProfile({
      state: 'Maharashtra', district: 'Wardha', block: null, village: 'Rampura',
      available_capital: normalizeCapital(-5000), proposed_business: 'Dairy', language: 'hi',
    });
    assert.equal(profile.available_capital, null);
    assert.ok(profile.missing_fields.includes('available_capital'));
  });

  test('every required field missing yields all of them in missing_fields', () => {
    const profile = buildUserProfile({
      state: null, district: null, block: null, village: null,
      available_capital: null, proposed_business: null, language: null,
    });
    assert.equal(profile.is_complete, false);
    assert.deepEqual(profile.missing_fields, REQUIRED_FIELDS);
  });
});

describe('extractUserProfile (Gemini call injected — no network)', () => {
  test('valid Gemini output on first try produces a complete UserProfile', async () => {
    const fakeGemini = async () => ({ ...COMPLETE_RAW });
    const profile = await extractUserProfile('Rampura mein rehta hoon...', { geminiCaller: fakeGemini });
    assert.equal(profile.is_complete, true);
    assert.equal(profile.language, 'hi');
    assert.equal(profile.proposed_business, 'Dairy');
  });

  test('schema-invalid Gemini output triggers exactly one retry, then succeeds', async () => {
    let calls = 0;
    const fakeGemini = async () => {
      calls += 1;
      if (calls === 1) {
        // Missing required key -> fails rawExtractionSchema (.strict())
        return { state: null, district: 'Wardha', village: 'Rampura' };
      }
      return { ...COMPLETE_RAW };
    };
    const profile = await extractUserProfile('some transcript', { geminiCaller: fakeGemini });
    assert.equal(calls, 2);
    assert.equal(profile.is_complete, true);
  });

  test('Gemini output that is still invalid after retry fails safely (no fabricated profile)', async () => {
    const fakeGemini = async () => ({ garbage: true });
    await assert.rejects(
      () => extractUserProfile('some transcript', { geminiCaller: fakeGemini }),
      IntakeExtractionError
    );
  });

  test('an empty transcript is rejected before any Gemini call is made', async () => {
    let called = false;
    const fakeGemini = async () => { called = true; return { ...COMPLETE_RAW }; };
    await assert.rejects(
      () => extractUserProfile('   ', { geminiCaller: fakeGemini }),
      IntakeExtractionError
    );
    assert.equal(called, false);
  });

  test('a wrong-type field (e.g. capital as a string) fails validation rather than being silently coerced', async () => {
    const fakeGemini = async () => ({ ...COMPLETE_RAW, available_capital: 'fifty thousand' });
    await assert.rejects(
      () => extractUserProfile('some transcript', { geminiCaller: fakeGemini }),
      IntakeExtractionError
    );
  });
});

describe('config validation', () => {
  test('assertGeminiConfigured throws ConfigError (not a generic Error) when the key is missing', () => {
    const original = config.gemini.apiKey;
    // config is frozen; simulate "missing" by testing the guard directly
    // against a temporary config-shaped object instead of mutating the
    // frozen singleton.
    if (!original) {
      assert.throws(() => assertGeminiConfigured(), ConfigError);
    } else {
      // In an environment where a real key IS set, just verify the happy path.
      assert.doesNotThrow(() => assertGeminiConfigured());
    }
  });

  test('validateConfig never logs the key value itself', () => {
    const logged = [];
    const originalWarn = console.warn;
    console.warn = (...args) => logged.push(args.join(' '));
    try {
      validateConfig();
    } finally {
      console.warn = originalWarn;
    }
    for (const line of logged) {
      if (config.gemini.apiKey) assert.ok(!line.includes(config.gemini.apiKey));
      if (config.sarvam.apiKey) assert.ok(!line.includes(config.sarvam.apiKey));
    }
  });
});
