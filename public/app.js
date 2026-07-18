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
const fmt = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const key10 = (n) => String(n || '').replace(/\D/g, '').slice(-10);

// ── Icons (inline SVG, stroke = currentColor) ─────────────────
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  broadcast: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  music: '<circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="15.5" r="2.5"/><path d="M8.5 18V6l11-2.2v11.7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  play: '<path d="M7 5l11 7-11 7z"/>',
};
const icon = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;

// ── Status classification ─────────────────────────────────────
// Granular bucket for one raw Exotel call status. Order matters.
function granular(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'other';
  if (/busy/.test(s)) return 'busy';
  if (/no[-_ ]?answer/.test(s)) return 'noanswer';
  if (/(fail|cancel|declin|reject|missed|unreach|dnd)/.test(s)) return 'failed';
  if (/(complete|answer|success)/.test(s)) return 'completed';
  if (/(progress|ringing|queued|initiat|dial|schedul)/.test(s)) return 'pending';
  return 'other';
}
const RETRYABLE = new Set(['failed', 'busy', 'noanswer']);
// Ordered buckets (Exotel-style legend), with colors.
const BUCKETS = [
  { key: 'completed', label: 'Completed', color: '#16a34a' },
  { key: 'pending', label: 'In Progress', color: '#2563eb' },
  { key: 'failed', label: 'Failed', color: '#dc2626' },
  { key: 'busy', label: 'Busy', color: '#ca8a04' },
  { key: 'noanswer', label: 'No Answer', color: '#db7f2e' },
  { key: 'other', label: 'Other', color: '#94a3b8' },
];
const COLOR = Object.fromEntries(BUCKETS.map((b) => [b.key, b.color]));

// ── Shared state ──────────────────────────────────────────────
let greetings = [], campaigns = [], calls = [], selectedId = null;

function toast(msg, type = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + type;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 4200);
}

// Latest call per distinct recipient number for a campaign.
function latestByNumber(exotelId) {
  const m = new Map();
  if (!exotelId) return m;
  for (const c of calls) {
    if (String(c.exotel_campaign_id) !== String(exotelId)) continue;
    const k = key10(c.to_number); if (k.length !== 10) continue;
    const prev = m.get(k);
    if (!prev || (c.received_at || '') > (prev.received_at || '')) m.set(k, c);
  }
  return m;
}

// Per-campaign stats keyed by granular bucket.
function statsFor(camp) {
  const counts = { completed: 0, pending: 0, failed: 0, busy: 0, noanswer: 0, other: 0 };
  const failedNums = new Set();
  for (const c of latestByNumber(camp.exotel_campaign_id).values()) {
    const g = granular(c.status); counts[g]++;
    if (RETRYABLE.has(g)) failedNums.add(key10(c.to_number));
  }
  const accounted = Object.values(counts).reduce((a, b) => a + b, 0);
  const target = Math.max(camp.numbers_count || 0, accounted);
  return {
    counts, failedNums, accounted, target,
    awaiting: Math.max(0, target - accounted),
    completed: counts.completed,
    failed: counts.failed + counts.busy + counts.noanswer,
  };
}

// Effective status shown on the pill: Exotel's authoritative status if known,
// else derived from call outcomes, else our provisioning status.
function statusInfo(camp) {
  if (camp.status === 'failed') return { label: 'Failed', cls: 'failed' };
  if (camp.exotel_status) {
    const s = camp.exotel_status.toLowerCase();
    if (/complete/.test(s)) return { label: 'Completed', cls: 'completed' };
    if (/fail/.test(s)) return { label: 'Failed', cls: 'failed' };
    if (/progress|running|active/.test(s)) return { label: 'In Progress', cls: 'in-progress' };
    if (/schedul/.test(s)) return { label: 'Scheduled', cls: 'scheduled' };
    if (/paus/.test(s)) return { label: 'Paused', cls: 'pending' };
    return { label: title(camp.exotel_status), cls: 'pending' };
  }
  const s = statsFor(camp);
  if (camp.status === 'scheduled' && s.accounted === 0) return { label: 'Scheduled', cls: 'scheduled' };
  if (s.accounted === 0) return { label: title(camp.status), cls: normCls(camp.status) };
  if (s.awaiting > 0 || s.counts.pending > 0) return { label: 'In Progress', cls: 'in-progress' };
  if (s.completed > 0 && s.failed > 0) return { label: 'Partial', cls: 'partial' };
  if (s.failed > 0 && s.completed === 0) return { label: 'Failed', cls: 'failed' };
  if (s.completed > 0) return { label: 'Completed', cls: 'completed' };
  return { label: title(camp.status), cls: normCls(camp.status) };
}
const title = (s) => String(s || '-').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
const normCls = (s) => (String(s).toLowerCase() === 'in-progress' ? 'in-progress' : String(s).toLowerCase());

