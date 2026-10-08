// MongoDB backend - production / AWS ready datastore.
// Implements the same repository interface as the sqlite backend, so routes
// never care which one is active (DB_PROVIDER in .env / config.json).
const { MongoClient, ObjectId } = require('mongodb');

function create(cfg, shared) {
  const uri = cfg.database.mongodbUri;
  const dbName = cfg.database.mongodbDb;
  const retentionDays = cfg.monitoring.dataRetentionDays;

  let client = null;
  let mongoDb = null;

  const col = (name) => mongoDb.collection(name);

  function mapDoc(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
  }

  // Neutral filter -> mongo query
  function matchFilter(filter = {}) {
    const and = [];
    if (filter.dateField && (filter.startDate || filter.endDate)) {
      and.push(shared.dateMatchMongo(filter.dateField, filter.startDate, filter.endDate));
    }
    if (filter.user) and.push({ user_name: new RegExp(shared.escapeRegex(filter.user), 'i') });
    const machine = shared.machineMatchMongo(filter.machineName, filter.machineColumn);
    if (machine) and.push(machine);
    for (const clause of filter.where || []) and.push({ [clause.field]: clause.value });
    return and.length ? { $and: and } : {};
  }

  function dayMatch(field, date, machineName, machineColumn) {
    const [start, end] = shared.dayRange(date);
    const range = { [field]: { $gte: start, $lt: end } };
    const machine = shared.machineMatchMongo(machineName, machineColumn);
    return machine ? { $and: [range, machine] } : range;
  }

  function withStorage(doc) {
    if (!doc) return doc;
    if (!doc.storage) {
      doc.storage = doc.file_path ? { provider: 'local', key: doc.file_path } : null;
    }
    return doc;
  }

  const api = {
    name: 'mongodb',
    ready: false,

    async init() {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      mongoDb = client.db(dbName);
      await ensureIndexes();
      api.ready = true;
      console.log(`[DB] MongoDB connected (${dbName})`);
      return api;
    },

    async close() {
      api.ready = false;
      try { if (client) await client.close(); } catch (e) {}
      client = null;
      mongoDb = null;
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
      for (const [table, field, d] of rules) {
        try {
          const res = await col(table).deleteMany({ [field]: { $lt: iso(d) } });
          removed += res.deletedCount || 0;
        } catch (e) { /* collection may not exist yet */ }
      }

      const staleScreenshots = [];
      try {
        const stale = await col('screenshots').find({ timestamp: { $lt: iso(days) } }).project({ storage: 1, file_path: 1 }).toArray();
        for (const doc of stale) staleScreenshots.push(withStorage(doc).storage);
        if (stale.length) {
          await col('screenshots').deleteMany({ _id: { $in: stale.map(s => s._id) } });
          removed += stale.length;
        }
      } catch (e) { /* ignore */ }

      if (removed > 0) console.log(`[Retention] Purged ${removed} expired rows`);
      return { removed, staleScreenshots: staleScreenshots.filter(Boolean) };
    },

    async listApplications({ startDate, endDate, user, machineName, raw } = {}) {
      const match = matchFilter({ dateField: 'start_time', startDate, endDate, user, machineName });
      if (raw) {
        const docs = await col('application_usage').find(match).sort({ start_time: 1 }).limit(20000).toArray();
        return docs.map(mapDoc);
      }
      const rows = await col('application_usage').aggregate([
        { $match: match },
        { $group: { _id: '$process_name', total_duration: { $sum: { $ifNull: ['$duration', 0] } }, usage_count: { $sum: 1 } } },
        { $sort: { total_duration: -1 } },
        { $project: { _id: 0, process_name: '$_id', total_duration: 1, usage_count: 1 } }
      ]).toArray();
      return rows;
    },

    async listWebsites({ startDate, endDate, user, machineName, raw } = {}) {
      const match = matchFilter({ dateField: 'visit_time', startDate, endDate, user, machineName });
      if (raw) {
        const docs = await col('website_visits').find(match).sort({ visit_time: 1 }).limit(20000).toArray();
        return docs.map(mapDoc);
      }
      return col('website_visits').aggregate([
        { $match: match },
        {
          $group: {
            _id: '$url',
            title: { $first: '$title' },
            browser: { $first: '$browser' },
            visit_count: { $sum: 1 },
            total_duration: { $sum: { $ifNull: ['$duration', 0] } }
          }
        },
        { $sort: { visit_count: -1 } },
        { $limit: 2000 },
        { $project: { _id: 0, url: '$_id', title: 1, browser: 1, visit_count: 1, total_duration: 1 } }
      ]).toArray();
    },

    async listFiles({ startDate, endDate, user, activityType, machineName } = {}) {
      const match = matchFilter({
        dateField: 'timestamp', startDate, endDate, user, machineName,
        where: activityType ? [{ field: 'activity_type', value: activityType }] : []
      });
      const docs = await col('file_activities').find(match).sort({ timestamp: -1 }).limit(20000).toArray();
      return docs.map(mapDoc);
    },

    async listEvents({ startDate, endDate, eventType, machineName, raw } = {}) {
      const match = matchFilter({
        dateField: 'timestamp', startDate, endDate, machineName,
        where: eventType ? [{ field: 'event_type', value: eventType }] : []
      });
      const cursor = col('system_events').find(match);
      if (raw) {
        const docs = await cursor.sort({ timestamp: 1 }).limit(20000).toArray();
        return docs.map(mapDoc);
      }
      const docs = await cursor.sort({ timestamp: -1 }).limit(1000).toArray();
      return docs.map(mapDoc);
    },

    async listUsb({ startDate, endDate, machineName, raw } = {}) {
      const match = matchFilter({ dateField: 'timestamp', startDate, endDate, machineName });
      const cursor = col('usb_devices').find(match);
      const docs = raw
        ? await cursor.sort({ timestamp: 1 }).limit(20000).toArray()
        : await cursor.sort({ timestamp: -1 }).limit(1000).toArray();
      return docs.map(mapDoc);
    },

    async listProcesses({ timestamp, machineName } = {}) {
      const match = matchFilter({ dateField: 'timestamp', startDate: timestamp, machineName, machineColumn: 'machine_name' });
      const docs = await col('processes').find(match).sort({ timestamp: -1 }).limit(500).toArray();
      return docs.map(mapDoc);
    },

    async listNetwork({ startDate, endDate, machineName } = {}) {
      const match = matchFilter({ dateField: 'timestamp', startDate, endDate, machineName, machineColumn: 'machine_name' });
      const docs = await col('network_connections').find(match).sort({ timestamp: -1 }).limit(1000).toArray();
      return docs.map(mapDoc);
    },

    async summary({ date, startDate, endDate, machineName } = {}) {
      // The dashboard sends the exact UTC window of the selected local day so
      // the summary cards always agree with the lanes; `date` alone remains the
      // fallback for older clients (treated as a UTC calendar day).
      const [rangeStart, rangeEnd] = (startDate && endDate) ? [startDate, endDate] : shared.dayRange(date);
      const dayMatch = (field) => {
        const range = { [field]: { $gte: rangeStart, $lt: rangeEnd } };
        const machine = shared.machineMatchMongo(machineName);
        return machine ? { $and: [range, machine] } : range;
      };

      const apps = await col('application_usage').aggregate([
        { $match: dayMatch('start_time') },
        { $group: { _id: null, unique: { $addToSet: '$process_name' }, total: { $sum: { $ifNull: ['$duration', 0] } } } }
      ]).toArray();
      const sites = await col('website_visits').aggregate([
        { $match: dayMatch('visit_time') },
        { $group: { _id: null, unique: { $addToSet: '$url' }, total: { $sum: 1 } } }
      ]).toArray();
      const files = await col('file_activities').aggregate([
        { $match: dayMatch('timestamp') },
        {
          $group: {
            _id: null,
            files_created: { $sum: { $cond: [{ $eq: ['$activity_type', 'create'] }, 1, 0] } },
            files_deleted: { $sum: { $cond: [{ $eq: ['$activity_type', 'delete'] }, 1, 0] } },
            files_modified: { $sum: { $cond: [{ $eq: ['$activity_type', 'modify'] }, 1, 0] } },
            files_open: { $sum: { $cond: [{ $eq: ['$activity_type', 'open'] }, 1, 0] } }
          }
        }
      ]).toArray();
      const usb = await col('usb_devices').countDocuments(dayMatch('timestamp'));
      const shotRange = { timestamp: { $gte: rangeStart, $lt: rangeEnd } };
      const shotMatch = shared.machineMatchMongo(machineName, 'machine_name');
      const shots = await col('screenshots').countDocuments(
        shotMatch ? { $and: [shotRange, shotMatch] } : shotRange
      );
      const idle = await col('system_events').countDocuments({
        $and: [dayMatch('timestamp'), { event_type: 'idle_start' }]
      });

      return {
        date: rangeStart.slice(0, 10),
        machine: machineName || 'all',
        applications: apps.length ? { unique_apps: apps[0].unique.length, total_active_time: apps[0].total } : { unique_apps: 0, total_active_time: 0 },
        websites: sites.length ? { unique_sites: sites[0].unique.length, total_visits: sites[0].total } : { unique_sites: 0, total_visits: 0 },
        files: files.length
          ? { files_created: files[0].files_created, files_deleted: files[0].files_deleted, files_modified: files[0].files_modified, files_open: files[0].files_open }
          : { files_created: 0, files_deleted: 0, files_modified: 0, files_open: 0 },
        usb: { total_events: usb },
        screenshots: { total_screenshots: shots },
        idle: { idle_events: idle }
      };
    },

    async listScreenshots({ startDate, endDate, reason, machineName, limit = 100 } = {}) {
      const match = matchFilter({
        dateField: 'timestamp', startDate, endDate, machineName, machineColumn: 'machine_name',
        where: reason ? [{ field: 'reason', value: reason }] : []
      });
      const docs = await col('screenshots').find(match)
        .sort({ timestamp: -1 })
        .limit(parseInt(limit, 10) || 100)
        .toArray();
      return docs.map(d => mapDoc(withStorage(d)));
    },

    async getScreenshot(id) {
      let _id = null;
      if (ObjectId.isValid(String(id))) {
        try { _id = new ObjectId(String(id)); } catch (e) { _id = null; }
      }
      const doc = _id
        ? await col('screenshots').findOne({ _id })
        : await col('screenshots').findOne({ id });
      return mapDoc(withStorage(doc));
    },

    async insertScreenshot({ storage, timestamp, reason, machineName, keyId }) {
      const res = await col('screenshots').insertOne({
        file_path: storage?.key || null,
        storage: storage || null,
        timestamp: timestamp || new Date().toISOString(),
        reason: reason || 'scheduled',
        machine_name: machineName,
        key_id: keyId
      });
      return res.insertedId;
    },

    async deleteScreenshot(id) {
      let _id = null;
      if (ObjectId.isValid(String(id))) {
        try { _id = new ObjectId(String(id)); } catch (e) { _id = null; }
      }
      await col('screenshots').deleteOne(_id ? { _id } : { id });
    },

    async ingestBatch({ batchId, events, machineName }) {
      if (batchId) {
        try {
          const seen = await col('ingest_batches').findOne({ batch_id: batchId }, { projection: { _id: 1 } });
          if (seen) return { success: true, inserted: 0, duplicate: true, errors: [] };
        } catch (e) { /* fall through */ }
      }

      const byTable = new Map();
      const errors = [];
      for (const raw of events) {
        const table = raw?._table;
        if (!table || !shared.ALLOWED_TABLES.has(table)) { errors.push(`bad table: ${table}`); continue; }
        const doc = shared.sanitizeEvent(raw, { machineName, table, columnsOf: () => null });
        if (!Object.keys(doc).length) continue;
        if (!byTable.has(table)) byTable.set(table, []);
        byTable.get(table).push(doc);
      }

      let inserted = 0;
      for (const [table, docs] of byTable) {
        try {
          const res = await col(table).insertMany(docs, { ordered: false });
          inserted += res.insertedCount || 0;
        } catch (e) {
          const partial = e.insertedDocs?.length || e.result?.nInserted || 0;
          inserted += partial;
          if (!partial) errors.push(e.message);
        }
      }

      if (batchId) {
        try {
          await col('ingest_batches').updateOne(
            { batch_id: batchId },
            { $set: { machine_name: machineName || '', event_count: inserted, received_at: new Date().toISOString() } },
            { upsert: true }
          );
        } catch (e) { errors.push(e.message); }
      }

      return { success: true, inserted, duplicate: false, errors };
    },

    async ingestSingle({ table, data, machineName }) {
      if (!table || !data) throw badRequest('table and data required');
      if (!shared.ALLOWED_TABLES.has(table)) throw badRequest('table not allowed');
      const doc = shared.sanitizeEvent({ ...data, _table: table }, { machineName, table, columnsOf: () => null });
      if (!Object.keys(doc).length) throw badRequest('no valid columns');
      await col(table).insertOne(doc);
      return { success: true };
    },

    async upsertHeartbeat({ machineName, hostname, ip, agentVersion }) {
      await col('agent_heartbeat').updateOne(
        { machine_name: machineName },
        {
          $set: { hostname: hostname || '', ip: ip || '', agent_version: agentVersion || '' },
          $setOnInsert: { machine_name: machineName },
          $currentDate: { last_seen: true }
        },
        { upsert: true }
      );
      return { success: true, status: 'ok' };
    },

    async listHeartbeats() {
      const docs = await col('agent_heartbeat').find({}).sort({ last_seen: -1 }).toArray();
      return docs.map(mapDoc);
    },

    async maxApplicationStartTime() {
      const doc = await col('application_usage').find({}).sort({ start_time: -1 }).limit(1).project({ start_time: 1 }).toArray();
      return doc.length ? doc[0].start_time : null;
    },

    async cleanupFileActivities() {
      await col('file_activities').deleteMany({
        $or: [
          { file_path: { $regex: 'monitor\\.db', $options: 'i' } },
          { file_path: { $regex: 'windows monitoring software', $options: 'i' } }
        ]
      });
      return col('file_activities').countDocuments();
    },

    async appendAudit(entry) {
      try {
        await col('audit_log').insertOne({ ...entry, ts: entry.ts || new Date().toISOString() });
      } catch (e) { /* auditing must never break a request */ }
    },

    async listAudit(limit = 200) {
      try {
        const docs = await col('audit_log').find({}).sort({ _id: -1 }).limit(limit).toArray();
        return docs.map(mapDoc);
      } catch (e) {
        return [];
      }
    }
  };

  async function ensureIndexes() {
    const indexes = [
      ['ingest_batches', { batch_id: 1 }, { unique: true }],
      ['agent_heartbeat', { machine_name: 1 }, { unique: true }],
      ['application_usage', { start_time: 1 }],
      ['application_usage', { machine_name: 1 }],
      ['website_visits', { visit_time: 1 }],
      ['file_activities', { timestamp: 1 }],
      ['system_events', { timestamp: 1 }],
      ['screenshots', { timestamp: 1 }],
      ['usb_devices', { timestamp: 1 }],
      ['processes', { timestamp: 1 }],
      ['network_connections', { timestamp: 1 }]
    ];
    for (const [name, keys, options] of indexes) {
      try {
        await col(name).createIndex(keys, options);
      } catch (e) {
        console.warn(`[DB] Index creation failed on ${name}: ${e.message}`);
      }
    }
  }

  return api;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = { create };
