// Helpers shared by every datastore backend (sqlite + mongodb).

const ALLOWED_TABLES = new Set([
  'application_usage', 'website_visits', 'file_activities', 'system_events',
  'screenshots', 'usb_devices', 'processes', 'network_connections', 'installed_software'
]);

function isValidIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "machine_name" or, for legacy rows, user_name stored as "HOSTNAME\user".
// Passing column === 'machine_name' restricts the match to an exact comparison.
function machineClauseSql(machineName, column = 'user_name') {
  if (!machineName) return { sql: '', params: [] };
  if (column === 'machine_name') return { sql: ' AND machine_name = ?', params: [machineName] };
  return { sql: ` AND (machine_name = ? OR ${column} LIKE ?)`, params: [machineName, `${machineName}\\%`] };
}

function machineMatchMongo(machineName, column = 'user_name') {
  if (!machineName) return null;
  if (column === 'machine_name') return { machine_name: machineName };
  return { $or: [{ machine_name: machineName }, { [column]: new RegExp(`^${escapeRegex(machineName)}\\\\`) }] };
}

// Neutral date-range representation translated by each backend.
function dateClauseSql(field, startDate, endDate) {
  let sql = '';
  const params = [];
  if (startDate) { sql += ` AND ${field} >= ?`; params.push(startDate); }
  if (endDate) { sql += ` AND ${field} <= ?`; params.push(endDate); }
  return { sql, params };
}

function dateMatchMongo(field, startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match[field] = {
      ...(startDate ? { $gte: startDate } : {}),
      ...(endDate ? { $lte: endDate } : {})
    };
  }
  return match;
}

// Summary cards are scoped to a single calendar day.
function dayRange(dateStr) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '');
  const day = valid ? dateStr : new Date().toISOString().slice(0, 10);
  const end = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86400000).toISOString().slice(0, 10);
  return [day, end];
}

// Validates + normalises one agent event before insert.
// columnsOf(table) returns the writable column list, or null to accept every
// identifier-shaped field (document stores).
function sanitizeEvent(rawEvent, { machineName, table, columnsOf }) {
  const evt = { ...rawEvent };
  delete evt._table;
  delete evt.id;
  delete evt._id;

  const columns = columnsOf(table);
  if (machineName) {
    if (evt.user_name) evt.user_name = `${machineName}\\${evt.user_name}`;
    if (!columns || columns.includes('machine_name')) evt.machine_name = machineName;
  }

  const doc = {};
  for (const key of Object.keys(evt)) {
    if (!isValidIdentifier(key)) continue;
    if (columns && !columns.includes(key)) continue;
    doc[key] = evt[key];
  }
  return doc;
}

module.exports = {
  ALLOWED_TABLES,
  isValidIdentifier,
  escapeRegex,
  machineClauseSql,
  machineMatchMongo,
  dateClauseSql,
  dateMatchMongo,
  dayRange,
  sanitizeEvent
};
