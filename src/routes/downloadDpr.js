import { Router } from 'express';
import { generateDprPdf, PdfGenerationError } from '../services/pdfGenerator.js';

const router = Router();

/**
 * POST /api/v1/download-dpr
 * Body: { report: FeasibilityReport }  (the exact object returned by /api/v1/analyze)
 *
 * Purpose: FeasibilityReport -> PDF. PDF generation failures are always
 * turned into a controlled JSON error (never corrupt/partial PDF bytes,
 * never a raw stack trace) per the plan's production requirement.
 */
router.post('/', (req, res) => {
  const { report } = req.body || {};
  if (!report || typeof report !== 'object') {
    return res.status(422).json({ error: 'invalid_request', message: 'report is required' });
  }

  try {
    const pdfBuffer = generateDprPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="gramudyam-dpr.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    if (error instanceof PdfGenerationError) {
      console.error('[download-dpr]', error.message);
      return res.status(422).json({ error: 'invalid_report', message: error.message });
    }
    console.error('[download-dpr] unexpected error', error);
    return res.status(500).json({ error: 'internal_error', message: 'Could not generate the DPR PDF' });
  }
});

export default router;
