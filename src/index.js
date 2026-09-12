import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { config, validateConfig } from './config.js';
import translateRoute from './routes/translate.js';
import voiceRoute from './routes/voice.js';
import intakeRoute from './routes/intake.js';
import v1IntakeRoute from './routes/v1Intake.js';
import reportRoute from './routes/report.js';
import analyzeRoute from './routes/analyze.js';
import downloadDprRoute from './routes/downloadDpr.js';

// Fail loudly (but not fatally) at boot for missing secrets, rather than
// letting each route discover it independently on first request.
validateConfig();

const app = express();
const PORT = config.port;

app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  })
);
app.use(express.json({ limit: '1mb' }));

// Basic abuse protection - tune per your traffic/cost budget.
// STT/TTS calls cost real money upstream, so this matters more than it
// looks: without it, one buggy client can burn your Sarvam credits.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 requests/minute/IP across translate+voice
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/translate', translateRoute);
app.use('/api/voice', voiceRoute);
app.use('/api/intake', intakeRoute);
app.use('/api/v1/intake', v1IntakeRoute);
app.use('/api/report', reportRoute);
app.use('/api/v1/analyze', analyzeRoute);
app.use('/api/v1/download-dpr', downloadDprRoute);

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error', message: 'Unexpected server error' });
});

app.listen(PORT, () => {
  console.log(`GramUdyam API listening on port ${PORT}`);
});
