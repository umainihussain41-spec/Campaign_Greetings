import { randomUUID } from 'node:crypto';
import { config, flowUrl } from './config.js';
import { toE164 } from './phone.js';

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

// Bulk-register contacts and return their Exotel SIDs. Numbers are
// normalized to E.164 first (Exotel rejects other formats). The API is
// multi-status (207): each entry carries data.sid on success (200) AND on
// duplicate (409, "already exists"), so we harvest the sid in both cases.
export async function createContacts(numbers) {
  const e164 = numbers.map((n) => toE164(n, config.exotel.countryCode)).filter(Boolean);
  const json = await call('POST', `${base()}/contacts`, {
    contacts: e164.map((number) => ({ number })),
  });
  const sids = [];
  for (const r of json?.response || []) {
    const sid = r?.data?.sid;
    if (sid) sids.push(sid);
  }
  return { sids, raw: json };
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

// Attach contacts to a list by SID reference. Exotel expects
// `contact_references` as an array of { contact_sid } objects.
export async function addContactsToList(listSid, contactSids) {
  const body = { contact_references: contactSids.map((contact_sid) => ({ contact_sid })) };
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
  // 1. Register the contacts (E.164) in the Campaigns addressbook; capture SIDs.
  const { sids } = await createContacts(numbers);
  if (!sids.length) throw new Error('Exotel returned no contact SIDs - check number formatting (E.164) in the logs.');
  // 2. Create a list dedicated to this campaign. Exotel rejects duplicate
  //    list names (409, no sid returned), so make the name unique per run.
  const suffix = randomUUID().slice(0, 8);
  const { sid: listSid, raw: listRaw } =
    await createList(`dg-${name}-${suffix}`.slice(0, 60));
  if (!listSid) {
    const why = listRaw?.response?.[0]?.error_data?.description || 'no sid in response';
    throw new Error(`Exotel did not return a list SID when creating the list (${why}).`);
  }
  // 3. Attach contacts to the list by SID reference.
  await addContactsToList(listSid, sids);
  // 4. Create the campaign against that list.
  const { id: campaignId, raw } = await createCampaign({
    name, callerId, listSid, sendAt, endAt, retries, callbacks,
  });
  return { campaignId, listSid, raw };
}
