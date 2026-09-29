// SQLite backend (sql.js) - offline / zero-dependency fallback.
// Implements the same repository interface as the mongodb backend.
const fs = require('fs');
const path = require('path');

function create(cfg, shared) {
  const dbPath = cfg.database.sqlitePath;
  const auditPath = cfg.database.auditPath;
  const retentionDays = cfg.monitoring.dataRetentionDays;

  let SQL = null;
  let db = null;
  let saveTimer = null;
  let dirty = false;
  const columnCache = new Map();

  // --- persistence ---------------------------------------------------------
  function persist(immediate = false) {
    dirty = true;
    if (immediate) return flushDb();
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushDb();
    }, 500);
  }

  function flushDb() {
    if (!db || !dirty) return;
    try {
      const data = Buffer.from(db.export());
      const tmp = dbPath + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dbPath);
      dirty = false;
    } catch (e) {
      console.error(`[DB] Save failed: ${e.message}`);
    }
  }

  function queryAll(sql, params = []) {
    if (!db) return [];
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function queryOne(sql, params = []) {
    const rows = queryAll(sql, params);
    return rows.length ? rows[0] : null;
  }

  function run(sql, params = []) {
    if (!db) throw new Error('database not ready');
    db.run(sql, params);
    persist();
  }

  function tableColumns(table) {
    if (columnCache.has(table)) return columnCache.get(table);
    const cols = queryAll(`PRAGMA table_info(${table})`).map(c => c.name);
    columnCache.set(table, cols);
    return cols;
  }

  function hasColumn(table, col) {
    return tableColumns(table).includes(col);
  }

  function ensureColumn(table, column, type = 'TEXT') {
    if (!hasColumn(table, column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      columnCache.delete(table);
      console.log(`[DB] Migration: ${table}.${column} added`);
      persist(true);
    }
  }

  function createSchema() {
    db.run(`
      CREATE TABLE IF NOT EXISTS application_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, process_name TEXT, window_title TEXT,
        exe_path TEXT, start_time DATETIME, end_time DATETIME, duration INTEGER,
        user_name TEXT, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS website_visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, title TEXT, browser TEXT,
        visit_time DATETIME, duration INTEGER, user_name TEXT, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS file_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, activity_type TEXT,
        timestamp DATETIME, user_name TEXT, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS system_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, event_data TEXT,
        timestamp DATETIME, user_name TEXT, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS screenshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, timestamp DATETIME,
        reason TEXT, machine_name TEXT, key_id TEXT, storage_json TEXT);
      CREATE TABLE IF NOT EXISTS usb_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_name TEXT, device_id TEXT,
        event_type TEXT, timestamp DATETIME, user_name TEXT, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS processes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, process_name TEXT, pid INTEGER,
        memory_usage INTEGER, cpu_usage REAL, timestamp DATETIME, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS network_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, local_address TEXT, remote_address TEXT,
        status TEXT, process_name TEXT, timestamp DATETIME, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS installed_software (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, version TEXT, publisher TEXT,
        install_date DATETIME, last_checked DATETIME, machine_name TEXT);
      CREATE TABLE IF NOT EXISTS agent_heartbeat (
        id INTEGER PRIMARY KEY AUTOINCREMENT, machine_name TEXT, hostname TEXT,
        ip TEXT, agent_version TEXT, last_seen DATETIME);
      CREATE TABLE IF NOT EXISTS ingest_batches (
        batch_id TEXT PRIMARY KEY, machine_name TEXT, event_count INTEGER, received_at DATETIME);
    `);
    columnCache.clear();
  }

  function migrate() {
    for (const t of ['application_usage', 'website_visits', 'file_activities', 'system_events', 'usb_devices', 'processes', 'network_connections', 'installed_software']) {
      ensureColumn(t, 'machine_name', 'TEXT');
    }
    ensureColumn('screenshots', 'key_id', 'TEXT');
    ensureColumn('screenshots', 'storage_json', 'TEXT');
  }

  // --- query helpers -------------------------------------------------------
  function select({ columns, table, filter, extra = '', params: extraParams = [] }) {
    const where = filterSql(filter);
    return queryAll(`SELECT ${columns} FROM ${table} WHERE 1=1${where.sql} ${extra}`, [...where.params, ...extraParams]);
  }

  function filterSql(filter = {}) {
    const { startDate, endDate, dateField, user, machineName, machineColumn, where = [] } = filter;
    let sql = '';
    const params = [];
    if (dateField && (startDate || endDate)) {
      const r = shared.dateClauseSql(dateField, startDate, endDate);
      sql += r.sql;
      params.push(...r.params);
    }
    if (user) { sql += ' AND user_name LIKE ?'; params.push(`%${user}%`); }
    const mc = shared.machineClauseSql(machineName, machineColumn);
    sql += mc.sql;
    params.push(...mc.params);
    for (const clause of where) {
      sql += ` AND ${clause.field} = ?`;
      params.push(clause.value);
    }
    return { sql, params };
  }

  function parseStorage(row) {
    if (!row) return null;
    if (row.storage_json) {
      try { row.storage = JSON.parse(row.storage_json); } catch (e) { row.storage = null; }
    }
    row.storage = row.storage || (row.file_path ? { provider: 'local', key: row.file_path } : null);
    delete row.storage_json;
    return row;
  }

  // --- repository ----------------------------------------------------------
  const api = {
    name: 'sqlite',
    ready: false,

    async init() {
      const initSqlJs = require('sql.js');
      SQL = await initSqlJs();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
      createSchema();
      migrate();
      api.ready = true;
      flushDb();
      return api;
    },

    async close() {
      flushDb();
      try { if (db) db.close(); } catch (e) {}
      db = null;
      api.ready = false;
    },

    async purgeExpired(days = retentionDays) {
      const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
      const rules = [
        ['application_usage', 'start_time', days],
        ['website_visits', 'visit_time', days],
        ['file_activities', 'timestamp', days],
        ['system_events', 'timestamp', days],
        ['usb_devices', 'timestamp', days],
        ['installed_software', 'last_checked', days],
        ['agent_heartbeat', 'last_seen', 30],
        ['processes', 'timestamp', 7],
        ['network_connections', 'timestamp', 7],
        ['ingest_batches', 'received_at', 7]
      ];
      let removed = 0;
      for (const [table, column, d] of rules) {
        try {
          const before = queryOne(`SELECT COUNT(*) c FROM ${table}`)?.c || 0;
          run(`DELETE FROM ${table} WHERE ${column} < ?`, [iso(d)]);
          const after = queryOne(`SELECT COUNT(*) c FROM ${table}`)?.c || 0;
          removed += before - after;
        } catch (e) { /* table may not exist yet */ }
      }

      const staleScreenshots = [];
      try {
        const stale = queryAll(`SELECT id, file_path, storage_json FROM screenshots WHERE timestamp < ?`, [iso(days)]);
        for (const row of stale) {
          staleScreenshots.push(parseStorage(row).storage);
          run(`DELETE FROM screenshots WHERE id = ?`, [row.id]);
        }
        removed += stale.length;
      } catch (e) { /* ignore */ }

      if (removed > 0) {
        console.log(`[Retention] Purged ${removed} expired rows`);
        persist(true);
      }
      return { removed, staleScreenshots: staleScreenshots.filter(Boolean) };
    },

    async listApplications({ startDate, endDate, user, machineName, raw } = {}) {
      const filter = { dateField: 'start_time', startDate, endDate, user, machineName };
      if (raw) {
        return select({
          columns: 'id, process_name, window_title, exe_path, start_time, end_time, duration, user_name, machine_name',
          table: 'application_usage', filter,
          extra: 'ORDER BY start_time ASC LIMIT 20000'
        });
      }
      return select({
        columns: 'process_name, window_title, SUM(duration) as total_duration, COUNT(*) as usage_count',
        table: 'application_usage', filter,
        extra: 'GROUP BY process_name ORDER BY total_duration DESC'
      });
    },

    async listWebsites({ startDate, endDate, user, machineName, raw } = {}) {
      const filter = { dateField: 'visit_time', startDate, endDate, user, machineName };
      if (raw) {
        return select({
          columns: 'id, url, title, browser, visit_time, duration, user_name, machine_name',
          table: 'website_visits', filter,
          extra: 'ORDER BY visit_time ASC LIMIT 20000'
        });
      }
      return select({
        columns: 'url, title, browser, COUNT(*) as visit_count, SUM(duration) as total_duration',
        table: 'website_visits', filter,
        extra: 'GROUP BY url ORDER BY visit_count DESC LIMIT 2000'
      });
    },

    async listFiles({ startDate, endDate, user, activityType, machineName } = {}) {
      const filter = {
        dateField: 'timestamp', startDate, endDate, user, machineName,
        where: activityType ? [{ field: 'activity_type', value: activityType }] : []
      };
      return select({
        columns: 'file_path, activity_type, timestamp, user_name, machine_name',
        table: 'file_activities', filter,
        extra: 'ORDER BY timestamp DESC LIMIT 20000'
      });
    },

    async listEvents({ startDate, endDate, eventType, machineName, raw } = {}) {
      const filter = {
        dateField: 'timestamp', startDate, endDate, machineName,
        where: eventType ? [{ field: 'event_type', value: eventType }] : []
      };
      if (raw) {
        return select({
          columns: 'id, event_type, event_data, timestamp, machine_name',
          table: 'system_events', filter,
          extra: 'ORDER BY timestamp ASC LIMIT 20000'
        });
      }
      return select({
        columns: 'event_type, event_data, timestamp, machine_name',
        table: 'system_events', filter,
        extra: 'ORDER BY timestamp DESC LIMIT 1000'
      });
    },

    async listUsb({ startDate, endDate, machineName, raw } = {}) {
      const filter = { dateField: 'timestamp', startDate, endDate, machineName };
      if (raw) {
        return select({
          columns: 'id, device_name, device_id, event_type, timestamp, user_name, machine_name',
          table: 'usb_devices', filter,
          extra: 'ORDER BY timestamp ASC LIMIT 20000'
        });
      }
      return select({
        columns: 'device_name, device_id, event_type, timestamp, machine_name',
        table: 'usb_devices', filter,
        extra: 'ORDER BY timestamp DESC LIMIT 1000'
      });
    },

    async listProcesses({ timestamp, machineName } = {}) {
      const filter = { dateField: 'timestamp', startDate: timestamp, machineName, machineColumn: 'machine_name' };
      return select({
        columns: 'process_name, pid, memory_usage, cpu_usage, timestamp, machine_name',
        table: 'processes', filter,
        extra: 'ORDER BY timestamp DESC LIMIT 500'
      });
    },

    async listNetwork({ startDate, endDate, machineName } = {}) {
      const filter = { dateField: 'timestamp', startDate, endDate, machineName, machineColumn: 'machine_name' };
      return select({
        columns: 'local_address, remote_address, status, process_name, timestamp, machine_name',
        table: 'network_connections', filter,
        extra: 'ORDER BY timestamp DESC LIMIT 1000'
      });
    },

    async summary({ date, startDate, endDate, machineName } = {}) {
      const filter = { dateField: null, machineName };
      const w = filterSql(filter);
      const day = (column) => ` AND ${column} >= ? AND ${column} < ?`;
      // `startDate`/`endDate` (the UTC window of the selected local day) win
      // over the legacy single-date form so cards match the timeline lanes.
      const range = (startDate && endDate) ? [startDate, endDate] : shared.dayRange(date);

      const appUsage = queryOne(
        `SELECT COUNT(DISTINCT process_name) as unique_apps, COALESCE(SUM(duration),0) as total_active_time FROM application_usage WHERE 1=1${day('start_time')}${w.sql}`,
        [...range, ...w.params]
      );
      const websiteVisits = queryOne(
        `SELECT COUNT(DISTINCT url) as unique_sites, COUNT(*) as total_visits FROM website_visits WHERE 1=1${day('visit_time')}${w.sql}`,
        [...range, ...w.params]
      );
      const fileActivities = queryOne(
        `SELECT SUM(CASE WHEN activity_type='create' THEN 1 ELSE 0 END) as files_created, SUM(CASE WHEN activity_type='delete' THEN 1 ELSE 0 END) as files_deleted, SUM(CASE WHEN activity_type='modify' THEN 1 ELSE 0 END) as files_modified, SUM(CASE WHEN activity_type='open' THEN 1 ELSE 0 END) as files_open FROM file_activities WHERE 1=1${day('timestamp')}${w.sql}`,
        [...range, ...w.params]
      );
      const usbEvents = queryOne(
        `SELECT COUNT(*) as total_events FROM usb_devices WHERE 1=1${day('timestamp')}${w.sql}`,
        [...range, ...w.params]
      );
      const screenshots = queryOne(
        `SELECT COUNT(*) as total_screenshots FROM screenshots WHERE 1=1${day('timestamp')}${machineName ? ' AND machine_name = ?' : ''}`,
        machineName ? [...range, machineName] : [...range]
      );
      const idle = queryOne(
        `SELECT COUNT(*) as idle_events FROM system_events WHERE 1=1${day('timestamp')} AND event_type = 'idle_start'${w.sql}`,
        [...range, ...w.params]
      );

      return {
        date: String(range[0]).slice(0, 10),
        machine: machineName || 'all',
        applications: appUsage,
        websites: websiteVisits,
        files: fileActivities,
        usb: usbEvents,
        screenshots,
        idle
      };
    },

    async listScreenshots({ startDate, endDate, reason, machineName, limit = 100 } = {}) {
      const filter = {
        dateField: 'timestamp', startDate, endDate, machineName, machineColumn: 'machine_name',
        where: reason ? [{ field: 'reason', value: reason }] : []
      };
      return select({
        columns: 'id, file_path, storage_json, timestamp, reason, machine_name',
        table: 'screenshots', filter,
        extra: `ORDER BY timestamp DESC LIMIT ${parseInt(limit, 10) || 100}`
      }).map(parseStorage);
    },

    async getScreenshot(id) {
      const row = queryOne(`SELECT id, file_path, storage_json, timestamp, reason, machine_name, key_id FROM screenshots WHERE id = ?`, [parseInt(id, 10)]);
      return row ? parseStorage(row) : null;
    },

    async insertScreenshot({ storage, timestamp, reason, machineName, keyId }) {
      run(
        `INSERT INTO screenshots (file_path, storage_json, timestamp, reason, machine_name, key_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [storage?.key || null, JSON.stringify(storage || {}), timestamp, reason || 'scheduled', machineName, keyId]
      );
      flushDb();
      return queryOne(`SELECT last_insert_rowid() as id`)?.id;
    },

    async deleteScreenshot(id) {
      run(`DELETE FROM screenshots WHERE id = ?`, [parseInt(id, 10)]);
      flushDb();
    },

    async ingestBatch({ batchId, events, machineName }) {
      if (batchId) {
        try {
          if (queryOne(`SELECT batch_id FROM ingest_batches WHERE batch_id = ?`, [batchId])) {
            return { success: true, inserted: 0, duplicate: true, errors: [] };
          }
        } catch (e) { /* table missing - fall through */ }
      }

      let inserted = 0;
      const errors = [];
      for (const raw of events) {
        const table = raw?._table;
        if (!table || !shared.ALLOWED_TABLES.has(table)) { errors.push(`bad table: ${table}`); continue; }
        const doc = shared.sanitizeEvent(raw, {
          machineName,
          table,
          columnsOf: (t) => tableColumns(t)
        });
        const columns = Object.keys(doc);
        if (!columns.length) continue;
        try {
          run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(c => doc[c]));
          inserted++;
        } catch (e) {
          errors.push(e.message);
        }
      }

      if (batchId) {
        try {
          run(
            `INSERT OR REPLACE INTO ingest_batches (batch_id, machine_name, event_count, received_at) VALUES (?, ?, ?, ?)`,
            [batchId, machineName || '', inserted, new Date().toISOString()]
          );
        } catch (e) { errors.push(e.message); }
      }

      flushDb();
      return { success: true, inserted, duplicate: false, errors };
    },

    async ingestSingle({ table, data, machineName }) {
      if (!table || !data) throw badRequest('table and data required');
      if (!shared.ALLOWED_TABLES.has(table)) throw badRequest('table not allowed');
      const doc = shared.sanitizeEvent({ ...data, _table: table }, {
        machineName, table, columnsOf: (t) => tableColumns(t)
      });
      const columns = Object.keys(doc);
      if (!columns.length) throw badRequest('no valid columns');
      run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(c => doc[c]));
      flushDb();
      return { success: true };
    },

    async upsertHeartbeat({ machineName, hostname, ip, agentVersion }) {
      const existing = queryOne(`SELECT id FROM agent_heartbeat WHERE machine_name = ?`, [machineName]);
      if (existing) {
        run(`UPDATE agent_heartbeat SET hostname=?, ip=?, agent_version=?, last_seen=CURRENT_TIMESTAMP WHERE machine_name=?`,
          [hostname || '', ip || '', agentVersion || '', machineName]);
      } else {
        run(`INSERT INTO agent_heartbeat (machine_name, hostname, ip, agent_version, last_seen) VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
          [machineName, hostname || '', ip || '', agentVersion || '']);
      }
      flushDb();
      return { success: true, status: 'ok' };
    },

    async listHeartbeats() {
      try {
        return queryAll(`SELECT machine_name, hostname, ip, agent_version, last_seen FROM agent_heartbeat ORDER BY last_seen DESC`);
      } catch (e) {
        return [];
      }
    },

    async maxApplicationStartTime() {
      return queryOne(`SELECT MAX(start_time) as last_seen FROM application_usage`)?.last_seen || null;
    },

    async cleanupFileActivities() {
      run(`DELETE FROM file_activities WHERE file_path LIKE '%monitor.db%' OR file_path LIKE '%windows monitoring software%'`);
      persist(true);
      return queryOne('SELECT COUNT(*) as c FROM file_activities')?.c || 0;
    },

    async appendAudit(entry) {
      try {
        const dir = path.dirname(auditPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(auditPath) && fs.statSync(auditPath).size > 5 * 1024 * 1024) {
          fs.renameSync(auditPath, auditPath + '.1');
        }
        fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
      } catch (e) { /* auditing must never break a request */ }
    },

    async listAudit(limit = 200) {
      try {
        const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      } catch (e) {
        return [];
      }
    }
  };

  return api;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = { create };