// ── SVG donut ─────────────────────────────────────────────────
function donutSVG(segs, centerNum, centerLabel, size = 168) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  const sw = 26, r = size / 2 - sw / 2, cx = size / 2, C = 2 * Math.PI * r;
  let off = 0;
  const rings = total ? segs.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * C;
    const el = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cx})"/>`;
    off += len; return el;
  }).join('') : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#eef1f6" stroke-width="${sw}"/>
    ${rings}
    <text x="${cx}" y="${cx - 3}" text-anchor="middle" font-size="26" font-weight="750" fill="#111827">${centerNum}</text>
    <text x="${cx}" y="${cx + 16}" text-anchor="middle" font-size="11" fill="#6b7280">${centerLabel}</text>
  </svg>`;
}
function donutBlock(counts, centerNum, centerLabel, showZeros) {
  const segs = BUCKETS.map((b) => ({ label: b.label, value: counts[b.key] || 0, color: b.color }));
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total && !showZeros) return '<div class="chart-empty">No call data yet.<br/>Results appear here as Exotel reports them.</div>';
  const legend = BUCKETS.filter((b) => showZeros || counts[b.key])
    .map((b) => `<div class="li"><span class="sw" style="background:${b.color}"></span><span class="ln">${b.label}</span><span class="lv">${counts[b.key] || 0}</span></div>`).join('');
  return donutSVG(segs, centerNum, centerLabel) + `<div class="legend">${legend}</div>`;
}

// ── Dashboard ─────────────────────────────────────────────────
function globalCounts() {
  const counts = { completed: 0, pending: 0, failed: 0, busy: 0, noanswer: 0, other: 0 };
  let durSum = 0, durN = 0;
  for (const c of calls) {
    counts[granular(c.status)]++;
    if (Number.isFinite(c.duration_sec)) { durSum += c.duration_sec; durN++; }
  }
  return { counts, avg: durN ? Math.round(durSum / durN) : 0, durN };
}
function renderTiles() {
  const { counts, avg, durN } = globalCounts();
  const failed = counts.failed + counts.busy + counts.noanswer;
  const active = campaigns.filter((c) => ['in-progress', 'scheduled'].includes(statusInfo(c).cls)).length;
  const tiles = [
    { k: 'Total calls', v: calls.length, cls: 't-blue', sfx: `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}` },
    { k: 'Completed', v: counts.completed, cls: 't-green', sfx: pct(counts.completed, calls.length) },
    { k: 'Failed', v: failed, cls: 't-red', sfx: pct(failed, calls.length) },
    { k: 'In progress', v: counts.pending, cls: 't-amber', sfx: 'awaiting result' },
    { k: 'Avg duration', v: avg + 's', cls: '', sfx: `${durN} with duration` },
    { k: 'Active campaigns', v: active, cls: 't-blue', sfx: `${greetings.length} greeting${greetings.length === 1 ? '' : 's'}` },
  ];
  $('#tiles').innerHTML = tiles.map((t) => `<div class="tile ${t.cls}"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="sfx">${t.sfx}</div></div>`).join('');
}
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}% of total` : '-');

function renderDonut() { $('#donut').innerHTML = donutBlock(globalCounts().counts, calls.length, 'calls', true); }

