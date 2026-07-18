const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const api = {
  async get(u) { const r = await fetch(u); if (!r.ok) throw await err(r); return r.json(); },
  async post(u, body, isForm) {
    const opt = { method: 'POST' };
    if (isForm) opt.body = body;
    else { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body || {}); }
    const r = await fetch(u, opt); if (!r.ok) throw await err(r); return r.json();
  },
  async del(u) { const r = await fetch(u, { method: 'DELETE' }); if (!r.ok) throw await err(r); },
};
async function err(r) { try { const j = await r.json(); return new Error(j.detail || j.error || r.statusText); } catch { return new Error(r.statusText); } }

const toIST = (v) => (v ? `${v}:00+05:30` : null);
const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// Mirror of server-side store.classifyStatus so charts/counters agree.
function classify(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'other';
  // Failure first — "no-answer" contains "answer".
  if (/(fail|busy|no[-_ ]?answer|cancel|declin|reject|missed|unreach)/.test(s)) return 'failed';
  if (/(complete|answer|success)/.test(s)) return 'completed';
  if (/(progress|ringing|queued|initiat|dial)/.test(s)) return 'pending';
  return 'other';
}
const key10 = (n) => String(n || '').replace(/\D/g, '').slice(-10);

// ── Shared state ──────────────────────────────────────────────
let greetings = [], campaigns = [], calls = [];
const OUTCOME_COLORS = { completed: '#16a34a', failed: '#dc2626', pending: '#2563eb', other: '#94a3b8' };

function toast(msg, type = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + type;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 4200);
}

// Stats for one campaign (by its Exotel campaign id), using latest call per number.
function campaignStats(exotelId) {
  const st = { total: 0, completed: 0, failed: 0, pending: 0, other: 0, failedNums: new Set() };
  if (!exotelId) return st;
  const latest = new Map();
  for (const c of calls) {
    if (String(c.exotel_campaign_id) !== String(exotelId)) continue;
    const k = key10(c.to_number); if (k.length !== 10) continue;
    const prev = latest.get(k);
    if (!prev || (c.received_at || '') > (prev.received_at || '')) latest.set(k, c);
  }
  for (const c of latest.values()) {
    const cls = classify(c.status);
    st.total++; st[cls]++;
    if (cls === 'failed') st.failedNums.add(k10OrRaw(c.to_number));
  }
  return st;
}
function k10OrRaw(n) { return n; }

