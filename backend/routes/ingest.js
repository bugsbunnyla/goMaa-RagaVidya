const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const path = require('path');

router.post('/', (req, res) => {
  const scriptPath = path.join(__dirname, '../../scripts/ingestDataset.js');
  execFile('node', [scriptPath], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: err.message, stderr });
    }
    res.json({ success: true, output: stdout });
  });
});

router.get('/status', async (req, res) => {
  try {
    const db = require('../../core/db/sqlite');
    await db.getDb();
    const count = db.get('SELECT COUNT(*) as n FROM music');
    const ragas = db.get('SELECT COUNT(DISTINCT raga) as n FROM music');
    res.json({ 
      songs: count?.n || 0, 
      distinctRagas: ragas?.n || 0,
      ready: (count?.n || 0) > 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