function renderBars() {
  const box = $('#bars');
  const rows = campaigns.filter((c) => c.exotel_campaign_id)
    .map((c) => ({ name: c.name, n: statsFor(c).accounted }))
    .filter((r) => r.n > 0).sort((a, b) => b.n - a.n).slice(0, 8);
  if (!rows.length) { box.innerHTML = '<div class="chart-empty">No calls attributed to a campaign yet.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.n));
  box.innerHTML = rows.map((r) => `<div class="bar-row"><span class="bl" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (r.n / max) * 100)}%"></span></span><span class="bv num">${r.n}</span></div>`).join('');
}

function campaignName(exotelId) {
  if (!exotelId) return '-';
  const c = campaigns.find((x) => String(x.exotel_campaign_id) === String(exotelId));
  return c ? c.name : '#' + exotelId;
}
function callRow(c, opts = {}) {
  const g = granular(c.status);
  return `<tr>
    <td>${fmt(c.received_at)}</td>
    <td>${esc(c.to_number || '-')}</td>
    <td><span class="pill ${g === 'noanswer' || g === 'busy' ? 'failed' : g}">${esc(c.status || '-')}</span></td>
    <td class="num">${c.duration_sec ?? '-'}${Number.isFinite(c.duration_sec) ? 's' : ''}</td>
    <td>${opts.started ? fmt(c.start_time) : esc(campaignName(c.exotel_campaign_id))}</td>
    <td>${c.recording_url ? `<a href="${esc(c.recording_url)}" target="_blank" rel="noopener">${icon('play')} play</a>` : '-'}</td>
  </tr>`;
}
function renderRecent() {
  const tb = $('#recent-calls tbody');
  tb.innerHTML = calls.length ? calls.slice(0, 12).map((c) => callRow(c)).join('')
    : '<tr><td colspan="6" class="empty">No call data received yet.</td></tr>';
}

// ── Campaigns list ────────────────────────────────────────────
function greetingName(id) { const g = greetings.find((x) => x.id === id); return g ? g.name : '-'; }
function renderCampaignsList() {
  $('#campaigns-count').textContent = campaigns.length ? `${campaigns.length} total` : '';
  const tb = $('#campaigns-table tbody');
  if (!campaigns.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">No campaigns yet. Create one from “New Campaign”.</td></tr>'; return; }
  tb.innerHTML = campaigns.map((c) => {
    const s = statsFor(c), st = statusInfo(c);
    return `<tr data-open="${c.id}">
      <td><b>${esc(c.name)}</b><div class="muted" style="font-size:12px">${esc(greetingName(c.greeting_id))}</div></td>
      <td><span class="pill ${st.cls}">${esc(st.label)}</span></td>
      <td class="num">${c.numbers_count || 0}</td>
      <td class="num" style="color:var(--ok)">${s.completed}</td>
      <td class="num" style="color:var(--fail)">${s.failed}</td>
      <td>${fmt(c.created_at)}</td>
      <td class="chev">›</td>
    </tr>`;
  }).join('');
}

// ── Campaign detail ───────────────────────────────────────────
function openCampaign(id) { selectedId = id; switchView('campaign'); renderDetail(); }
function renderDetail() {
  const c = campaigns.find((x) => x.id === selectedId);
  if (!c) { switchView('campaigns'); return; }
  const s = statsFor(c), st = statusInfo(c);
  $('#camp-name').textContent = c.name;
  const pill = $('#camp-status'); pill.className = 'pill ' + st.cls; pill.textContent = st.label;

  const kv = [
    ['Exotel campaign ID', c.exotel_campaign_id ? `<span class="mono">${esc(c.exotel_campaign_id)}</span>` : '-'],
    ['List ID', c.exotel_list_id ? `<span class="mono">${esc(c.exotel_list_id)}</span>` : '-'],
    ['Greeting', esc(greetingName(c.greeting_id))],
    ['Caller ID', esc(c.caller_id || '-')],
    ['Start time', c.send_at ? fmt(c.send_at) : fmt(c.created_at) + ' (immediate)'],
    ['End time', c.end_at ? fmt(c.end_at) : '-'],
    ['Total numbers', `<span class="num">${c.numbers_count || 0}</span>`],
    ['Created', fmt(c.created_at)],
  ];
  if (c.last_error) kv.push(['Last error', `<span style="color:var(--fail)">${esc(c.last_error)}</span>`, true]);
  $('#camp-kv').innerHTML = kv.map(([k, v, full]) => `<div class="row${full ? ' full' : ''}"><span class="k">${k}</span><span class="val">${v}</span></div>`).join('');

  // Stats donut - fold "awaiting result" numbers into In Progress so the
  // total reflects every targeted number, like the Exotel dashboard.
  const display = { ...s.counts, pending: s.counts.pending + s.awaiting };
  $('#camp-donut').innerHTML = donutBlock(display, s.target, 'Total Numbers', true);

  const rows = calls.filter((x) => String(x.exotel_campaign_id) === String(c.exotel_campaign_id))
    .sort((a, b) => ((a.received_at || '') < (b.received_at || '') ? 1 : -1));
  $('#camp-calls-count').textContent = rows.length ? `${rows.length} call${rows.length === 1 ? '' : 's'}` : '';
  $('#camp-calls tbody').innerHTML = rows.length ? rows.map((x) => callRow(x, { started: true })).join('')
    : '<tr><td colspan="6" class="empty">No call results yet for this campaign.</td></tr>';

  const btn = $('#camp-rerun'); const n = s.failedNums.size;
  btn.disabled = !n; btn.dataset.rerun = c.id;
  btn.innerHTML = icon('refresh') + `Re-run failed${n ? ` (${n})` : ''}`;
}

// ── Greetings ─────────────────────────────────────────────────
function renderLibrary() {
  const lib = $('#library'); const sel = $('#c-greeting'); sel.innerHTML = '';
  $('#side-greeting').textContent = (greetings.find((g) => g.is_active)?.name) || 'none selected';
  if (!greetings.length) { lib.innerHTML = '<div class="empty">No greetings yet - upload one above.</div>'; return; }
  lib.innerHTML = greetings.map((g) => `
    <div class="item ${g.is_active ? 'active' : ''}">
      <div class="meta"><b>${esc(g.name)} ${g.is_active ? '<span class="pill completed">active default</span>' : ''}</b>
      <small>${g.duration_sec ? Math.round(g.duration_sec) + 's · ' : ''}${Math.round((g.size_bytes || 0) / 1024)} KB</small></div>
      <audio controls preload="none" src="${g.file_name ? '/audio/' + esc(g.file_name) : esc(g.url)}"></audio>
      <button class="btn ghost sm" data-select="${g.id}">${g.is_active ? '✓ Default' : 'Set default'}</button>
      <button class="btn danger sm" data-del="${g.id}">Delete</button>`).join('');
  for (const g of greetings) { const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; sel.appendChild(o); }
}

// ── Render all ────────────────────────────────────────────────
function renderEverything() {
  renderTiles(); renderDonut(); renderBars(); renderRecent();
  renderCampaignsList(); renderLibrary();
  if (selectedId && !$('#view-campaign').classList.contains('hidden')) renderDetail();
  $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
}
async function loadAll() {
  try { [greetings, campaigns, calls] = await Promise.all([api.get('/api/greetings'), api.get('/api/campaigns'), api.get('/api/calls')]); }
  catch (e) { toast(e.message, 'err'); }
  renderEverything();
}
async function refreshLive() {
  try { [campaigns, calls] = await Promise.all([api.get('/api/campaigns'), api.get('/api/calls')]); renderEverything(); } catch {}
}

// ── View switching ────────────────────────────────────────────
const NAV = [
  { view: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { view: 'new', label: 'New Campaign', icon: 'plus' },
  { view: 'campaigns', label: 'Campaigns', icon: 'broadcast' },
  { view: 'greetings', label: 'MP3 Library', icon: 'music' },
];
const VIEW_META = {
  dashboard: ['Dashboard', 'Overview of your voice campaigns.'],
  new: ['New Campaign', 'Upload numbers, pick a greeting, and launch.'],
  campaigns: ['Campaigns', 'Select a campaign to see its stats and call details.'],
  campaign: ['Campaign', 'Per-campaign stats and individual call details.'],
  greetings: ['MP3 Library', 'Manage the greetings Exotel can play.'],
};
function switchView(v) {
  const navFor = v === 'campaign' ? 'campaigns' : v;
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === navFor));
  $$('.view').forEach((s) => s.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  $('#view-title').textContent = VIEW_META[v][0];
  $('#view-sub').textContent = VIEW_META[v][1];
}

// ── Events ────────────────────────────────────────────────────
$('#nav').innerHTML = NAV.map((n) => `<a class="nav-link${n.view === 'dashboard' ? ' active' : ''}" data-view="${n.view}">${icon(n.icon)} ${n.label}</a>`).join('');
$$('.nav-link').forEach((a) => a.addEventListener('click', () => switchView(a.dataset.view)));
$$('[data-ic]').forEach((b) => b.insertAdjacentHTML('afterbegin', icon(b.dataset.ic)));
$('#refresh-all').addEventListener('click', loadAll);
$('#camp-back').addEventListener('click', () => switchView('campaigns'));

$('#campaigns-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-open]'); if (tr) openCampaign(tr.dataset.open);
});

