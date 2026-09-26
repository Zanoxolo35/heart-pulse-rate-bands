// VitalCare dashboard - plain JavaScript, no build step.
// Talks to the Express API and listens to /api/stream for live updates.

const API = '/api';
const state = {
  lang: localStorage.getItem('lang') || 'en',
  patients: [],
  alerts: [],
  selectedId: null,
  selected: null,        // full patient record (with contacts)
  readings: [],          // chart data for the selected patient
};
const MAX_POINTS = 60;

// ---------- Small helpers ----------
const $ = (sel) => document.querySelector(sel);
const t = () => window.I18N[state.lang];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// SQLite gives "2026-09-26 10:00:00" (UTC, no zone); readings come as ISO. Handle both.
const toDate = (s) => new Date(s && !s.includes('T') ? s.replace(' ', 'T') + 'Z' : s);
const clock = (s) => toDate(s).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const minutesAgo = (s) => Math.max(0, Math.floor((Date.now() - toDate(s)) / 60000));

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || (err.errors || []).join(' ') || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- Language ----------
function applyLanguage() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t()[el.dataset.i18n]));
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lang === state.lang));
  $('#connText').textContent = $('#conn').classList.contains('down') ? t().reconnecting : t().live;
  renderAll();
}
document.querySelectorAll('.lang button').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.lang = btn.dataset.lang;
    localStorage.setItem('lang', state.lang);
    applyLanguage();
  }));

// ---------- Patient list ----------
function renderPatients() {
  const list = $('#patientList');
  list.innerHTML = state.patients.map((p) => {
    const status = p.last_status || 'NO_SIGNAL';
    return `<li>
      <button type="button" class="patient-row s-${status}" data-id="${p.id}" aria-current="${p.id === state.selectedId}">
        <span>
          <span class="p-name">${esc(p.full_name)}${p.open_alerts ? '<span class="p-flag" aria-label="open alert">!</span>' : ''}</span>
          <span class="p-meta">${esc(p.region || '')}, ${esc(t().tiers[p.tier].name)}</span><br>
          <span class="badge ${status}">${t().status[status]}</span>
        </span>
        <span class="p-bpm">${p.last_bpm ?? '--'}<small>${t().bpm}</small></span>
      </button></li>`;
  }).join('');
  list.querySelectorAll('.patient-row').forEach((b) => b.addEventListener('click', async () => {
    await selectPatient(Number(b.dataset.id));
    if (window.innerWidth <= 720) $('#monitor').scrollIntoView({ behavior: 'smooth' });   // phones: jump to the chart
  }));
}

// ---------- Monitor (selected patient) ----------
async function selectPatient(id) {
  state.selectedId = id;
  const [patient, readings] = await Promise.all([api(`/patients/${id}`), api(`/patients/${id}/readings?limit=${MAX_POINTS}`)]);
  state.selected = patient;
  state.readings = readings;
  renderPatients();
  renderMonitor();
}

function renderMonitor() {
  const box = $('#monitor');
  const p = state.selected;
  if (!p) {
    box.innerHTML = `<p class="empty">${t().choosePatient}</p>`;
    return;
  }
  const last = state.readings[state.readings.length - 1];
  const status = last?.status || 'NO_SIGNAL';
  const focusedTier = document.activeElement?.dataset?.tier;   // keep keyboard focus across live redraws

  box.innerHTML = `
    <div class="m-head">
      <div>
        <h2 class="m-name">${esc(p.full_name)}</h2>
        <p class="m-sub">${t().age} ${esc(p.age)} &middot; ${esc(p.address || '')}, ${esc(p.region || '')}</p>
      </div>
      <span class="badge ${status}">${t().status[status]}</span>
    </div>

    <div class="strip">
      <div class="readout ${status}">
        <span class="readout-num">${last?.pulse_bpm ?? '--'}</span><span class="readout-unit">${t().bpm}</span>
      </div>
      <canvas id="chart" role="img" aria-label="Pulse chart, last ${MAX_POINTS} readings"></canvas>
    </div>
    <div class="strip-foot">
      <span>${last ? `${t().lastReading}: ${clock(last.recorded_at)}` : t().noReadings}</span>
      <span>${t().normalRange}: ${p.pulse_low}–${p.pulse_high} ${t().bpm}</span>
    </div>

    <div class="m-grid">
      <div>
        <h3>${t().plan}</h3>
        <div class="plans" role="group" aria-label="${t().plan}">
          ${['MONITOR', 'ASSIST', 'CARE'].map((tier, i) => `
            <button type="button" class="plan" data-tier="${tier}" aria-pressed="${p.tier === tier}">
              <span class="lvl">${i + 1}</span><b>${t().tiers[tier].name}</b><span>${t().tiers[tier].blurb}</span>
            </button>`).join('')}
        </div>
      </div>
      <div>
        <h3>${t().contacts}</h3>
        <ul class="contacts">
          ${p.contacts.map((c) => `<li><a href="tel:${esc(c.phone)}">${esc(c.name)}</a>
            <small>${esc(c.relationship || c.contact_type)}, ${esc(c.phone)}</small></li>`).join('')}
        </ul>
      </div>
    </div>`;

  box.querySelectorAll('.plan').forEach((b) => b.addEventListener('click', () => changeTier(b.dataset.tier)));
  if (focusedTier) box.querySelector(`.plan[data-tier="${focusedTier}"]`)?.focus();
  drawChart();
}

