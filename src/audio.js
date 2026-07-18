import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { config } from './config.js';

ffmpeg.setFfmpegPath(ffmpegPath);

export async function ensureAudioDir() {
  await fs.mkdir(config.audioDir, { recursive: true });
}

function slugify(name) {
  return String(name || 'greeting')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')      // drop extension
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'greeting';
}

/**
 * Transcode an uploaded buffer to Exotel-compatible audio and store it.
 * Exotel requires .mp3/.wav, 8kHz, mono. We add a unique suffix to the
 * filename so the public URL is always new (defeats Exotel's URL cache).
 *
 * @returns {{fileName, size, durationSec}}
 */
export async function transcodeAndStore(inputBuffer, originalName) {
  await ensureAudioDir();

  const unique = crypto.randomBytes(5).toString('hex');
  const fileName = `${slugify(originalName)}-${unique}.mp3`;
  const outPath = path.join(config.audioDir, fileName);

  const tmpIn = path.join(config.audioDir, `.in-${unique}`);
  await fs.writeFile(tmpIn, inputBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .audioFrequency(8000)     // 8 kHz — Exotel requirement
        .audioChannels(1)         // mono
        .audioCodec('libmp3lame')
        .audioBitrate('32k')      // small; keeps well under the 2 MB cap
        .format('mp3')
        .on('end', resolve)
        .on('error', reject)
        .save(outPath);
    });
  } finally {
    await fs.rm(tmpIn, { force: true });
  }

  const stat = await fs.stat(outPath);
  const durationSec = await probeDuration(outPath).catch(() => null);
  return { fileName, size: stat.size, durationSec };
}

export async function deleteAudioFile(fileName) {
  if (!fileName) return;
  await fs.rm(path.join(config.audioDir, path.basename(fileName)), { force: true });
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data?.format?.duration ?? null);
    });
  });
}