// ── SVG charts (no external libs) ─────────────────────────────
function donutSVG(segments, size = 150) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const sw = 24, r = size / 2 - sw / 2, cx = size / 2, C = 2 * Math.PI * r;
  if (!total) return '';
  let off = 0;
  const rings = segments.filter((s) => s.value > 0).map((s) => {
    const frac = s.value / total, len = frac * C;
    const el = `<circle cx="${cx}" cy="${cy(size)}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${size / 2})"/>`;
    off += len; return el;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${size / 2}" r="${r}" fill="none" stroke="#eef1f7" stroke-width="${sw}"/>
    ${rings}
    <text x="${cx}" y="${size / 2 - 4}" text-anchor="middle" font-size="26" font-weight="800" fill="#1f2430">${total}</text>
    <text x="${cx}" y="${size / 2 + 16}" text-anchor="middle" font-size="11" fill="#6b7280">calls</text>
  </svg>`;
}
const cy = (size) => size / 2;

function renderDonut() {
  const buckets = { completed: 0, failed: 0, pending: 0, other: 0 };
  for (const c of calls) buckets[classify(c.status)]++;
  const segs = [
    { label: 'Completed', value: buckets.completed, color: OUTCOME_COLORS.completed },
    { label: 'Failed', value: buckets.failed, color: OUTCOME_COLORS.failed },
    { label: 'Pending', value: buckets.pending, color: OUTCOME_COLORS.pending },
    { label: 'Other', value: buckets.other, color: OUTCOME_COLORS.other },
  ];
  const total = segs.reduce((a, s) => a + s.value, 0);
  const box = $('#donut');
  if (!total) { box.innerHTML = '<div class="chart-empty">No call data yet.<br/>Results appear here as Exotel reports them.</div>'; return; }
  box.innerHTML = donutSVG(segs) + `<div class="legend">${segs.map((s) => `
    <div class="li"><span class="sw" style="background:${s.color}"></span>
    <span class="ln">${s.label}</span><span class="lv">${s.value}</span></div>`).join('')}</div>`;
}

function renderBars() {
  const box = $('#bars');
  const rows = campaigns
    .filter((c) => c.exotel_campaign_id)
    .map((c) => ({ name: c.name, n: campaignStats(c.exotel_campaign_id).total }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n).slice(0, 8);
  if (!rows.length) { box.innerHTML = '<div class="chart-empty">No calls attributed to a campaign yet.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.n));
  box.innerHTML = rows.map((r) => `
    <div class="bar-row">
      <span class="bl" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (r.n / max) * 100)}%"></span></span>
      <span class="bv">${r.n}</span>
    </div>`).join('');
}

// ── Dashboard tiles + recent calls ────────────────────────────
function renderTiles() {
  const b = { completed: 0, failed: 0, pending: 0, other: 0 };
  let durSum = 0, durN = 0;
  for (const c of calls) {
    b[classify(c.status)]++;
    if (Number.isFinite(c.duration_sec)) { durSum += c.duration_sec; durN++; }
  }
  const avg = durN ? Math.round(durSum / durN) : 0;
  const active = campaigns.filter((c) => c.status === 'in-progress' || c.status === 'scheduled').length;
  const tiles = [
    { k: 'Total calls', v: calls.length, cls: 't-blue', sfx: `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}` },
    { k: 'Completed', v: b.completed, cls: 't-green', sfx: pct(b.completed, calls.length) },
    { k: 'Failed', v: b.failed, cls: 't-red', sfx: pct(b.failed, calls.length) },
    { k: 'Pending', v: b.pending, cls: 't-amber', sfx: 'awaiting result' },
    { k: 'Avg duration', v: avg + 's', cls: 't-ink', sfx: `${durN} with duration` },
    { k: 'Active campaigns', v: active, cls: 't-blue', sfx: `${greetings.length} greeting${greetings.length === 1 ? '' : 's'}` },
  ];
  $('#tiles').innerHTML = tiles.map((t) => `
    <div class="tile ${t.cls}"><span class="accent"></span>
      <div class="k">${t.k}</div><div class="v">${t.v}</div><div class="sfx">${t.sfx}</div></div>`).join('');
}
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}% of total` : '—');

function callRow(c) {
  const cls = classify(c.status);
  return `<tr>
    <td>${fmt(c.received_at)}</td>
    <td>${esc(c.to_number || '—')}</td>
    <td><span class="pill ${cls}">${esc(c.status || '—')}</span></td>
    <td>${c.duration_sec ?? '—'}${Number.isFinite(c.duration_sec) ? 's' : ''}</td>
    <td>${esc(campaignName(c.exotel_campaign_id))}</td>
    <td>${c.recording_url ? `<a href="${esc(c.recording_url)}" target="_blank" rel="noopener">▶ play</a>` : '—'}</td>
  </tr>`;
}
function campaignName(exotelId) {
  if (!exotelId) return '—';
  const c = campaigns.find((x) => String(x.exotel_campaign_id) === String(exotelId));
  return c ? c.name : '#' + exotelId;
}

