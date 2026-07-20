'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../../core/db/sqlite');
const { embedAudio } = require('../../core/ai/audioEmbedding');
const { searchANN }  = require('../../core/vector/annIndex');

// ── GET /api/search ───────────────────────────────────────────────────
router.get('/', async (req,res)=>{
  try {
    await db.getDb();
    const q     = (req.query.q||'').trim();
    const raga  = (req.query.raga||'').trim();
    const mood  = (req.query.mood||'').trim();
    const limit = Math.min(parseInt(req.query.limit)||40, 100);

    let sql = 'SELECT id,title,artist,raga,ragaNumber,aroha,avaroha,mood,tala,duration FROM music WHERE 1=1';
    const params = [];

    if (q)    { sql += ' AND (lower(title) LIKE ? OR lower(raga) LIKE ? OR lower(artist) LIKE ?)'; const lq=`%${q.toLowerCase()}%`; params.push(lq,lq,lq); }
    if (raga) { sql += ' AND lower(raga) LIKE ?'; params.push(`%${raga.toLowerCase()}%`); }
    if (mood) { sql += ' AND lower(mood) LIKE ?'; params.push(`%${mood.toLowerCase()}%`); }

    sql += ' ORDER BY title LIMIT ?'; params.push(limit);

    // also vector search if we have embeddings
    let vids = new Set();
    if (q) {
      const emb = embedAudio(q, 0);
      const vr  = searchANN(emb.vector, 20);
      vr.forEach(r=>vids.add(r.id));
    }

    const rows = db.all(sql, params);
    const seen = new Set(rows.map(r=>r.id));

    // append vector-only hits
    if (vids.size) {
      for (const vid of vids) {
        if (!seen.has(vid)) {
          const row = db.get('SELECT id,title,artist,raga,ragaNumber,aroha,avaroha,mood,tala,duration FROM music WHERE id=?',[vid]);
          if (row) { rows.push(row); seen.add(vid); }
        }
      }
    }

    res.json({ count:rows.length, results:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── GET /api/search/suggest?q=  — autocomplete ────────────────────────
router.get('/suggest', async(req,res)=>{
  try {
    await db.getDb();
    const q = (req.query.q||'').trim();
    if (!q || q.length < 2) return res.json([]);

    const lq = `%${q.toLowerCase()}%`;
    const items = [];

    // ragas
    const ragas = db.all(
      'SELECT DISTINCT raga, ragaNumber FROM music WHERE lower(raga) LIKE ? ORDER BY ragaNumber LIMIT 6',
      [lq]
    );
    ragas.forEach(r => items.push({ type:'raga', value:r.raga, number:r.ragaNumber }));

    // titles
    const titles = db.all(
      'SELECT title, raga FROM music WHERE lower(title) LIKE ? LIMIT 5', [lq]
    );
    titles.forEach(t => items.push({ type:'song', value:t.title, raga:t.raga }));

    // artists
    const artists = db.all(
      'SELECT DISTINCT artist FROM music WHERE lower(artist) LIKE ? AND artist IS NOT NULL LIMIT 4', [lq]
    );
    artists.forEach(a => items.push({ type:'artist', value:a.artist }));

    // also check knowledge base raga names (from server-side KB)
    const fs   = require('fs');
    const path = require('path');
    const kbPath = path.join(__dirname,'../../models/knowledge_base.json');
    const kb   = JSON.parse(fs.readFileSync(kbPath,'utf8'));
    const kbHits = kb.ragas.filter(r=>r.name.toLowerCase().includes(q.toLowerCase())).slice(0,4);
    kbHits.forEach(r=>{
      if(!items.find(i=>i.value===r.name))
        items.push({ type:'raga_kb', value:r.name, number:r.number });
    });

    res.json(items.slice(0,12));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── GET /api/search/ragas  — distinct ragas in library ───────────────
router.get('/ragas', async(req,res)=>{
  await db.getDb();
  res.json(db.all('SELECT DISTINCT raga,ragaNumber,aroha,avaroha,mood FROM music WHERE raga IS NOT NULL ORDER BY ragaNumber'));
});

module.exports = router;
