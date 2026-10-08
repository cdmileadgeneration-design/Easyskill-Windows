/* Activity Monitor - dashboard frontend.
   Timeline supports zoom (wheel), pan (drag / shift-wheel), click-to-select,
   double-click-to-zoom-to-block and per-app focus. Data auto-refreshes while
   the tab is visible and the session survives a page reload. */
let token = null;
const API = window.location.origin + '/api';
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a','#ff5722','#607d8b','#795548','#cddc39','#009688','#673ab7'];
const BROWSER_COLORS = { chrome: '#3498db', edge: '#2ecc71', firefox: '#e67e22' };
const FILE_COLORS = { create: '#2ecc71', delete: '#e74c3c', modify: '#f39c12', open: '#3498db', access: '#9b59b6' };
const USB_COLORS = { connect: '#2ecc71', disconnect: '#e74c3c' };
const SYSTEM_COLORS = { idle: '#f39c12', active: '#2ecc71', shutdown: '#e74c3c', start: '#3498db', other: '#9b59b6' };
const appColors = {};

let currentView = 'timeline';
let currentMachine = '';
let machines = [];

const MIN_SPAN = 30 * 1000;            // deepest zoom: 30 seconds across the lane
const REFRESH_MS = 20000;              // live auto-refresh cadence
const TICK_STEPS = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
  3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];

const view = { start: 0, end: 0, dayStart: 0, dayEnd: 0 };
const data = { apps: [], files: [], sites: [], usb: [], sys: [], shots: [], summary: null };
let focusApp = '';
let selectedId = null;
let loadSeq = 0;
let placed = [];   // { el, start, end } - rebuilt on data change, repositioned on zoom

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function baseName(p) {
  const s = String(p || '');
  return s.split('\\').pop() || s;
}

function getAppColor(name) {
  if (!appColors[name]) appColors[name] = COLORS[Object.keys(appColors).length % COLORS.length];
  return appColors[name];
}

function localDateStr(d) {
  const dt = d || new Date();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function parseDateStr(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function localDayRange(dateStr) {
  const day = parseDateStr(dateStr);
  return {
    startDate: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).toISOString(),
    endDate: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999).toISOString()
  };
}