function renderRecent() {
  const tb = $('#recent-calls tbody');
  if (!calls.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No call data received yet.</td></tr>'; return; }
  tb.innerHTML = calls.slice(0, 12).map(callRow).join('');
}

// ── Campaigns view ────────────────────────────────────────────
function greetingName(id) { const g = greetings.find((x) => x.id === id); return g ? g.name : '—'; }

function renderCampaigns() {
  const box = $('#campaigns');
  $('#campaigns-count').textContent = campaigns.length ? `${campaigns.length} total` : '';
  if (!campaigns.length) { box.innerHTML = '<div class="empty">No campaigns yet. Create one from “New Campaign”.</div>'; return; }
  box.innerHTML = campaigns.map((c) => {
    const s = campaignStats(c.exotel_campaign_id);
    const failN = s.failedNums.size;
    const segs = s.total ? `
      <div class="camp-progress" title="${s.completed} completed · ${s.failed} failed · ${s.pending} pending">
        <i class="ok" style="width:${(s.completed / s.total) * 100}%"></i>
        <i class="fail" style="width:${(s.failed / s.total) * 100}%"></i>
        <i class="pend" style="width:${(s.pending / s.total) * 100}%"></i>
      </div>` : '';
    return `<div class="camp">
      <div class="camp-top">
        <div>
          <div class="camp-title">${esc(c.name)} <span class="pill ${esc(c.status)}">${esc(c.status)}</span></div>
          <div class="camp-sub">
            🎙️ ${esc(greetingName(c.greeting_id))} · 📞 ${c.numbers_count || 0} numbers ·
            ${c.send_at ? 'send ' + fmt(c.send_at) : 'immediate'}
            ${c.exotel_campaign_id ? ' · Exotel #' + esc(c.exotel_campaign_id) : ''}
            ${c.last_error ? ' · <span style="color:#dc2626">⚠ ' + esc(c.last_error) + '</span>' : ''}
          </div>
        </div>
        <div class="camp-actions">
          <button class="btn ghost sm" data-view-calls="${esc(c.exotel_campaign_id || '')}">View calls</button>
          <button class="btn retry sm" data-rerun="${c.id}" ${failN ? '' : 'disabled'}>
            ↻ Re-run failed${failN ? ` (${failN})` : ''}</button>
        </div>
      </div>
      <div class="camp-mini">
        <div class="mini"><div class="mk">Received</div><div class="mv">${s.total}</div></div>
        <div class="mini green"><div class="mk">Completed</div><div class="mv">${s.completed}</div></div>
        <div class="mini red"><div class="mk">Failed</div><div class="mv">${s.failed}</div></div>
        <div class="mini amber"><div class="mk">Pending</div><div class="mv">${s.pending}</div></div>
      </div>
      ${segs}
    </div>`;
  }).join('');
}

function renderCallsFilter() {
  const sel = $('#calls-filter'); const cur = sel.value;
  const opts = ['<option value="">All campaigns</option>'].concat(
    campaigns.filter((c) => c.exotel_campaign_id).map((c) =>
      `<option value="${esc(c.exotel_campaign_id)}">${esc(c.name)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = cur;
}

function renderCallsTable() {
  const filter = $('#calls-filter').value;
  const rows = filter ? calls.filter((c) => String(c.exotel_campaign_id) === String(filter)) : calls;
  const tb = $('#calls tbody');
  tb.innerHTML = rows.length ? rows.map(callRow).join('')
    : '<tr><td colspan="6" class="empty">No calls for this selection yet.</td></tr>';
}

// ── Greetings view ────────────────────────────────────────────
function renderLibrary() {
  const lib = $('#library'); const sel = $('#c-greeting'); sel.innerHTML = '';
  $('#side-greeting').textContent = (greetings.find((g) => g.is_active)?.name) || 'none selected';
  if (!greetings.length) { lib.innerHTML = '<div class="empty">No greetings yet — upload one above.</div>'; return; }
  lib.innerHTML = greetings.map((g) => `
    <div class="item ${g.is_active ? 'active' : ''}">
      <div class="meta">
        <b>${esc(g.name)} ${g.is_active ? '<span class="pill on">active default</span>' : ''}</b>
        <small>${g.duration_sec ? Math.round(g.duration_sec) + 's · ' : ''}${Math.round((g.size_bytes || 0) / 1024)} KB</small>
      </div>
      <audio controls preload="none" src="${esc(g.url)}"></audio>
      <button class="btn ghost sm" data-select="${g.id}">${g.is_active ? '✓ Default' : 'Set default'}</button>
      <button class="btn danger sm" data-del="${g.id}">Delete</button>`).join('');
  for (const g of greetings) {
    const opt = document.createElement('option'); opt.value = g.id; opt.textContent = g.name; sel.appendChild(opt);
  }
}

// ── Data loading + render ─────────────────────────────────────
async function loadAll() {
  [greetings, campaigns, calls] = await Promise.all([
    api.get('/api/greetings'), api.get('/api/campaigns'), api.get('/api/calls'),
  ]).catch((e) => { toast(e.message, 'err'); return [greetings, campaigns, calls]; });
  renderEverything();
}
async function loadCalls() { try { calls = await api.get('/api/calls'); renderEverything(); } catch {} }

function renderEverything() {
  renderTiles(); renderDonut(); renderBars(); renderRecent();
  renderCampaigns(); renderCallsFilter(); renderCallsTable();
  renderLibrary();
}

// ── View switching ────────────────────────────────────────────
const VIEW_META = {
  dashboard: ['Dashboard', 'Live overview of your voice campaigns.'],
  new: ['New Campaign', 'Upload numbers, pick a greeting, and launch.'],
  campaigns: ['Campaigns', 'Per-campaign results, filters, and failed-call retries.'],
  greetings: ['MP3 Library', 'Manage the greetings Exotel can play.'],
};
function switchView(v) {
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  $$('.view').forEach((s) => s.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  $('#view-title').textContent = VIEW_META[v][0];
  $('#view-sub').textContent = VIEW_META[v][1];
}

// ── Events ────────────────────────────────────────────────────
$$('.nav-link').forEach((a) => a.addEventListener('click', () => switchView(a.dataset.view)));
$('#refresh-all').addEventListener('click', loadAll);
$('#calls-filter').addEventListener('change', renderCallsTable);

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#up-file').files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file); fd.append('name', $('#up-name').value || file.name);
  try { await api.post('/api/greetings', fd, true); $('#upload-form').reset(); await loadAll(); toast('Greeting uploaded.', 'ok'); }
  catch (e) { toast('Upload failed: ' + e.message, 'err'); }
});

$('#library').addEventListener('click', async (e) => {
  const sel = e.target.getAttribute('data-select'), del = e.target.getAttribute('data-del');
  try {
    if (sel) { await api.post(`/api/greetings/${sel}/select`, {}); await loadAll(); toast('Default greeting updated.', 'ok'); }
    if (del && confirm('Delete this greeting?')) { await api.del(`/api/greetings/${del}`); await loadAll(); toast('Greeting deleted.'); }
  } catch (e) { toast(e.message, 'err'); }
});

$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('#c-status'); st.className = 'status'; st.textContent = 'Creating…';
  try {
    await api.post('/api/campaigns', {
      name: $('#c-name').value, caller_id: $('#c-caller').value, greeting_id: $('#c-greeting').value,
      numbers: $('#c-numbers').value, send_at: toIST($('#c-sendat').value),
      end_at: toIST($('#c-endat').value), retries: $('#c-retries').value,
    });
    st.className = 'status ok'; st.textContent = '✓ Created';
    $('#campaign-form').reset();
    await loadAll(); switchView('campaigns'); toast('Campaign created.', 'ok');
  } catch (e) { st.className = 'status err'; st.textContent = '✗ ' + e.message; toast(e.message, 'err'); }
});

$('#campaigns').addEventListener('click', async (e) => {
  const rerun = e.target.getAttribute('data-rerun');
  const viewCalls = e.target.getAttribute('data-view-calls');
  if (viewCalls !== null) { $('#calls-filter').value = viewCalls; renderCallsTable(); $('#calls-filter').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (rerun) {
    if (!confirm('Launch a new campaign dialing only the failed numbers from this campaign?')) return;
    e.target.disabled = true; e.target.textContent = 'Launching…';
    try {
      const r = await api.post(`/api/campaigns/${rerun}/rerun-failed`, {});
      toast(`Retry launched: ${r.retried_count} number(s) re-dialed.`, 'ok');
      await loadAll();
    } catch (e) { toast('Retry failed: ' + e.message, 'err'); await loadAll(); }
  }
});

// ── Init ──────────────────────────────────────────────────────
$('#side-base').textContent = location.host;
loadAll();
setInterval(loadCalls, 15000);
setInterval(() => api.get('/api/campaigns').then((c) => { campaigns = c; renderEverything(); }).catch(() => {}), 30000);
