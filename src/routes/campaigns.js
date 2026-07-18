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

// Shared create+provision flow. Persists the campaign first (so a record
// always exists), maps every number → greeting for the audio webhook, then
// provisions Exotel. On Exotel failure it marks the campaign failed and
// throws an error carrying { status, detail, campaignId }.
async function runCampaign({ name, greeting, callerId, numbers, send_at, end_at, retries }) {
  const campaign = await store.insertCampaign({
    name,
    greeting_id: greeting.id,
    greeting_url: greeting.url,   // snapshot: in-flight calls keep this audio
    caller_id: callerId,
    send_at: send_at || null,
    end_at: end_at || null,
    numbers_count: numbers.length,
    status: 'created',
  });

  await store.insertCampaignNumbers(numbers.map((n) => ({
    campaign_id: campaign.id,
    number_e164: n,
    number_key: numberKey(n),
    greeting_url: greeting.url,
  })));

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
    return await store.updateCampaign(campaign.id, {
      exotel_campaign_id: campaignId ? String(campaignId) : null,
      exotel_list_id: listSid ? String(listSid) : null,
      status: send_at ? 'scheduled' : 'in-progress',
      raw,
    });
  } catch (exErr) {
    await store.updateCampaign(campaign.id, { status: 'failed', last_error: String(exErr.message || exErr) });
    const err = new Error('Exotel campaign creation failed.');
    err.status = 502;
    err.detail = String(exErr.message || exErr);
    err.campaignId = campaign.id;
    throw err;
  }
}

// List campaigns, newest first.
campaignsRouter.get('/', (_req, res) => {
  res.json(store.listCampaigns());
});

// Create + (optionally) schedule a campaign with the chosen greeting.
campaignsRouter.post('/', async (req, res, next) => {
  try {
    const { name, greeting_id, caller_id, numbers: numbersBlob, send_at, end_at, retries } = req.body || {};

    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (!greeting_id) return res.status(400).json({ error: 'greeting_id is required.' });

    const numbers = parseNumbers(numbersBlob);
    if (numbers.length === 0) return res.status(400).json({ error: 'No valid phone numbers provided.' });

    const greeting = store.getGreeting(greeting_id);
    if (!greeting) return res.status(400).json({ error: 'greeting_id not found.' });

    const callerId = (caller_id || config.exotel.callerId || '').trim();
    if (!callerId) return res.status(400).json({ error: 'No caller_id given and EXOTEL_CALLER_ID not set.' });

    const campaign = await runCampaign({ name, greeting, callerId, numbers, send_at, end_at, retries });
    res.status(201).json(campaign);
  } catch (e) {
    if (e.status === 502) return res.status(502).json({ error: e.message, detail: e.detail, campaign_id: e.campaignId });
    next(e);
  }
});

// Re-run only the failed numbers of a campaign as a fresh "retry" campaign,
// reusing the original greeting and caller id. Fires immediately.
campaignsRouter.post('/:id/rerun-failed', async (req, res, next) => {
  try {
    const source = store.getCampaign(req.params.id);
    if (!source) return res.status(404).json({ error: 'campaign not found.' });
    if (!source.exotel_campaign_id) return res.status(400).json({ error: 'This campaign was never provisioned on Exotel, so it has no call results to retry.' });

    const failed = store.failedNumbersForCampaign(source.exotel_campaign_id);
    if (failed.length === 0) return res.status(400).json({ error: 'No failed calls to retry for this campaign.' });

    const greeting = store.getGreeting(source.greeting_id);
    if (!greeting) return res.status(400).json({ error: 'Original greeting no longer exists; cannot retry.' });

    const numbers = parseNumbers(failed.join(','));
    const retryName = `${source.name} (retry)`.slice(0, 60);

    const campaign = await runCampaign({
      name: retryName,
      greeting,
      callerId: source.caller_id,
      numbers,
      send_at: null,          // retries fire immediately
      end_at: null,
      retries: undefined,
    });
    res.status(201).json({ ...campaign, retried_count: numbers.length, source_id: source.id });
  } catch (e) {
    if (e.status === 502) return res.status(502).json({ error: e.message, detail: e.detail, campaign_id: e.campaignId });
    next(e);
  }
});

// Calls belonging to a campaign (individual call rows).
campaignsRouter.get('/:id/calls', (req, res) => {
  const campaign = store.getCampaign(req.params.id);
  if (!campaign?.exotel_campaign_id) return res.json([]);
  res.json(store.listCalls({ campaign: campaign.exotel_campaign_id }));
});
