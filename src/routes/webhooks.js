import { Router } from 'express';
import * as store from '../store.js';
import { config } from '../config.js';
import { numberKey } from '../phone.js';

export const webhooksRouter = Router();

// Optional shared-secret guard (?token=...). If WEBHOOK_TOKEN is unset,
// all requests are allowed (fine for local dev).
function tokenOk(req) {
  if (!config.webhookToken) return true;
  return req.query.token === config.webhookToken;
}

// ── DYNAMIC AUDIO ─────────────────────────────────────────────────────
// Exotel's Greeting/Connect applet (dynamic URL) hits this with a GET
// (and a HEAD to sniff headers). We answer text/plain with a single
// audio URL — the greeting currently mapped to the dialed number, else
// the global active greeting.
//
// Exotel sends: CallSid, From, To, DialWhomNumber.
function resolveAudioUrl(req) {
  const dialed = req.query.DialWhomNumber || req.query.To || req.query.from || '';
  const key = numberKey(dialed);

  if (key && key.length === 10) {
    const url = store.findGreetingUrlByNumberKey(key);
    if (url) return url;
  }

  // Fallback: the globally selected greeting.
  return store.getActiveGreeting()?.url || null;
}

function audioHandler(req, res, next) {
  try {
    if (!tokenOk(req)) return res.status(403).end();
    const url = resolveAudioUrl(req);
    res.set('Content-Type', 'text/plain');
    if (req.method === 'HEAD') return res.status(url ? 200 : 404).end();
    if (!url) return res.status(404).end(); // Exotel proceeds with the call, no audio
    // Body = the audio URL, one per line (Greeting applet contract).
    return res.status(200).send(url);
  } catch (e) { next(e); }
}

webhooksRouter.get('/audio', audioHandler);
webhooksRouter.head('/audio', audioHandler);

// ── PER-CALL STATUS ───────────────────────────────────────────────────
// call_status_callback fires once per call with that call's outcome.
// Exotel usually posts application/x-www-form-urlencoded; we also accept
// JSON. Fields vary by product version — we upsert by CallSid and keep
// the full raw payload.
function pick(body, ...keys) {
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k];
  }
  return null;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toTs(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function callStatusHandler(req, res, next) {
  try {
    if (!tokenOk(req)) return res.status(403).end();
    const b = { ...req.query, ...req.body };

    const callSid = pick(b, 'CallSid', 'Sid', 'call_sid');
    const row = {
      call_sid: callSid ? String(callSid) : null,
      exotel_campaign_id: (() => {
        const v = pick(b, 'CampaignSid', 'CampaignId', 'campaign_id', 'campaign_sid');
        return v != null ? String(v) : null;
      })(),
      to_number: pick(b, 'To', 'DialWhomNumber', 'to'),
      from_number: pick(b, 'From', 'CallFrom', 'from'),
      status: pick(b, 'Status', 'CallStatus', 'status'),
      direction: pick(b, 'Direction', 'direction'),
      start_time: toTs(pick(b, 'StartTime', 'DateCreated', 'start_time')),
      end_time: toTs(pick(b, 'EndTime', 'DateUpdated', 'end_time')),
      duration_sec: toInt(pick(b, 'ConversationDuration', 'DialCallDuration', 'Duration', 'duration')),
      recording_url: pick(b, 'RecordingUrl', 'recording_url'),
      raw: b,
    };

    await store.upsertCall(row);
    res.status(200).json({ ok: true });
  } catch (e) { next(e); }
}

webhooksRouter.post('/call-status', callStatusHandler);
// Exotel may issue GET for some callback configs — accept both.
webhooksRouter.get('/call-status', callStatusHandler);

// ── Other campaign callbacks (logged for completeness) ────────────────
function logOnly(label) {
  return (req, res) => {
    if (!tokenOk(req)) return res.status(403).end();
    console.log(`[webhook:${label}]`, JSON.stringify({ ...req.query, ...req.body }));
    res.status(200).json({ ok: true });
  };
}
webhooksRouter.all('/call-schedule', logOnly('call-schedule'));
webhooksRouter.all('/campaign-status', logOnly('campaign-status'));
