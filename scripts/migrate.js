require('dotenv').config();
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

migrate()
  .then(async (applied) => {
    if (applied.length === 0) console.log('Database schema is up to date.');
    await db.pool.end();
  })
  .catch(async (err) => {
    console.error('Migration failed:', err);
    try { await db.pool.end(); } catch (closeErr) { /* already failing */ }
    process.exit(1);
  });
