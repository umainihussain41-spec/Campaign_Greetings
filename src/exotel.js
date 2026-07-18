import { config, flowUrl } from './config.js';

const base = () =>
  `https://${config.exotel.subdomain}/v2/accounts/${config.exotel.sid}`;

function authHeader() {
  const raw = `${config.exotel.apiKey}:${config.exotel.apiToken}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.response?.[0]?.error_data?.description
      || json?.error_data?.description
      || json?.message
      || text
      || res.statusText;
    const err = new Error(`Exotel ${method} ${url} → ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── Contacts + Lists (a static campaign dials a List SID) ─────────────
// Docs: POST /contacts, POST /lists, POST /lists/{sid}/contacts
// https://developer.exotel.com/api/create-lists

export async function createContacts(numbers) {
  const body = {
    contacts: numbers.map((n) => ({ number: n })),
  };
  return call('POST', `${base()}/contacts`, body);
}

export async function createList(name) {
  const body = { lists: [{ name }] };
  const json = await call('POST', `${base()}/lists`, body);
  const sid =
    json?.response?.[0]?.data?.sid ||
    json?.data?.[0]?.sid ||
    json?.data?.sid ||
    json?.lists?.[0]?.sid;
  return { sid, raw: json };
}

export async function addContactsToList(listSid, numbers) {
  const body = { contacts: numbers.map((n) => ({ number: n })) };
  return call('POST', `${base()}/lists/${listSid}/contacts`, body);
}

// ── Campaign ──────────────────────────────────────────────────────────
// https://developer.exotel.com/api/campaigns

/**
 * @param {object} p
 * @param {string} p.name
 * @param {string} p.callerId
 * @param {string} p.listSid
 * @param {string} [p.sendAt]  ISO 8601 with offset, e.g. 2026-07-20T09:00:00+05:30
 * @param {string} [p.endAt]
 * @param {number} [p.retries]
 * @param {object} p.callbacks  { callStatus, callSchedule, campaignStatus }
 */
export async function createCampaign(p) {
  const campaign = {
    name: p.name,
    caller_id: p.callerId,
    url: flowUrl(),                 // the flow whose applet calls our /exotel/audio
    campaign_type: 'static',
    lists: [p.listSid],
    call_status_callback: p.callbacks.callStatus,
    call_schedule_callback: p.callbacks.callSchedule,
    status_callback: p.callbacks.campaignStatus,
  };

  if (p.sendAt || p.endAt) {
    campaign.schedule = {};
    if (p.sendAt) campaign.schedule.send_at = p.sendAt;
    if (p.endAt) campaign.schedule.end_at = p.endAt;
  }
  if (p.retries && p.retries > 0) {
    campaign.retries = { number_of_retries: p.retries };
  }

  const json = await call('POST', `${base()}/campaigns`, { campaigns: [campaign] });
  const id =
    json?.response?.[0]?.data?.id ||
    json?.response?.[0]?.data?.sid ||
    json?.data?.[0]?.id ||
    json?.data?.id;
  return { id, raw: json };
}

/**
 * Full provisioning: contacts → list → add → campaign.
 * Returns { campaignId, listSid, raw }.
 */
export async function provisionAndCreateCampaign({ name, callerId, numbers, sendAt, endAt, retries, callbacks }) {
  // 1. Register the contacts in the Campaigns addressbook.
  await createContacts(numbers);
  // 2. Create a list dedicated to this campaign (names must be unique).
  const { sid: listSid } = await createList(`dg-${name}-${numbers.length}-${sendAt || 'now'}`.slice(0, 60));
  if (!listSid) throw new Error('Exotel did not return a list SID when creating the list.');
  // 3. Attach contacts to the list.
  await addContactsToList(listSid, numbers);
  // 4. Create the campaign against that list.
  const { id: campaignId, raw } = await createCampaign({
    name, callerId, listSid, sendAt, endAt, retries, callbacks,
  });
  return { campaignId, listSid, raw };
}
