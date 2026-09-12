import fetch from 'node-fetch';
import { config, assertMandiConfigured } from '../config.js';

/**
 * Real-world market data. This module must never invent numbers: a
 * successful call returns `available: true` with real data; any failure
 * (network, timeout, malformed upstream response, no matching records)
 * returns `available: false` with a `reason`, never a fabricated
 * competitor count or price. Bad *caller* input (invalid coordinates, a
 * missing commodity name) throws MarketDataError/ConfigError instead,
 * since that's a fixable request bug rather than an upstream outage.
 *
 * Data sources:
 *  - Competitors: OpenStreetMap via the Overpass API (no key required).
 *  - Mandi prices: data.gov.in's "Current Daily Price of Various
 *    Commodities from Various Markets (Mandi)" resource (keyed).
 */

export class MarketDataError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'MarketDataError';
    this.status = 422;
    this.field = field;
  }
}

// Maps GramUdyam's free-text business ideas (as produced by intake
// extraction, Phase 1) to OSM tags. Extend as new business types come up;
// an unmapped business still returns a result (all shops within radius),
// flagged with categoryMatched:false so callers know the count is broader
// than just direct competitors.
const CATEGORY_TAG_MAP = {
  dairy: 'shop=dairy',
  grocery: 'shop=grocery',
  'grocery shop': 'shop=grocery',
  'general store': 'shop=convenience',
  'kirana store': 'shop=convenience',
  tailoring: 'shop=tailor',
  tailor: 'shop=tailor',
  bakery: 'shop=bakery',
  salon: 'shop=hairdresser',
  'mobile repair': 'shop=mobile_phone',
  pharmacy: 'amenity=pharmacy',
  restaurant: 'amenity=restaurant',
  'tea stall': 'amenity=cafe',
  'vegetable vendor': 'shop=greengrocer',
};

function normalizeCategory(businessCategory) {
  return typeof businessCategory === 'string' ? businessCategory.trim().toLowerCase() : '';
}

function validateCoordinates(latitude, longitude) {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new MarketDataError('latitude must be a finite number between -90 and 90', 'latitude');
  }
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new MarketDataError('longitude must be a finite number between -180 and 180', 'longitude');
  }
}

