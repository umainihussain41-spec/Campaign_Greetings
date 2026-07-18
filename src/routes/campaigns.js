import { Router } from 'express';
import * as store from '../store.js';
import { config } from '../config.js';
import { parseNumbers, numberKey } from '../phone.js';
import { provisionAndCreateCampaign } from '../exotel.js';

export const campaignsRouter = Router();

function callbackUrl(pathname) {
  const u = new URL(config.publicBaseUrl + pathname);
  if (config.webhookToken) u.searchParams.set('token', config.webhookToken);
  return u.toString();
}

// List campaigns, newest first.
campaignsRouter.get('/', (_req, res) => {
  res.json(store.listCampaigns());
});

// Create + (optionally) schedule a campaign with the chosen greeting.
campaignsRouter.post('/', async (req, res, next) => {
  try {
    const {
      name,
      greeting_id,
      caller_id,
      numbers: numbersBlob,
      send_at,     // ISO 8601 with offset, e.g. 2026-07-20T09:00:00+05:30
      end_at,
      retries,
    } = req.body || {};

    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (!greeting_id) return res.status(400).json({ error: 'greeting_id is required.' });

    const numbers = parseNumbers(numbersBlob);
    if (numbers.length === 0) return res.status(400).json({ error: 'No valid phone numbers provided.' });

    const greeting = store.getGreeting(greeting_id);
    if (!greeting) return res.status(400).json({ error: 'greeting_id not found.' });

    const callerId = (caller_id || config.exotel.callerId || '').trim();
    if (!callerId) return res.status(400).json({ error: 'No caller_id given and EXOTEL_CALLER_ID not set.' });

    // 1. Persist the campaign first (status=created) so we always have a
    //    record even if the Exotel call fails.
    const campaign = await store.insertCampaign({
      name,
      greeting_id,
      greeting_url: greeting.url,   // snapshot: in-flight calls keep this audio
      caller_id: callerId,
      send_at: send_at || null,
      end_at: end_at || null,
      numbers_count: numbers.length,
      status: 'created',
    });

    // 2. Map every number → this greeting so the audio webhook can resolve it.
    await store.insertCampaignNumbers(numbers.map((n) => ({
      campaign_id: campaign.id,
      number_e164: n,
      number_key: numberKey(n),
      greeting_url: greeting.url,
    })));

    // 3. Provision Exotel (contacts → list → campaign).
    try {
      const { campaignId, listSid, raw } = await provisionAndCreateCampaign({
        name,
        callerId,
        numbers,
        sendAt: send_at || undefined,
        endAt: end_at || undefined,
        retries: retries ? Number(retries) : undefined,
        callbacks: {
          callStatus: callbackUrl('/exotel/call-status'),
          callSchedule: callbackUrl('/exotel/call-schedule'),
          campaignStatus: callbackUrl('/exotel/campaign-status'),
        },
      });

      const updated = await store.updateCampaign(campaign.id, {
        exotel_campaign_id: campaignId ? String(campaignId) : null,
        exotel_list_id: listSid ? String(listSid) : null,
        status: send_at ? 'scheduled' : 'in-progress',
        raw,
      });
      res.status(201).json(updated);
    } catch (exErr) {
      await store.updateCampaign(campaign.id, { status: 'failed', last_error: String(exErr.message || exErr) });
      res.status(502).json({
        error: 'Exotel campaign creation failed.',
        detail: String(exErr.message || exErr),
        campaign_id: campaign.id,
      });
    }
  } catch (e) { next(e); }
});

// Calls belonging to a campaign (individual call rows).
campaignsRouter.get('/:id/calls', (req, res) => {
  const campaign = store.getCampaign(req.params.id);
  if (!campaign?.exotel_campaign_id) return res.json([]);
  res.json(store.listCalls({ campaign: campaign.exotel_campaign_id }));
});
