const initSqlJs = require('./node_modules/sql.js');
const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'database', 'monitor.db');

console.log('Looking for database at:', dbPath);

if (!fs.existsSync(dbPath)) {
    console.log('Database file does not exist');
    process.exit(1);
}

initSqlJs().then(SQL => {
    const db = new SQL.Database(fs.readFileSync(dbPath));
    
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('Tables:');
    
    if (tables.length > 0) {
        tables[0].values.forEach(row => {
            const tableName = row[0];
            console.log('\n' + tableName + ':');
            const schema = db.exec('PRAGMA table_info(' + tableName + ')');
            if (schema.length > 0) {
                schema[0].values.forEach(col => {
                    console.log('  ' + col[1] + ' (' + col[2] + ')');
                });
            }
        });
    }
    
    db.close();
}).catch(err => {
    console.error('Error:', err);
});
