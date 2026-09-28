// Datastore factory.
//
// Two interchangeable backends implement the same repository interface:
//   - mongodb : production / AWS ready (DB_PROVIDER=mongodb, MONGODB_URI=...)
//   - sqlite  : offline fallback using sql.js (DB_PROVIDER=sqlite)
//
// Routes only ever talk to this interface, so switching providers is a config
// change - and a future DynamoDB backend can be added the same way.
const {
  ALLOWED_TABLES,
  isValidIdentifier,
  escapeRegex,
  machineClauseSql,
  machineMatchMongo,
  dateClauseSql,
  dateMatchMongo,
  dayRange,
  sanitizeEvent
} = require('./shared');

const shared = {
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

function createDatastore(cfg) {
  const provider = (cfg.database?.provider || 'sqlite').toLowerCase();

  if (provider === 'mongodb' || provider === 'mongo') {
    if (!cfg.database?.mongodbUri) {
      throw new Error('DB_PROVIDER=mongodb but MONGODB_URI is empty - set it in .env or config.json');
    }
    return require('./mongo').create(cfg, shared);
  }
  if (provider === 'sqlite' || provider === 'sql.js' || provider === 'local') {
    return require('./sqlite').create(cfg, shared);
  }
  throw new Error(`Unknown DB_PROVIDER "${provider}" (expected: mongodb, sqlite)`);
}

module.exports = { createDatastore };
