const $ = (s) => document.querySelector(s);
const api = {
  async get(u) { const r = await fetch(u); if (!r.ok) throw await err(r); return r.json(); },
  async post(u, body, isForm) {
    const opt = { method: 'POST' };
    if (isForm) opt.body = body;
    else { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
    const r = await fetch(u, opt); if (!r.ok) throw await err(r); return r.json();
  },
  async del(u) { const r = await fetch(u, { method: 'DELETE' }); if (!r.ok) throw await err(r); },
};
async function err(r) { try { const j = await r.json(); return new Error(j.detail || j.error || r.statusText); } catch { return new Error(r.statusText); } }

// IST datetime-local ("2026-07-20T09:00") → ISO with +05:30 offset.
function toIST(v) { return v ? `${v}:00+05:30` : null; }
function fmt(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }

// ── Library ───────────────────────────────────────────────────────────
async function loadLibrary() {
  const rows = await api.get('/api/greetings');
  const lib = $('#library');
  const sel = $('#c-greeting');
  sel.innerHTML = '';
  if (!rows.length) { lib.innerHTML = '<div class="empty">No greetings yet — upload one above.</div>'; return; }
  lib.innerHTML = '';
  for (const g of rows) {
    const el = document.createElement('div');
    el.className = 'item' + (g.is_active ? ' active' : '');
    el.innerHTML = `
      <div class="meta">
        <b>${escape(g.name)} ${g.is_active ? '<span class="pill on">active default</span>' : ''}</b>
        <small>${g.duration_sec ? Math.round(g.duration_sec) + 's · ' : ''}${Math.round((g.size_bytes||0)/1024)} KB</small>
      </div>
      <audio controls preload="none" src="${g.url}"></audio>
      <button class="ghost" data-select="${g.id}">${g.is_active ? '✓ Default' : 'Set default'}</button>
      <button class="danger" data-del="${g.id}">Delete</button>`;
    lib.appendChild(el);

    const opt = document.createElement('option');
    opt.value = g.id; opt.textContent = g.name; sel.appendChild(opt);
  }
}

// ── Campaigns ─────────────────────────────────────────────────────────
async function loadCampaigns() {
  const rows = await api.get('/api/campaigns');
  const box = $('#campaigns');
  if (!rows.length) { box.innerHTML = '<div class="empty">No campaigns yet.</div>'; return; }
  box.innerHTML = '';
  for (const c of rows) {
    const el = document.createElement('div');
    el.className = 'item';
    const pill = c.status === 'failed' ? 'failed' : c.status === 'scheduled' ? 'scheduled' : '';
    el.innerHTML = `
      <div class="meta">
        <b>${escape(c.name)} <span class="pill ${pill}">${c.status}</span></b>
        <small>${c.numbers_count || 0} numbers · ${c.send_at ? 'send ' + fmt(c.send_at) : 'immediate'}
          ${c.exotel_campaign_id ? '· Exotel #' + c.exotel_campaign_id : ''}
          ${c.last_error ? '· ⚠ ' + escape(c.last_error) : ''}</small>
      </div>`;
    box.appendChild(el);
  }
}

// ── Calls ─────────────────────────────────────────────────────────────
async function loadCalls() {
  const rows = await api.get('/api/calls');
  const tb = $('#calls tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No call data received yet.</td></tr>'; return; }
  tb.innerHTML = rows.map((c) => `
    <tr>
      <td>${fmt(c.received_at)}</td>
      <td>${escape(c.to_number || '—')}</td>
      <td>${escape(c.status || '—')}</td>
      <td>${c.duration_sec ?? '—'}</td>
      <td>${escape(c.exotel_campaign_id || '—')}</td>
      <td>${c.recording_url ? `<a href="${c.recording_url}" target="_blank">▶</a>` : '—'}</td>
    </tr>`).join('');
}

function escape(s) { return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m])); }

// ── Events ────────────────────────────────────────────────────────────
$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#up-file').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('name', $('#up-name').value || file.name);
  try { await api.post('/api/greetings', fd, true); $('#upload-form').reset(); await loadLibrary(); }
  catch (e) { alert('Upload failed: ' + e.message); }
});

$('#library').addEventListener('click', async (e) => {
  const sel = e.target.getAttribute('data-select');
  const del = e.target.getAttribute('data-del');
  try {
    if (sel) { await api.post(`/api/greetings/${sel}/select`, {}); await loadLibrary(); }
    if (del && confirm('Delete this greeting?')) { await api.del(`/api/greetings/${del}`); await loadLibrary(); }
  } catch (e) { alert(e.message); }
});

$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('#c-status'); st.className = 'status'; st.textContent = 'Creating…';
  try {
    await api.post('/api/campaigns', {
      name: $('#c-name').value,
      caller_id: $('#c-caller').value,
      greeting_id: $('#c-greeting').value,
      numbers: $('#c-numbers').value,
      send_at: toIST($('#c-sendat').value),
      end_at: toIST($('#c-endat').value),
      retries: $('#c-retries').value,
    });
    st.className = 'status ok'; st.textContent = '✓ Created';
    $('#campaign-form').reset();
    await loadCampaigns();
  } catch (e) { st.className = 'status err'; st.textContent = '✗ ' + e.message; }
});

$('#refresh-calls').addEventListener('click', loadCalls);

// ── Init ──────────────────────────────────────────────────────────────
loadLibrary(); loadCampaigns(); loadCalls();
setInterval(loadCalls, 15000);
setInterval(loadCampaigns, 30000);
