import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateMarginCapital,
  validateBusinessCategory,
  calculateProjectCost,
  calculateLoanBounds,
  selectScheme,
  calculateEmi,
  returnFinancialSummary,
  FinanceValidationError,
} from '../src/tools/finance.js';

import {
  fetchCompetitorData,
  fetchMandiPrice,
  getMarketSnapshot,
  MarketDataError,
} from '../src/tools/market.js';
import { ConfigError } from '../src/config.js';

// ---------------------------------------------------------------------
// Finance tool — fully deterministic, no network involved anywhere below.
// ---------------------------------------------------------------------

describe('finance: validateMarginCapital', () => {
  test('accepts a positive finite number', () => {
    assert.equal(validateMarginCapital(100000), 100000);
  });
  test('rejects zero', () => {
    assert.throws(() => validateMarginCapital(0), FinanceValidationError);
  });
  test('rejects negative values', () => {
    assert.throws(() => validateMarginCapital(-500), FinanceValidationError);
  });
  test('rejects non-numeric input', () => {
    assert.throws(() => validateMarginCapital('100000'), FinanceValidationError);
    assert.throws(() => validateMarginCapital(NaN), FinanceValidationError);
    assert.throws(() => validateMarginCapital(undefined), FinanceValidationError);
  });
});

describe('finance: validateBusinessCategory', () => {
  test('null/undefined are allowed (category is optional)', () => {
    assert.equal(validateBusinessCategory(null), null);
    assert.equal(validateBusinessCategory(undefined), null);
  });
  test('a known category passes through', () => {
    assert.equal(validateBusinessCategory('women'), 'women');
  });
  test('an unrecognized category is rejected', () => {
    assert.throws(() => validateBusinessCategory('made_up_category'), FinanceValidationError);
  });
});

describe('finance: the plan\'s required checkpoint', () => {
  test('₹1,00,000 margin -> ₹10,00,000 max project cost -> ₹9,00,000 max loan', () => {
    const projectCost = calculateProjectCost(100000);
    assert.equal(projectCost, 1000000);
    const { maxProjectCost, maxLoan, marginRequired } = calculateLoanBounds(100000);
    assert.equal(maxProjectCost, 1000000);
    assert.equal(maxLoan, 900000);
    assert.equal(marginRequired, 100000);
  });
});

describe('finance: boundary values and scheme transitions', () => {
  test('project cost exactly at a tier boundary falls in the lower tier', () => {
    assert.equal(selectScheme(100000).schemeName, 'PMEGP (Micro)');
    assert.equal(selectScheme(1000000).schemeName, 'PMEGP (Small)');
    assert.equal(selectScheme(2500000).schemeName, 'PMEGP (Standard)');
  });
  test('one rupee over a boundary moves to the next tier', () => {
    assert.equal(selectScheme(100000.01).schemeName, 'PMEGP (Small)');
    assert.equal(selectScheme(1000000.01).schemeName, 'PMEGP (Standard)');
    assert.equal(selectScheme(2500000.01).schemeName, 'Stand-Up India');
  });
  test('a very large project cost still resolves to the top tier, never throws', () => {
    assert.equal(selectScheme(50000000).schemeName, 'Stand-Up India');
  });
  test('a non-positive project cost is rejected', () => {
    assert.throws(() => selectScheme(0), FinanceValidationError);
    assert.throws(() => selectScheme(-100), FinanceValidationError);
  });
});

