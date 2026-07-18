import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ensureAudioDir } from './audio.js';
import { initStore } from './store.js';
import { greetingsRouter } from './routes/greetings.js';
import { campaignsRouter } from './routes/campaigns.js';
import { callsRouter } from './routes/calls.js';
import { webhooksRouter } from './routes/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Exotel posts form-encoded

// Serve the transcoded MP3s. This is the URL Exotel fetches.
app.use('/audio', express.static(config.audioDir, {
  setHeaders: (res) => res.set('Content-Type', 'audio/mpeg'),
}));

// Frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// API
app.use('/api/greetings', greetingsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/calls', callsRouter);

// Exotel webhooks
app.use('/exotel', webhooksRouter);

app.get('/health', (_req, res) => res.json({ ok: true, base: config.publicBaseUrl }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: String(err.message || err) });
});

await ensureAudioDir();
initStore();
app.listen(config.port, () => {
  console.log(`Dynamic Greetings on :${config.port}`);
  console.log(`Public base URL     ${config.publicBaseUrl}`);
  console.log(`Audio webhook       ${config.publicBaseUrl}/exotel/audio`);
  console.log(`Call-status webhook ${config.publicBaseUrl}/exotel/call-status`);
});
