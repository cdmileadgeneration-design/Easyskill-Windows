const initSqlJs = require('./node_modules/sql.js');
const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'database', 'monitor.db');

console.log('Migrating database...');

initSqlJs().then(SQL => {
    const db = new SQL.Database(fs.readFileSync(dbPath));
    
    // Add machine_name to screenshots table
    try {
        db.run("ALTER TABLE screenshots ADD COLUMN machine_name TEXT");
        console.log('Added machine_name to screenshots table');
    } catch (e) {
        console.log('screenshots.machine_name already exists or error:', e.message);
    }
    
    // Add user_name to usb_devices table
    try {
        db.run("ALTER TABLE usb_devices ADD COLUMN user_name TEXT");
        console.log('Added user_name to usb_devices table');
    } catch (e) {
        console.log('usb_devices.user_name already exists or error:', e.message);
    }
    
    // Add user_name to system_events table
    try {
        db.run("ALTER TABLE system_events ADD COLUMN user_name TEXT");
        console.log('Added user_name to system_events table');
    } catch (e) {
        console.log('system_events.user_name already exists or error:', e.message);
    }
    
    // Save the database
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    db.close();
    
    console.log('Database migration complete!');
}).catch(err => {
    console.error('Error:', err);
});