describe('finance: calculateEmi', () => {
  test('matches the standard reducing-balance formula for a known case', () => {
    // P=900000, annual rate=9%, n=60 months -> monthly rate 0.0075
    // EMI = P*r*(1+r)^n / ((1+r)^n - 1)
    const r = 0.09 / 12;
    const n = 60;
    const factor = Math.pow(1 + r, n);
    const expected = Math.round(((900000 * r * factor) / (factor - 1)) * 100) / 100;
    const { monthlyEmi } = calculateEmi({ loanAmount: 900000, annualInterestRatePercent: 9, tenureMonths: 60 });
    assert.equal(monthlyEmi, expected);
  });

  test('zero interest falls back to a straight-line P/n', () => {
    const { monthlyEmi, totalInterest } = calculateEmi({ loanAmount: 120000, annualInterestRatePercent: 0, tenureMonths: 12 });
    assert.equal(monthlyEmi, 10000);
    assert.equal(totalInterest, 0);
  });

  test('totalRepayment and totalInterest are internally consistent', () => {
    const { monthlyEmi, totalRepayment, totalInterest } = calculateEmi({ loanAmount: 500000, annualInterestRatePercent: 10, tenureMonths: 84 });
    assert.equal(Math.round(monthlyEmi * 84 * 100) / 100, totalRepayment);
    assert.equal(Math.round((totalRepayment - 500000) * 100) / 100, totalInterest);
  });

  test('invalid inputs are rejected', () => {
    assert.throws(() => calculateEmi({ loanAmount: -1, annualInterestRatePercent: 9, tenureMonths: 60 }), FinanceValidationError);
    assert.throws(() => calculateEmi({ loanAmount: 1000, annualInterestRatePercent: -1, tenureMonths: 60 }), FinanceValidationError);
    assert.throws(() => calculateEmi({ loanAmount: 1000, annualInterestRatePercent: 9, tenureMonths: 0 }), FinanceValidationError);
    assert.throws(() => calculateEmi({ loanAmount: 1000, annualInterestRatePercent: 9, tenureMonths: 12.5 }), FinanceValidationError);
  });
});

describe('finance: returnFinancialSummary end-to-end', () => {
  test('produces a coherent summary for ₹1,00,000 margin', () => {
    const summary = returnFinancialSummary({ marginCapital: 100000 });
    assert.equal(summary.maxProjectCost, 1000000);
    assert.equal(summary.maxLoan, 900000);
    assert.equal(summary.scheme.schemeName, 'PMEGP (Small)');
    assert.ok(summary.monthlyEmi > 0);
    assert.ok(summary.totalRepayment > summary.maxLoan); // interest was charged
  });

  test('rejects zero/negative capital before touching scheme or EMI logic', () => {
    assert.throws(() => returnFinancialSummary({ marginCapital: 0 }), FinanceValidationError);
    assert.throws(() => returnFinancialSummary({ marginCapital: -1000 }), FinanceValidationError);
  });

  test('rejects an invalid business category', () => {
    assert.throws(
      () => returnFinancialSummary({ marginCapital: 100000, businessCategory: 'not_a_real_category' }),
      FinanceValidationError
    );
  });
});

// ---------------------------------------------------------------------
// Market tool — httpClient is injected, so none of this touches the
// real network (Overpass / data.gov.in are not reachable from CI/sandboxes
// that restrict egress, and tests shouldn't depend on live third-party
// data anyway).
// ---------------------------------------------------------------------

function fakeJsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('market: fetchCompetitorData', () => {
  test('valid coordinates + Overpass response -> normalized competitor data', async () => {
    const httpClient = async () =>
      fakeJsonResponse(200, {
        elements: [
          { type: 'node', lat: 20.75, lon: 78.60 },
          { type: 'way', center: { lat: 20.76, lon: 78.61 } },
        ],
      });
    const result = await fetchCompetitorData(
      { latitude: 20.75, longitude: 78.60, businessCategory: 'dairy' },
      { httpClient }
    );
    assert.equal(result.available, true);
    assert.equal(result.competitorCount5km, 2);
    assert.equal(result.nearestCompetitorKm, 0); // the first element is exactly at the query point
    assert.equal(result.categoryMatched, true);
    assert.equal(result.source, 'overpass');
  });

  test('an unmapped business category still returns results, flagged as unmatched', async () => {
    const httpClient = async () => fakeJsonResponse(200, { elements: [] });
    const result = await fetchCompetitorData(
      { latitude: 20.75, longitude: 78.60, businessCategory: 'underwater basket weaving' },
      { httpClient }
    );
    assert.equal(result.available, true);
    assert.equal(result.competitorCount5km, 0);
    assert.equal(result.nearestCompetitorKm, null);
    assert.equal(result.categoryMatched, false);
  });

  test('invalid coordinates are rejected rather than sent upstream', async () => {
    let called = false;
    const httpClient = async () => { called = true; return fakeJsonResponse(200, { elements: [] }); };
    await assert.rejects(
      () => fetchCompetitorData({ latitude: 999, longitude: 78.6 }, { httpClient }),
      MarketDataError
    );
    assert.equal(called, false);
  });

  test('a non-2xx upstream response is reported as unavailable, not thrown, not fabricated', async () => {
    const httpClient = async () => fakeJsonResponse(503, {});
    const result = await fetchCompetitorData({ latitude: 20.75, longitude: 78.6 }, { httpClient });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'http_error');
    assert.equal(result.competitorCount5km, undefined);
  });

  test('a network error is reported as unavailable, not thrown', async () => {
    const httpClient = async () => { throw new Error('ECONNRESET'); };
    const result = await fetchCompetitorData({ latitude: 20.75, longitude: 78.6 }, { httpClient });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'network_error');
  });

  test('malformed JSON body is reported as unavailable', async () => {
    const httpClient = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    const result = await fetchCompetitorData({ latitude: 20.75, longitude: 78.6 }, { httpClient });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'invalid_response');
  });

  test('a response missing "elements" is reported as unavailable, not treated as zero competitors', async () => {
    const httpClient = async () => fakeJsonResponse(200, { unexpected: 'shape' });
    const result = await fetchCompetitorData({ latitude: 20.75, longitude: 78.6 }, { httpClient });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'invalid_response');
  });
});

describe('market: fetchMandiPrice', () => {
  test('valid records -> averaged, normalized price data', async () => {
    const httpClient = async () =>
      fakeJsonResponse(200, {
        records: [
          { modal_price: '2000', min_price: '1800', max_price: '2200' },
          { modal_price: '2200', min_price: '2000', max_price: '2400' },
        ],
      });
    const result = await fetchMandiPrice({ commodity: 'Onion', state: 'Maharashtra' }, { httpClient });
    assert.equal(result.available, true);
    assert.equal(result.mandiPriceAvg, 2100);
    assert.equal(result.mandiPriceMin, 2000);
    assert.equal(result.mandiPriceMax, 2200);
    assert.equal(result.recordCount, 2);
  });

  test('zero matching records is a valid "no data" result, not a fabricated price', async () => {
    const httpClient = async () => fakeJsonResponse(200, { records: [] });
    const result = await fetchMandiPrice({ commodity: 'Saffron' }, { httpClient });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'no_records_found');
  });

  test('missing commodity is rejected before any request is made', async () => {
    let called = false;
    const httpClient = async () => { called = true; return fakeJsonResponse(200, { records: [] }); };
    await assert.rejects(() => fetchMandiPrice({ commodity: '' }, { httpClient }), MarketDataError);
    assert.equal(called, false);
  });

  test('upstream HTTP failure is reported as unavailable', async () => {
    const httpClient = async () => fakeJsonResponse(500, {});
    const result = await fetchMandiPrice({ commodity: 'Onion' }, { httpClient });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'http_error');
  });
});

describe('market: getMarketSnapshot', () => {
  test('a mandi failure does not prevent competitor data from coming through, and vice versa', async () => {
    const httpClient = async (url) => {
      const asString = String(url);
      if (asString.includes('data.gov.in') || asString.includes('resource')) {
        throw new Error('mandi upstream down');
      }
      return fakeJsonResponse(200, { elements: [{ lat: 20.75, lon: 78.6 }] });
    };
    const snapshot = await getMarketSnapshot(
      { latitude: 20.75, longitude: 78.6, businessCategory: 'dairy', commodity: 'Milk' },
      { httpClient }
    );
    assert.equal(snapshot.competitors.available, true);
    assert.equal(snapshot.mandi.available, false);
  });

  test('omitted location/commodity are reported as not_requested, not errors', async () => {
    const snapshot = await getMarketSnapshot({});
    assert.equal(snapshot.competitors.available, false);
    assert.equal(snapshot.competitors.reason, 'not_requested');
    assert.equal(snapshot.mandi.available, false);
    assert.equal(snapshot.mandi.reason, 'not_requested');
  });
});
