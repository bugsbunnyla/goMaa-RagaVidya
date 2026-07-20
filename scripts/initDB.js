const db = require('../core/db/sqlite');

async function main() {
  try {
    console.log('🗄️  Initializing Music AI OS database...');
    await db.getDb();
    console.log('✅ Database initialized at models/music.db');
    console.log('   Run: npm run ingest  to populate with music data');
    process.exit(0);
  } catch (e) {
    console.error('❌ DB init failed:', e.message);
    process.exit(1);
  }
}

main();
