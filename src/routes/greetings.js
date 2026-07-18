import { Router } from 'express';
import multer from 'multer';
import * as store from '../store.js';
import { transcodeAndStore, deleteAudioFile } from '../audio.js';
import { audioUrl } from '../config.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB pre-transcode input cap
});

export const greetingsRouter = Router();

// List the whole MP3 library, newest first.
greetingsRouter.get('/', (_req, res) => {
  res.json(store.listGreetings());
});

// Upload an MP3/WAV → transcode to 8kHz mono → store → record.
greetingsRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file").' });
    const name = (req.body.name || req.file.originalname || 'Greeting').trim();

    const { fileName, size, durationSec } = await transcodeAndStore(req.file.buffer, req.file.originalname);

    const row = await store.insertGreeting({
      name,
      file_name: fileName,
      original_name: req.file.originalname,
      url: audioUrl(fileName),
      size_bytes: size,
      duration_sec: durationSec,
    });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// Mark one greeting as the global "active" fallback (single-select).
greetingsRouter.post('/:id/select', async (req, res, next) => {
  try {
    const row = await store.setActiveGreeting(req.params.id);
    if (!row) return res.status(404).json({ error: 'greeting not found' });
    res.json(row);
  } catch (e) { next(e); }
});

greetingsRouter.delete('/:id', async (req, res, next) => {
  try {
    const removed = await store.deleteGreeting(req.params.id);
    if (removed?.file_name) await deleteAudioFile(removed.file_name);
    res.status(204).end();
  } catch (e) { next(e); }
});
