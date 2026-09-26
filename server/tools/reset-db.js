// Deletes the database file so the next start recreates it with fresh demo data.
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const dbPath = path.resolve(__dirname, '..', config.dbFile);
for (const suffix of ['', '-wal', '-shm']) {
  const f = dbPath + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log('Database removed. Run "npm start" to recreate it with demo data.');
