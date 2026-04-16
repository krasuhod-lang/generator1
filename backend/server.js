require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./src/config/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/auth', require('./src/routes/auth.routes'));
app.use('/api/tasks', require('./src/routes/tasks.routes'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Run migrations
async function runMigrations() {
  try {
    const migrationPath = path.resolve(__dirname, '../migrations/001_initial_schema.sql');
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      await db.query(sql);
      console.log('[migrations] Schema applied successfully');
    }
  } catch (err) {
    console.error('[migrations] Error:', err.message);
  }
}

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] SEO Genius backend running on port ${PORT}`);
  });
});