$('#camp-rerun').addEventListener('click', (e) => doRerun(e.currentTarget.dataset.rerun, e.currentTarget));

async function doRerun(id, btn) {
  if (!id) return;
  if (!confirm('Launch a new campaign dialing only the failed numbers from this campaign?')) return;
  btn.disabled = true; btn.innerHTML = icon('refresh') + 'Launching…';
  try {
    const r = await api.post(`/api/campaigns/${id}/rerun-failed`, {});
    toast(`Retry launched: ${r.retried_count} number(s) re-dialed.`, 'ok');
    await loadAll();
  } catch (e) { toast('Retry failed: ' + e.message, 'err'); await loadAll(); }
}

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
      numbers: $('#c-numbers').value, send_at: toIST($('#c-sendat').value), end_at: toIST($('#c-endat').value), retries: $('#c-retries').value,
    });
    st.className = 'status ok'; st.textContent = '✓ Created';
    $('#campaign-form').reset(); await loadAll(); switchView('campaigns'); toast('Campaign created.', 'ok');
  } catch (e) { st.className = 'status err'; st.textContent = '✗ ' + e.message; toast(e.message, 'err'); }
});

// ── Init ──────────────────────────────────────────────────────
$('#side-base').textContent = location.host;
loadAll();
setInterval(refreshLive, 15000);
