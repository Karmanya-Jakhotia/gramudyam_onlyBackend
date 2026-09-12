import { Router } from 'express';
import { assembleFeasibilityReport, ReportAssemblyError } from '../services/reportAssembly.js';
import { GuardrailValidationError } from '../engine/guardrails.js';
import { ReportNarrativeError } from '../services/reportNarrative.js';
import { ConfigError } from '../config.js';
import { userProfileSchema } from '../schemas/userProfile.js';

const router = Router();

/**
 * POST /api/v1/analyze
 * Body: {
 *   userProfile: UserProfile (must be is_complete: true, see Phase 1),
 *   marketContext?: { latitude, longitude, commodity, state, district },
 *   revenueAssumptions: { sellingPrice, unitsPerDay, operatingDaysPerMonth, seasonalityFactor? },
 *   costAssumptions: { fixedCostsPerMonth, variableCostPerUnit },
 *   isEstimate?: boolean
 * }
 *
 * Flow: UserProfile -> Gemini Orchestrator -> Market Tools -> Finance Tools
 * -> Guardrails -> FeasibilityReport. See services/reportAssembly.js.
 */
router.post('/', async (req, res) => {
  const { userProfile, marketContext, revenueAssumptions, costAssumptions, isEstimate } = req.body || {};

  const profileCheck = userProfileSchema.safeParse(userProfile);
  if (!profileCheck.success) {
    return res.status(422).json({
      error: 'invalid_request',
      message: 'userProfile is missing or does not match the UserProfile schema',
      details: profileCheck.error.issues,
    });
  }
  if (!revenueAssumptions || typeof revenueAssumptions !== 'object') {
    return res.status(422).json({ error: 'invalid_request', message: 'revenueAssumptions is required' });
  }
  if (!costAssumptions || typeof costAssumptions !== 'object') {
    return res.status(422).json({ error: 'invalid_request', message: 'costAssumptions is required' });
  }

  try {
    const report = await assembleFeasibilityReport({
      userProfile: profileCheck.data,
      marketContext: marketContext || {},
      revenueAssumptions,
      costAssumptions,
      isEstimate: Boolean(isEstimate),
    });
    return res.json({ report });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[analyze] service not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Analysis is temporarily unavailable' });
    }
    if (error instanceof GuardrailValidationError) {
      return res.status(422).json({ error: 'invalid_request', message: error.message, field: error.field });
    }
    if (error instanceof ReportNarrativeError) {
      console.error('[analyze] narrative generation failed', error.message);
      return res.status(502).json({ error: 'analysis_failed', message: 'Could not generate the feasibility report. Please try again.' });
    }
    if (error instanceof ReportAssemblyError) {
      console.error('[analyze]', error.message);
      return res.status(error.status || 502).json({ error: 'analysis_failed', message: error.message });
    }
    console.error('[analyze] unexpected error', error);
    return res.status(500).json({ error: 'internal_error', message: 'Unexpected server error' });
  }
});

export default router;
