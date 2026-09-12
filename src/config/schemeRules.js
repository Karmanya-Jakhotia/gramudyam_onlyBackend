/**
 * Loan scheme tiers, keyed by maximum project cost (INR) each tier applies
 * up to. Centralized here — NOT duplicated in prompts, routes, or the
 * Flutter app — per the production rule "financial rules should be
 * centralized rather than duplicated across Gemini prompts, API routes and
 * UI code."
 *
 * IMPORTANT: these interest rates, tenures, and moratoriums are
 * ILLUSTRATIVE placeholders modeled loosely on PMEGP / Mudra / Stand-Up
 * India tiering, not a verified current scheme circular. Before relying on
 * this in production, replace the numbers below with figures confirmed
 * against the current official scheme documentation (rates and tenures
 * change over time and vary by bank/lender).
 *
 * Tiers are evaluated in order; the first tier whose `maxProjectCost` is
 * >= the computed project cost applies. The last tier's `maxProjectCost`
 * is Infinity, so every project cost matches something.
 */
export const SCHEME_TIERS = [
  {
    maxProjectCost: 100000,
    schemeName: 'PMEGP (Micro)',
    interestRatePercent: 8,
    tenureMonths: 36,
    moratoriumMonths: 6,
  },
  {
    maxProjectCost: 1000000,
    schemeName: 'PMEGP (Small)',
    interestRatePercent: 9,
    tenureMonths: 60,
    moratoriumMonths: 6,
  },
  {
    maxProjectCost: 2500000,
    schemeName: 'PMEGP (Standard)',
    interestRatePercent: 10,
    tenureMonths: 84,
    moratoriumMonths: 12,
  },
  {
    maxProjectCost: Infinity,
    schemeName: 'Stand-Up India',
    interestRatePercent: 11,
    tenureMonths: 84,
    moratoriumMonths: 12,
  },
];

/** Margin capital as a fraction of project cost (10%), per the scheme's core rule. */
export const MARGIN_RATIO = 0.10;

/** Optional, informational only — the current schema doesn't collect a business category. */
export const KNOWN_BUSINESS_CATEGORIES = ['general', 'women', 'sc_st', 'obc', 'minority'];