function buildOverpassQuery({ tag, latitude, longitude, radiusMeters, timeoutSeconds }) {
  const filter = tag ? `["${tag.split('=')[0]}"="${tag.split('=')[1]}"]` : '["shop"]';
  return `[out:json][timeout:${timeoutSeconds}];
(
  node${filter}(around:${radiusMeters},${latitude},${longitude});
  way${filter}(around:${radiusMeters},${latitude},${longitude});
);
out center;`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function elementDistanceKm(element, latitude, longitude) {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return haversineKm(latitude, longitude, lat, lon);
}

function unavailable(source, reason, detail) {
  return { available: false, source, reason, detail: detail || null, fetchedAt: new Date().toISOString() };
}

/**
 * Nearby competitor count + distance to the nearest one, from OpenStreetMap.
 * `httpClient` is injectable (defaults to node-fetch) so tests never hit
 * the real network.
 */
export async function fetchCompetitorData(
  { latitude, longitude, businessCategory, radiusMeters = 5000 },
  { httpClient = fetch } = {}
) {
  validateCoordinates(latitude, longitude);
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new MarketDataError('radiusMeters must be a positive finite number', 'radiusMeters');
  }

  const tag = CATEGORY_TAG_MAP[normalizeCategory(businessCategory)] || null;
  const categoryMatched = Boolean(tag);
  const timeoutSeconds = Math.max(1, Math.ceil(config.market.overpassTimeoutMs / 1000));
  const query = buildOverpassQuery({ tag, latitude, longitude, radiusMeters, timeoutSeconds });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.market.overpassTimeoutMs);
  let res;
  try {
    res = await httpClient(config.market.overpassBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
      signal: controller.signal,
    });
  } catch (error) {
    return error.name === 'AbortError'
      ? unavailable('overpass', 'timeout', `No response after ${config.market.overpassTimeoutMs}ms`)
      : unavailable('overpass', 'network_error', error.message);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    return unavailable('overpass', 'http_error', `Overpass responded with status ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch (error) {
    return unavailable('overpass', 'invalid_response', 'Overpass returned non-JSON content');
  }
  if (!Array.isArray(body.elements)) {
    return unavailable('overpass', 'invalid_response', 'Overpass response missing "elements" array');
  }

  const distances = body.elements
    .map((el) => elementDistanceKm(el, latitude, longitude))
    .filter((d) => d !== null);

  return {
    available: true,
    source: 'overpass',
    competitorCount5km: body.elements.length,
    nearestCompetitorKm: distances.length ? round2(Math.min(...distances)) : null,
    categoryMatched,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Average/min/max mandi (wholesale market) price for a commodity, from
 * data.gov.in. Requires DATA_GOV_API_KEY (throws ConfigError if missing —
 * a fixable setup problem, distinct from an upstream outage).
 */
export async function fetchMandiPrice(
  { commodity, state, district },
  { httpClient = fetch } = {}
) {
  assertMandiConfigured();
  if (typeof commodity !== 'string' || !commodity.trim()) {
    throw new MarketDataError('commodity is required and must be a non-empty string', 'commodity');
  }

  const url = new URL(config.market.mandiBaseUrl);
  url.searchParams.set('api-key', config.market.mandiApiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '50');
  url.searchParams.set('filters[commodity]', commodity.trim());
  if (state) url.searchParams.set('filters[state]', state);
  if (district) url.searchParams.set('filters[district]', district);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.market.mandiTimeoutMs);
  let res;
  try {
    res = await httpClient(url.toString(), { signal: controller.signal });
  } catch (error) {
    return error.name === 'AbortError'
      ? unavailable('data.gov.in', 'timeout', `No response after ${config.market.mandiTimeoutMs}ms`)
      : unavailable('data.gov.in', 'network_error', error.message);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    return unavailable('data.gov.in', 'http_error', `data.gov.in responded with status ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch (error) {
    return unavailable('data.gov.in', 'invalid_response', 'data.gov.in returned non-JSON content');
  }
  if (!Array.isArray(body.records)) {
    return unavailable('data.gov.in', 'invalid_response', 'data.gov.in response missing "records" array');
  }
  if (body.records.length === 0) {
    return unavailable('data.gov.in', 'no_records_found', `No mandi price records for "${commodity}"${state ? ` in ${state}` : ''}`);
  }

  const modalPrices = body.records.map((r) => Number(r.modal_price)).filter(Number.isFinite);
  if (modalPrices.length === 0) {
    return unavailable('data.gov.in', 'no_usable_records', 'Records were returned but none had a numeric modal_price');
  }

  return {
    available: true,
    source: 'data.gov.in',
    mandiPriceAvg: round2(modalPrices.reduce((a, b) => a + b, 0) / modalPrices.length),
    mandiPriceMin: Math.min(...modalPrices),
    mandiPriceMax: Math.max(...modalPrices),
    recordCount: modalPrices.length,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Combined snapshot for the orchestrator (Phase 3). Each sub-fetch fails
 * independently — a mandi-price outage doesn't block competitor data, and
 * vice versa — since these come from unrelated upstreams.
 */
export async function getMarketSnapshot(
  { latitude, longitude, businessCategory, commodity, state, district } = {},
  deps = {}
) {
  const [competitors, mandi] = await Promise.all([
    latitude !== undefined && longitude !== undefined
      ? fetchCompetitorData({ latitude, longitude, businessCategory }, deps).catch((error) =>
          unavailable('overpass', 'request_error', error.message)
        )
      : Promise.resolve(unavailable('overpass', 'not_requested', 'latitude/longitude not provided')),
    commodity
      ? fetchMandiPrice({ commodity, state, district }, deps).catch((error) =>
          unavailable('data.gov.in', 'request_error', error.message)
        )
      : Promise.resolve(unavailable('data.gov.in', 'not_requested', 'commodity not provided')),
  ]);

  return { competitors, mandi, generatedAt: new Date().toISOString() };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