async function changeTier(tier) {
  if (state.selected.tier === tier) return;
  try {
    const updated = await api(`/patients/${state.selected.id}`, { method: 'PATCH', body: { tier } });
    state.selected = { ...state.selected, ...updated };
    toast(t().planChanged(t().tiers[tier].name));
    await loadPatients();
    renderMonitor();
  } catch (e) {
    toast(`${t().errorSave} (${e.message})`);
  }
}

// ---------- ECG-paper chart (plain canvas, no library) ----------
function drawChart() {
  const canvas = $('#chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const MIN = 30, MAX = 160;                        // BPM range shown
  const y = (bpm) => h - ((bpm - MIN) / (MAX - MIN)) * h;

  // Graph paper: small squares every 8px, bold every 40px
  for (let step of [8, 40]) {
    ctx.strokeStyle = step === 8 ? color('--ecg-fine') : color('--ecg-bold');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += step) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
    for (let yy = 0; yy <= h; yy += step) { ctx.moveTo(0, yy + .5); ctx.lineTo(w, yy + .5); }
    ctx.stroke();
  }

  // Patient's normal range as dashed lines with labels
  const p = state.selected;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.font = '12px "Atkinson Hyperlegible", sans-serif';
  [[p.pulse_high, color('--high')], [p.pulse_low, color('--low')]].forEach(([v, c]) => {
    ctx.strokeStyle = c; ctx.fillStyle = c;
    ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(w, y(v)); ctx.stroke();
    ctx.fillText(String(v), 6, y(v) - 4);
  });
  ctx.setLineDash([]);

  // The pulse trace (gaps where there was no signal)
  const pts = state.readings;
  if (!pts.length) return;
  const stepX = w / (MAX_POINTS - 1);
  const offset = MAX_POINTS - pts.length;           // newest point always at the right edge
  ctx.strokeStyle = color('--trace');
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let penDown = false;
  pts.forEach((r, i) => {
    if (r.pulse_bpm == null) { penDown = false; return; }
    const px = (i + offset) * stepX, py = y(Math.min(MAX, Math.max(MIN, r.pulse_bpm)));
    penDown ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    penDown = true;
  });
  ctx.stroke();

  // Mark out-of-range readings
  pts.forEach((r, i) => {
    if (r.status !== 'HIGH' && r.status !== 'LOW') return;
    ctx.fillStyle = r.status === 'HIGH' ? color('--high') : color('--low');
    ctx.beginPath();
    ctx.arc((i + offset) * stepX, y(Math.min(MAX, Math.max(MIN, r.pulse_bpm))), 4, 0, Math.PI * 2);
    ctx.fill();
  });
}
window.addEventListener('resize', drawChart);

// ---------- Alert queue ----------
const STEPS = ['TRIGGERED', 'CONTACTED', 'TRANSPORT_DISPATCHED', 'RESOLVED'];

function stepsFor(tier) {
  // Vital Monitor has no transport step
  return tier === 'MONITOR' ? STEPS.filter((s) => s !== 'TRANSPORT_DISPATCHED') : STEPS;
}