function formatDur(sec) {
  if (!sec) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showNotice(message, isError) {
  const el = document.getElementById('timelineNotice');
  if (!message) { el.classList.remove('visible', 'error'); el.textContent = ''; return; }
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
  el.classList.add('visible');
}

function showTip(html, e) {
  const tt = document.getElementById('tooltip');
  tt.innerHTML = html;
  tt.style.display = 'block';
  moveTip(e);
}

function moveTip(e) {
  const tt = document.getElementById('tooltip');
  tt.style.left = (e.clientX + 15) + 'px';
  tt.style.top = (e.clientY - 10) + 'px';
}

function hideTip() {
  document.getElementById('tooltip').style.display = 'none';
}

function tip(el, htmlFn) {
  el.addEventListener('mouseenter', (e) => showTip(htmlFn(), e));
  el.addEventListener('mousemove', moveTip);
  el.addEventListener('mouseleave', hideTip);
}

function systemEventStyle(entry) {
  switch (entry.event_type) {
    case 'idle_start': return { color: SYSTEM_COLORS.idle, label: 'Idle Started' };
    case 'idle_end': return { color: SYSTEM_COLORS.active, label: 'Active Again' };
    case 'system_start': return { color: SYSTEM_COLORS.start, label: 'Agent Started' };
    case 'system_shutdown': return { color: SYSTEM_COLORS.shutdown, label: 'Agent Stopped' };
    case 'unexpected_shutdown': return { color: SYSTEM_COLORS.shutdown, label: 'Unexpected Shutdown' };
    default: return { color: SYSTEM_COLORS.other, label: entry.event_type || 'Event' };
  }
}

// ---------------------------------------------------------------------------
// API + session
// ---------------------------------------------------------------------------
async function api(endpoint, params = {}) {
  const url = new URL(`${API}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.append(k, v); });
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (r.status === 401) { logout(); const err = new Error('Session expired'); err.sessionExpired = true; throw err; }
  let parsed = null;
  try { parsed = await r.json(); } catch (e) { parsed = null; }
  if (!r.ok) throw new Error((parsed && parsed.error) || `HTTP ${r.status}`);
  return parsed;
}

function saveSession(user) {
  try { localStorage.setItem('wm.session', JSON.stringify({ token, user })); } catch (e) {}
}

function clearSession() {
  try { localStorage.removeItem('wm.session'); } catch (e) {}
}

function enterDashboard(user) {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('dashboardPage').classList.add('active');
  document.getElementById('currentUser').textContent = user.username;
  const dateInput = document.getElementById('timelineDate');
  if (!dateInput.value) dateInput.value = localDateStr();
}

async function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wm.session') || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.token) return;
  token = saved.token;
  try {
    machines = await api('/machines');   // validates the token (401 -> logout)
    enterDashboard(saved.user || { username: '' });
    fillMachineSelect();
    updateMachineStatus();
    await loadTimeline();
  } catch (e) { /* logged out or offline - stay on the login page */ }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
    });
    const d = await r.json();
    if (d.token) {
      token = d.token;
      saveSession(d.user);
      enterDashboard(d.user);
      document.getElementById('timelineDate').value = localDateStr();
      await loadMachines();
      loadTimeline();
    } else { alert(d.error || 'Invalid credentials'); }
  } catch (e2) { alert('Connection error'); }
});

function logout() {
  token = null;
  clearSession();
  document.getElementById('dashboardPage').classList.remove('active');
  document.getElementById('loginPage').style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------
function fillMachineSelect() {
  const select = document.getElementById('machineSelect');
  const prev = currentMachine;
  select.innerHTML = '<option value="">All Machines</option>';
  machines.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.machine_name;
    const seen = m.last_seen ? new Date(m.last_seen) : null;
    const online = seen && !isNaN(seen) && (Date.now() - seen.getTime()) < 300000;
    opt.textContent = `${m.machine_name}${m.ip ? ' (' + m.ip + ')' : ''}${online ? ' ●' : ''}`;
    select.appendChild(opt);
  });
  select.value = machines.some(m => m.machine_name === prev) ? prev : '';
  currentMachine = select.value;
}

async function loadMachines() {
  try {
    machines = await api('/machines');
    fillMachineSelect();
    updateMachineStatus();
  } catch (e) {
    console.error('Failed to load machines:', e);
  }
}

function updateMachineStatus() {
  const status = document.getElementById('machineStatus');
  if (!currentMachine) { status.className = 'machine-status online'; status.title = 'Showing all machines'; return; }
  const machine = machines.find(m => m.machine_name === currentMachine);
  if (machine) {
    const lastSeen = new Date(machine.last_seen);
    const isOnline = !isNaN(lastSeen) && (Date.now() - lastSeen.getTime()) < 300000;
    status.className = `machine-status ${isOnline ? 'online' : 'offline'}`;
    status.title = `${currentMachine}: last seen ${isNaN(lastSeen) ? 'never' : lastSeen.toLocaleString()}`;
  }
}

function lastSeenNote() {
  if (!currentMachine) return '';
  const m = machines.find(x => x.machine_name === currentMachine);
  if (!m) return '';
  const t = new Date(m.last_seen);
  if (isNaN(t)) return ` The agent on ${currentMachine} has never reported to the server.`;
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  return ` ${currentMachine} last reported ${t.toLocaleString()} (${mins < 5 ? 'online' : mins + ' minutes ago'}).`;
}

function onMachineChange() {
  currentMachine = document.getElementById('machineSelect').value;
  updateMachineStatus();
  if (currentView === 'timeline') loadTimeline();
  if (currentView === 'screenshots') loadScreenshots();
}

// ---------------------------------------------------------------------------
// Views / tabs
// ---------------------------------------------------------------------------
function switchView(view) {
  currentView = view;
  document.getElementById('timelineView').style.display = view === 'timeline' ? 'flex' : 'none';
  document.getElementById('ssView').classList.toggle('active', view === 'screenshots');
  document.getElementById('detailPanel').style.display = view === 'timeline' ? 'block' : 'none';
  document.getElementById('appLegend').style.display = view === 'timeline' ? 'flex' : 'none';
  document.getElementById('summaryCards').style.display = view === 'timeline' ? 'flex' : 'none';
  document.getElementById('tlHint').style.display = view === 'timeline' ? 'block' : 'none';

  const tabTl = document.getElementById('tabTimeline');
  const tabSs = document.getElementById('tabScreenshots');
  if (view === 'timeline') {
    tabTl.style.background = '#4a90d9'; tabTl.style.borderColor = '#4a90d9'; tabTl.style.color = '#fff';
    tabSs.style.background = '#333'; tabSs.style.borderColor = '#444'; tabSs.style.color = '#ccc';
  } else {
    tabSs.style.background = '#4a90d9'; tabSs.style.borderColor = '#4a90d9'; tabSs.style.color = '#fff';
    tabTl.style.background = '#333'; tabTl.style.borderColor = '#444'; tabTl.style.color = '#ccc';
  }

  if (view === 'timeline') loadTimeline();
  if (view === 'screenshots') loadScreenshots();
}

function switchDetailTab(tab, el) {
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById(`detail-${tab}`).classList.add('active');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function fetchList(endpoint, params) {
  try {
    const out = await api(endpoint, params);
    if (Array.isArray(out)) return out;
    showNotice(`Unexpected response from ${endpoint}`, true);
    return [];
  } catch (e) {
    if (e && e.sessionExpired) throw e;
    console.error(`loadTimeline ${endpoint} failed:`, e);
    showNotice(`Failed to load ${endpoint.replace('/stats/', '')}: ${e.message}`, true);
    return [];
  }
}

async function fetchSummary(params) {
  try {
    const out = await api('/dashboard/summary', params);
    return out && typeof out === 'object' ? out : null;
  } catch (e) {
    if (e && e.sessionExpired) throw e;
    console.error('loadTimeline summary failed:', e);
    showNotice(`Failed to load summary: ${e.message}`, true);
    return null;
  }
}

async function loadTimeline(opts = {}) {
  const dateInput = document.getElementById('timelineDate');
  if (!dateInput.value) dateInput.value = localDateStr();
  const date = dateInput.value;
  const day = localDayRange(date);
  const params = { startDate: day.startDate, endDate: day.endDate, machine_name: currentMachine };
  const scope = currentMachine ? ` on ${currentMachine}` : '';
  const seq = ++loadSeq;

  if (!opts.silent) showNotice('');

  let apps = [], files = [], sites = [], usb = [], sys = [], shots = [], summary = null;
  try {
    [apps, files, sites, usb, sys, shots, summary] = await Promise.all([
      fetchList('/stats/applications/raw', params),
      fetchList('/stats/files', params),
      fetchList('/stats/websites/raw', params),
      fetchList('/stats/usb/raw', params),
      fetchList('/stats/events/raw', params),
      fetchList('/screenshots', { ...params, limit: 2000 }),
      fetchSummary({ date, startDate: day.startDate, endDate: day.endDate, machine_name: currentMachine })
    ]);
  } catch (e) {
    return; // session expired - api() already logged the user out
  }
  if (seq !== loadSeq) return; // a newer request superseded this one

  data.apps = apps; data.files = files; data.sites = sites;
  data.usb = usb; data.sys = sys; data.shots = shots; data.summary = summary;

  const dayStart = new Date(day.startDate).getTime();
  const dayEnd = new Date(day.endDate).getTime();
  const dateChanged = view.dayStart !== dayStart;
  view.dayStart = dayStart;
  view.dayEnd = dayEnd;
  if (dateChanged || !view.start) { view.start = dayStart; view.end = dayEnd; }

  render();

  const total = apps.length + files.length + sites.length + usb.length;
  if (total === 0 && !document.getElementById('timelineNotice').classList.contains('visible')) {
    showNotice(`No application, document or website activity recorded${scope} on ${date}.${lastSeenNote()} Make sure the agent on that machine is running and sending events.`, false);
  }
}

function refreshNow() {
  loadMachines();
  if (currentView === 'timeline') loadTimeline({ silent: true });
  else loadScreenshots();
}

// ---------------------------------------------------------------------------
// Rendering - structure (lanes + elements) vs view (positions)
// ---------------------------------------------------------------------------
function render() {
  renderLegend();
  renderSummary();
  renderTables();
  buildLanes();
  applyView();
}

function pct(t) {
  const span = view.end - view.start;
  return span > 0 ? ((t - view.start) / span) * 100 : 0;
}

function computeTicks() {
  const span = view.end - view.start;
  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const s of TICK_STEPS) { if (span / s <= 18) { step = s; break; } }
  const ticks = [];
  for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) ticks.push(t);
  return { step, ticks };
}

function tickLabel(t, step) {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return step >= 6 * 3600e3 ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}

function applyView() {
  if (!view.start) return;
  const { step, ticks } = computeTicks();

  const hourRow = document.getElementById('hourRow');
  const segments = [];
  let cursor = view.start;
  for (const t of ticks) { if (t > cursor) { segments.push([cursor, t]); cursor = t; } }
  if (cursor < view.end) segments.push([cursor, view.end]);
  hourRow.innerHTML = segments.map(([a, b], i) => {
    const label = b < view.end || i < segments.length - 1 ? tickLabel(b, step) : tickLabel(a, step);
    return `<div class="timeline-hour" style="width:${Math.max(pct(b) - pct(a), 0)}%">${label}</div>`;
  }).join('');

  const lineHtml = ticks.map(t => `<div class="lane-grid-line" style="position:absolute;left:${pct(t)}%;top:0;bottom:0;width:0;"></div>`).join('');
  document.querySelectorAll('.lane-grid').forEach(g => { g.innerHTML = lineHtml; });

  for (const item of placed) {
    const l = pct(item.start);
    const r = pct(item.end);
    if (r < -1 || l > 101) { item.el.style.display = 'none'; continue; }
    item.el.style.display = '';
    const left = Math.max(0, Math.min(100, l));
    item.el.style.left = left + '%';
    if (item.noWidth) continue;              // markers keep their fixed size
    const right = Math.max(0, Math.min(100, r));
    item.el.style.width = Math.max(right - left, item.thin ? 0.4 : 0.15) + '%';
  }
}

let rafId = 0;
function scheduleApplyView() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; applyView(); });
}

function makeLane(name, extraClass) {
  const lane = document.createElement('div');
  lane.className = 'lane' + (extraClass ? ' ' + extraClass : '');
  const label = document.createElement('div');
  label.className = 'lane-label';
  label.textContent = name;
  const content = document.createElement('div');
  content.className = 'lane-content';
  const grid = document.createElement('div');
  grid.className = 'lane-grid';
  content.appendChild(grid);
  lane.appendChild(label);
  lane.appendChild(content);
  return { lane, label, content };
}

function addBlock(content, cls, start, end, color, opts = {}) {
  const el = document.createElement('div');
  el.className = cls;
  el.style.backgroundColor = color;
  content.appendChild(el);
  const item = { el, start, end, thin: cls !== 'block', noWidth: Boolean(opts.noWidth) };
  if (opts.id != null) item.id = opts.id;
  placed.push(item);
  return el;
}

function dimmed(entry) {
  return Boolean(focusApp) && entry.process_name !== focusApp;
}

function selectElement(id) {
  selectedId = id;
  applySelection();
  scrollDetailRowIntoView(id);
}

function applySelection() {
  for (const item of placed) {
    item.el.classList.toggle('selected', item.id != null && String(item.id) === String(selectedId));
  }
}

function scrollDetailRowIntoView(id) {
  const rows = document.querySelectorAll('#detailBody tr[data-id]');
  for (const row of rows) {
    if (row.dataset.id === String(id)) {
      if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      row.style.background = '#2f3b4a';
      setTimeout(() => { row.style.background = ''; }, 1200);
      break;
    }
  }
}

function buildLanes() {
  placed = [];
  const container = document.getElementById('lanes');
  container.innerHTML = '';

  if (focusApp) {
    const { lane, label, content } = makeLane('', 'focus-lane');
    label.textContent = focusApp;
    const clear = document.createElement('span');
    clear.className = 'clear-focus';
    clear.textContent = '✕';
    clear.title = 'Clear app focus';
    clear.addEventListener('click', (e) => { e.stopPropagation(); focusApp = ''; render(); });
    label.appendChild(clear);
    data.apps.filter(e => e.process_name === focusApp).forEach(entry => addAppBlock(content, entry));
    container.appendChild(lane);
  }

  const appLane = makeLane('Applications');
  data.apps.forEach(entry => addAppBlock(appLane.content, entry));
  container.appendChild(appLane.lane);

  const docLane = makeLane('Documents');
  data.files.forEach(entry => {
    const ts = new Date(entry.timestamp).getTime();
    const color = FILE_COLORS[entry.activity_type] || '#666';
    const el = addBlock(docLane.content, 'doc-block', ts, ts, color, { id: entry.id });
    el.classList.toggle('dimmed', Boolean(focusApp));
    const fileName = baseName(entry.file_path);
    tip(el, () => `<div class="tt-app" style="color:${color}">${esc(entry.activity_type.toUpperCase())}</div><div class="tt-doc">${esc(fileName)}</div><div class="tt-doc" style="font-size:10px;color:#666;">${esc(entry.file_path)}</div><div class="tt-time">${new Date(ts).toLocaleTimeString()}</div>`);
    el.addEventListener('click', () => { if (dragMoved) return; selectElement(entry.id); });
  });
  container.appendChild(docLane.lane);

  const siteLane = makeLane('Websites');
  data.sites.forEach(entry => {
    const start = new Date(entry.visit_time).getTime();
    const dur = Number(entry.duration) || 0;
    const end = start + (dur > 0 ? dur * 1000 : 0);
    const color = BROWSER_COLORS[entry.browser] || '#666';
    const el = addBlock(siteLane.content, 'doc-block', start, Math.max(end, start), color, { id: entry.id });
    el.classList.toggle('dimmed', Boolean(focusApp));
    tip(el, () => `<div class="tt-app" style="color:${color}">${esc(entry.browser)}</div><div class="tt-doc">${esc(entry.title || entry.url || 'N/A')}</div><div class="tt-doc" style="font-size:10px;color:#666;">${esc(entry.url || '')}</div><div class="tt-time">${new Date(start).toLocaleTimeString()}${dur ? ' (' + formatDur(dur) + ')' : ''}</div>`);
    el.addEventListener('click', () => { if (dragMoved) return; selectElement(entry.id); });
  });
  container.appendChild(siteLane.lane);

  const shotLane = makeLane('Screenshots');
  data.shots.forEach(s => {
    const ts = new Date(s.timestamp).getTime();
    const el = addBlock(shotLane.content, 'event-marker', ts, ts, '#9b59b6', { noWidth: true });
    el.addEventListener('click', () => { if (dragMoved) return; viewScreenshot(s.id); });
    tip(el, () => `<div class="tt-app" style="color:#9b59b6">Screenshot</div><div class="tt-doc">${esc(s.reason || '')}</div><div class="tt-time">${new Date(ts).toLocaleString()}</div>`);
  });
  container.appendChild(shotLane.lane);

  const usbLane = makeLane('USB');
  data.usb.forEach(entry => {
    const ts = new Date(entry.timestamp).getTime();
    const color = USB_COLORS[entry.event_type] || '#666';
    const el = addBlock(usbLane.content, 'event-marker', ts, ts, color, { id: entry.id, noWidth: true });
    el.classList.toggle('dimmed', Boolean(focusApp));
    tip(el, () => `<div class="tt-app" style="color:${color}">USB ${esc(entry.event_type)}</div><div class="tt-doc">${esc(entry.device_name || 'Unknown Device')}</div><div class="tt-time">${new Date(ts).toLocaleTimeString()}</div>`);
    el.addEventListener('click', () => { if (dragMoved) return; selectElement(entry.id); });
  });
  container.appendChild(usbLane.lane);

  const sysLane = makeLane('System');
  data.sys.forEach(entry => {
    const ts = new Date(entry.timestamp).getTime();
    const style = systemEventStyle(entry);
    const el = addBlock(sysLane.content, 'event-marker', ts, ts, style.color, { id: entry.id, noWidth: true });
    tip(el, () => `<div class="tt-app" style="color:${style.color}">${esc(style.label)}</div><div class="tt-doc">${esc(entry.event_data || '')}</div><div class="tt-time">${new Date(ts).toLocaleTimeString()}</div>`);
    el.addEventListener('click', () => { if (dragMoved) return; selectElement(entry.id); });
  });
  container.appendChild(sysLane.lane);

  applySelection();
}

function addAppBlock(content, entry) {
  let start = new Date(entry.start_time).getTime();
  let end = new Date(entry.end_time).getTime();
  if (!isFinite(start)) return;
  if (!isFinite(end) || end <= start) end = start + (Number(entry.duration) || 1) * 1000;
  const color = appColors[entry.process_name] || '#666';
  const el = addBlock(content, 'block', start, end, color, { id: entry.id });
  el.id = `blk-${entry.id}`;
  el.dataset.id = entry.id;
  el.classList.toggle('dimmed', dimmed(entry));
  tip(el, () => `<div class="tt-app">${esc(entry.process_name)}</div><div class="tt-doc">${esc(entry.window_title || 'N/A')}</div><div class="tt-time">${new Date(start).toLocaleTimeString()} - ${new Date(end).toLocaleTimeString()} (${formatDur(entry.duration)})</div>`);
  el.addEventListener('click', () => { if (dragMoved) return; selectElement(entry.id); });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (dragMoved) return;
    zoomToRange(start, end);
  });
  return el;
}

function renderLegend() {
  const totals = new Map();
  for (const e of data.apps) totals.set(e.process_name, (totals.get(e.process_name) || 0) + (Number(e.duration) || 0));
  const apps = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  apps.forEach(([a]) => getAppColor(a));

  const legend = document.getElementById('appLegend');
  legend.innerHTML = apps.map(([name, secs]) =>
    `<div class="legend-item" data-app="${esc(name)}" title="${esc(name)} - ${formatDur(secs)} (click to focus)" style="cursor:pointer;${focusApp && focusApp !== name ? 'opacity:0.4;' : ''}${focusApp === name ? 'outline:1px solid #4a90d9;padding:2px 4px;' : ''}"><div class="legend-color" style="background:${appColors[name]}"></div>${esc(name)} <span style="color:#666;margin-left:5px;">${formatDur(secs)}</span></div>`
  ).join('');

  legend.querySelectorAll('.legend-item').forEach(item => {
    item.addEventListener('click', () => {
      const name = item.dataset.app;
      focusApp = focusApp === name ? '' : name;
      render();
    });
  });
}

function renderSummary() {
  const summary = data.summary;
  const files = (summary && summary.files) || {};
  document.getElementById('sumApps').textContent = summary && summary.applications ? summary.applications.unique_apps || 0 : 0;
  document.getElementById('sumActive').textContent = summary && summary.applications ? formatDur(summary.applications.total_active_time || 0) : '0:00';
  document.getElementById('sumSites').textContent = summary && summary.websites ? summary.websites.unique_sites || 0 : 0;
  document.getElementById('sumFiles').textContent =
    (files.files_created || 0) + (files.files_deleted || 0) + (files.files_modified || 0) + (files.files_open || 0);
  document.getElementById('sumUsb').textContent = summary && summary.usb ? summary.usb.total_events || 0 : 0;
}

function renderTables() {
  const tbody = document.getElementById('detailBody');
  const sorted = [...data.apps].sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  tbody.innerHTML = sorted.slice(0, 200).map(e => {
    const color = appColors[e.process_name] || '#666';
    const start = new Date(e.start_time);
    const end = new Date(e.end_time);
    return `<tr data-id="${esc(e.id)}" style="cursor:pointer;"><td><span class="color-dot" style="background:${color}"></span></td><td>${esc(e.window_title || e.process_name)}</td><td>${start.toLocaleTimeString()}</td><td>${end.toLocaleTimeString()}</td><td>${formatDur(e.duration)}</td></tr>`;
  }).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      const entry = data.apps.find(x => String(x.id) === id);
      selectedId = id;
      applySelection();
      if (entry) zoomToRange(new Date(entry.start_time).getTime(), new Date(entry.end_time).getTime());
    });
  });

  const websiteBody = document.getElementById('websiteBody');
  const sortedWebsites = [...data.sites].sort((a, b) => new Date(b.visit_time) - new Date(a.visit_time));
  websiteBody.innerHTML = sortedWebsites.slice(0, 100).map(e => {
    const color = BROWSER_COLORS[e.browser] || '#666';
    const time = new Date(e.visit_time);
    return `<tr><td><span class="color-dot" style="background:${color}"></span></td><td>${esc(e.url || '')}</td><td>${esc(e.title || '')}</td><td>${esc(e.browser || '')}</td><td>${time.toLocaleTimeString()}</td></tr>`;
  }).join('');

  const fileBody = document.getElementById('fileBody');
  const sortedFiles = [...data.files].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  fileBody.innerHTML = sortedFiles.slice(0, 100).map(e => {
    const color = FILE_COLORS[e.activity_type] || '#666';
    const time = new Date(e.timestamp);
    return `<tr><td><span class="color-dot" style="background:${color}"></span></td><td>${esc(baseName(e.file_path))}</td><td>${esc(e.activity_type)}</td><td>${time.toLocaleTimeString()}</td></tr>`;
  }).join('');

  const usbBody = document.getElementById('usbBody');
  const sortedUsb = [...data.usb].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  usbBody.innerHTML = sortedUsb.slice(0, 100).map(e => {
    const color = USB_COLORS[e.event_type] || '#666';
    const time = new Date(e.timestamp);
    return `<tr><td><span class="color-dot" style="background:${color}"></span></td><td>${esc(e.device_name || 'Unknown')}</td><td>${esc(e.event_type)}</td><td>${time.toLocaleTimeString()}</td></tr>`;
  }).join('');

  const systemBody = document.getElementById('systemBody');
  const sortedSystem = [...data.sys].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  systemBody.innerHTML = sortedSystem.slice(0, 100).map(e => {
    const style = systemEventStyle(e);
    const time = new Date(e.timestamp);
    return `<tr><td><span class="color-dot" style="background:${style.color}"></span></td><td>${esc(style.label)}</td><td>${esc(e.event_data || '')}</td><td>${time.toLocaleTimeString()}</td></tr>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Zoom / pan
// ---------------------------------------------------------------------------
function setView(start, end) {
  if (!view.dayStart) return;
  const full = view.dayEnd - view.dayStart;
  let span = Math.max(MIN_SPAN, Math.min(full, end - start));
  let s = start;
  if (s < view.dayStart) s = view.dayStart;
  if (s + span > view.dayEnd) s = view.dayEnd - span;
  view.start = s;
  view.end = s + span;
  scheduleApplyView();
}

function zoomAt(anchor, factor) {
  const span = view.end - view.start;
  const full = view.dayEnd - view.dayStart;
  const newSpan = Math.max(MIN_SPAN, Math.min(full, span * factor));
  const frac = span > 0 ? (anchor - view.start) / span : 0.5;
  const s = anchor - frac * newSpan;
  setView(s, s + newSpan);
}

function zoomToRange(start, end) {
  const pad = Math.max((end - start) * 0.35, 60 * 1000);
  let s = start - pad;
  let e = end + pad;
  if (e - s > view.dayEnd - view.dayStart) { s = view.dayStart; e = view.dayEnd; }
  setView(s, e);
}

function zoomIn() { zoomAt((view.start + view.end) / 2, 1 / 1.6); }
function zoomOut() { zoomAt((view.start + view.end) / 2, 1.6); }
function fitDay() { if (view.dayStart) setView(view.dayStart, view.dayEnd); }
function panBy(frac) { const span = view.end - view.start; setView(view.start + span * frac, view.end + span * frac); }

function laneRect() {
  const el = document.querySelector('.lane-content');
  return el ? el.getBoundingClientRect() : null;
}

let drag = null;
let dragMoved = false;

function initTimelineInteraction() {
  const lanes = document.getElementById('lanes');

  lanes.addEventListener('wheel', (e) => {
    if (currentView !== 'timeline' || !view.start) return;
    e.preventDefault();
    const rect = laneRect();
    if (!rect || !rect.width) return;
    const delta = (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY);
    const deltaH = (e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX);

    if (e.shiftKey || Math.abs(deltaH) > Math.abs(delta)) {
      const span = view.end - view.start;
      const dx = e.shiftKey ? delta : deltaH;
      const shift = (dx / rect.width) * span;
      setView(view.start + shift, view.end + shift);
      return;
    }

    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const anchor = view.start + frac * (view.end - view.start);
    zoomAt(anchor, Math.pow(1.0018, delta));
  }, { passive: false });

  lanes.addEventListener('mousedown', (e) => {
    if (currentView !== 'timeline' || !view.start) return;
    if (e.button !== 0) return;
    if (!e.target.closest('.lane-content')) return;
    drag = { x: e.clientX, start: view.start, end: view.end };
    dragMoved = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!dragMoved && Math.abs(dx) > 4) {
      dragMoved = true;
      lanes.classList.add('panning');
      document.body.style.cursor = 'grabbing';
    }
    if (!dragMoved) return;
    const rect = laneRect();
    if (!rect || !rect.width) return;
    const perPx = (drag.end - drag.start) / rect.width;
    setView(drag.start - dx * perPx, drag.end - dx * perPx);
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    lanes.classList.remove('panning');
    document.body.style.cursor = '';
    setTimeout(() => { dragMoved = false; }, 0);
  });

  document.addEventListener('keydown', (e) => {
    if (!token || currentView !== 'timeline' || !view.start) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut(); }
    else if (e.key === '0') { e.preventDefault(); fitDay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); panBy(-0.12); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); panBy(0.12); }
    else if (e.key === 'r' || e.key === 'R') { refreshNow(); }
  });
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
async function loadScreenshots() {
  const grid = document.getElementById('ssGrid');
  let list = [];
  try {
    const res = await api('/screenshots', { machine_name: currentMachine, limit: 200 });
    if (Array.isArray(res)) list = res;
  } catch (e) {
    if (e && e.sessionExpired) return;
    console.error('loadScreenshots failed:', e);
    grid.innerHTML = `<div class="ss-empty">Failed to load screenshots: ${esc(e.message)}</div>`;
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="ss-empty">No screenshots yet. Click the Screenshot button to capture one.</div>'; return; }
  grid.innerHTML = list.map(s => `<div class="ss-card" onclick="viewScreenshot('${esc(s.id)}')"><div id="ssimg-${esc(s.id)}" style="height:200px;background:#333;display:flex;align-items:center;justify-content:center;color:#666;">Loading...</div><div class="ss-info"><div class="ss-time">${new Date(s.timestamp).toLocaleString()}</div><div class="ss-reason">${esc(s.reason)}</div><div class="ss-machine">${esc(s.machine_name || 'Local')}</div></div></div>`).join('');
  list.forEach(s => loadSSImage(s.id));
}

async function loadSSImage(id) {
  try {
    const r = await fetch(`${API}/screenshots/base64/${esc(id)}?token=${encodeURIComponent(token)}`);
    const d = await r.json();
    if (d.image) {
      const el = document.getElementById(`ssimg-${esc(id)}`);
      if (el) el.innerHTML = `<img src="data:image/jpeg;base64,${d.image}" style="width:100%;height:200px;object-fit:cover;">`;
    }
  } catch (e) { /* keep the placeholder */ }
}

function viewScreenshot(id) {
  document.getElementById('ssViewerImg').src = `${API}/screenshots/image/${esc(id)}?token=${encodeURIComponent(token)}`;
  document.getElementById('ssViewer').classList.add('active');
}

async function takeScreenshot() {
  const status = document.getElementById('ssStatus');
  status.style.display = 'inline';
  status.style.background = '#333';
  status.style.color = '#aaa';
  status.textContent = 'Capturing...';
  try {
    const r = await fetch(`${API}/screenshots/capture`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
    const d = await r.json();
    if (d.success) {
      status.style.background = '#1a472a';
      status.style.color = '#2ecc71';
      status.textContent = 'Saved!';
      switchView('screenshots');
    } else {
      status.style.background = '#4a1a1a';
      status.style.color = '#e74c3c';
      status.textContent = d.error || 'Failed';
    }
  } catch (e) {
    status.style.background = '#4a1a1a';
    status.style.color = '#e74c3c';
    status.textContent = 'Error';
  }
  setTimeout(() => { status.style.display = 'none'; }, 2500);
}

// ---------------------------------------------------------------------------
// Date navigation / admin
// ---------------------------------------------------------------------------
function changeDate(delta) {
  const input = document.getElementById('timelineDate');
  const d = parseDateStr(input.value);
  d.setDate(d.getDate() + delta);
  input.value = localDateStr(d);
  if (currentView === 'timeline') loadTimeline();
}

function goToday() {
  document.getElementById('timelineDate').value = localDateStr();
  if (currentView === 'timeline') loadTimeline();
}

async function purgeNow() {
  if (!confirm('Delete screenshots and database records older than the configured retention period (15 days)? This cannot be undone.')) return;
  try {
    const r = await fetch(`${API}/admin/purge-retention`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    if (d.success) { alert('Old data purged.'); refreshNow(); }
    else alert(d.error || 'Purge failed');
  } catch (e) { alert('Purge failed: ' + e.message); }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function startAutoRefresh() {
  setInterval(async () => {
    if (!token || document.hidden) return;
    try { await loadMachines(); } catch (e) { /* ignore */ }
    try {
      if (currentView === 'timeline') await loadTimeline({ silent: true });
      else await loadScreenshots();
    } catch (e) { /* ignore */ }
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token) refreshNow();
  });
}

initTimelineInteraction();
startAutoRefresh();
restoreSession();