function renderAlerts() {
  const list = $('#alertList');
  const count = $('#alertCount');
  count.hidden = state.alerts.length === 0;
  count.textContent = `${state.alerts.length} ${t().alerts.toLowerCase()}`;

  if (!state.alerts.length) {
    list.innerHTML = `<li class="empty">${t().noAlerts}</li>`;
    return;
  }

  list.innerHTML = state.alerts.map((a) => {
    const steps = stepsFor(a.tier);
    const here = steps.indexOf(a.status);
    const next = steps[here + 1];
    const showDriver = a.tier !== 'MONITOR';
    const showCaregiver = a.tier === 'CARE';
    return `<li class="alert ${a.trigger_status}">
      <div class="alert-top">
        <button type="button" class="alert-name" data-patient="${a.patient_id}">${esc(a.patient_name)}</button>
        <span class="alert-bpm">${a.trigger_bpm} <small>${t().bpm}</small></span>
      </div>
      <p class="alert-meta">
        <span class="badge ${a.trigger_status}">${t().status[a.trigger_status]}</span>
        ${a.is_critical ? `<span class="crit">${t().critical}</span>` : ''}
        &middot; ${esc(t().tiers[a.tier].name)} &middot; ${t().ago(minutesAgo(a.created_at))}
      </p>
      <ol class="steps">
        ${steps.map((s, i) => `<li class="${i < here ? 'done' : i === here ? 'now' : ''}">${t().steps[s]}</li>`).join('')}
      </ol>
      <div class="people">
        ${showDriver ? `<span>${t().driver}: ${a.driver_name ? `<a href="tel:${esc(a.driver_phone)}">${esc(a.driver_name)}</a>` : `<span class="none">${t().notAssigned}</span>`}</span>` : ''}
        ${showCaregiver ? `<span>${t().caregiver}: ${a.caregiver_name ? `<a href="tel:${esc(a.caregiver_phone)}">${esc(a.caregiver_name)}</a>` : `<span class="none">${t().notAssigned}</span>`}</span>` : ''}
        ${a.follow_up_due_at ? `<span>${t().followUp} ${toDate(a.follow_up_due_at).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>` : ''}
      </div>
      <div class="actions">
        ${next ? `<button type="button" class="btn primary" data-alert="${a.id}" data-status="${next}">${t().next[next]}</button>` : ''}
        ${next && next !== 'RESOLVED' ? `<button type="button" class="btn" data-alert="${a.id}" data-status="RESOLVED">${t().resolve}</button>` : ''}
      </div>
    </li>`;
  }).join('');

  list.querySelectorAll('[data-alert]').forEach((b) => b.addEventListener('click', () => moveAlert(b, Number(b.dataset.alert), b.dataset.status)));
  list.querySelectorAll('[data-patient]').forEach((b) => b.addEventListener('click', () => selectPatient(Number(b.dataset.patient))));
}

async function moveAlert(button, id, status) {
  button.disabled = true;
  try {
    await api(`/alerts/${id}`, { method: 'PATCH', body: { status } });
    await Promise.all([loadAlerts(), loadPatients()]);
  } catch (e) {
    toast(`${t().errorSave} (${e.message})`);
    button.disabled = false;
  }
}

// ---------- Loading + live updates ----------
async function loadPatients() { state.patients = await api('/patients'); renderPatients(); }
async function loadAlerts() { state.alerts = await api('/alerts?status=open'); renderAlerts(); }

function renderAll() {
  renderPatients();
  renderMonitor();
  renderAlerts();
}

function connectStream() {
  const es = new EventSource(`${API}/stream`);
  const setConn = (ok) => {
    $('#conn').classList.toggle('down', !ok);
    $('#connText').textContent = ok ? t().live : t().reconnecting;
  };

  es.addEventListener('hello', () => setConn(true));
  es.onerror = () => setConn(false);   // EventSource retries by itself

  // New reading: update that patient's row, and the chart if she's selected
  es.addEventListener('reading', (e) => {
    const r = JSON.parse(e.data);
    const p = state.patients.find((x) => x.id === r.patient_id);
    if (p) Object.assign(p, { last_bpm: r.pulse_bpm, last_status: r.status, last_reading_at: r.recorded_at });
    renderPatients();
    if (r.patient_id === state.selectedId) {
      state.readings.push(r);
      if (state.readings.length > MAX_POINTS) state.readings.shift();
      renderMonitor();
    }
  });

  es.addEventListener('alert', () => { loadAlerts(); loadPatients(); });
  es.addEventListener('patient', () => loadPatients());
}

// Refresh "x min ago" labels every minute
setInterval(renderAlerts, 60000);

// ---------- Start ----------
(async function start() {
  try {
    await Promise.all([loadPatients(), loadAlerts()]);
    applyLanguage();
    if (state.patients.length) await selectPatient(state.patients[0].id);
    connectStream();
  } catch (e) {
    $('#monitor').innerHTML = `<p class="empty">Can't reach the server at ${location.origin}. Start it with <code>npm start</code> in the server folder, then refresh.</p>`;
  }
})();
