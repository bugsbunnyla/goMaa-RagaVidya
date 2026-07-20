'use strict';
/**
 * /api/compose  v3
 * Fix: searches ragas_db.json (7599 ragas) with fuzzy case-insensitive matching
 * so kOkilapriyaa (#11) and raamapriyaA (#52) resolve correctly — not fallback to kb[28].
 */
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../../core/db/sqlite');
const { generateSheetMusicXml, generateMidi } = require('../../core/ai/sheetMusicEngine');
const fs   = require('fs');
const path = require('path');

// ── Load full raga DB (7599) once ────────────────────────────────────
let _ragaDB = null;
function _loadRagaDB() {
  if (_ragaDB) return _ragaDB;
  const p = path.join(__dirname,'../../models/ragas_db.json');
  if (fs.existsSync(p)) {
    const db = JSON.parse(fs.readFileSync(p,'utf8'));
    _ragaDB = db.ragas;
  } else {
    // fallback: knowledge_base.json → remap fields
    const kb = JSON.parse(fs.readFileSync(
      path.join(__dirname,'../../models/knowledge_base.json'),'utf8'));
    _ragaDB = kb.ragas.map(r=>({
      n:r.name, m:r.number, j:0, a:r.aroha, v:r.avaroha,
      c:r.chroma, as:[], vs:[], ref:r.number,
      mood:r.mood, gamakas:r.gamakas||[], chakra:r.chakra
    }));
  }
  return _ragaDB;
}

// Chakra names for melakarta number
const CHAKRAS = ['Indu','Netra','Agni','Veda','Bana','Ritu','Rishi','Vasu','Brahma','Disi','Rudra','Aditya'];
function chakraForMela(m) { return CHAKRAS[Math.floor((m-1)/6)] || ''; }

// Mood / gamaka lookup for well-known ragas
const MOOD_MAP = {
  'bilahari':'joyful','mohanam':'romantic','hamsadhwani':'auspicious',
  'bhairavi':'devotional','todi':'devotional','kalyaani':'romantic',
  'mechakalyani':'romantic','kambhoji':'charming','hindolam':'devotional',
  'anandabhairavi':'tender','kedaram':'grand','madhyamavati':'serene',
  'abheri':'devotional','husseini':'pathos','saveri':'devotional',
  'charukesi':'tender','harikamboji':'charming','shankarabharanam':'majestic',
  'dheerasankarabharanam':'majestic','kharaharapriya':'versatile',
  'hanumatodi':'devotional','mayamalavagowla':'solemn','natabhairavi':'grand',
  'keeravani':'melancholic','ramapriya':'pleasing','raamapriya':'pleasing',
  'kokilapriya':'playful','kOkilapriyaA':'playful','raamapriyaA':'pleasing',
};
function moodFor(name){ return MOOD_MAP[name.toLowerCase().replace(/[\s_-]/g,'')] || 'meditative'; }
const GAMAKA_MAP = {
  'bhairavi':['kampita','andola'],'todi':['kampita','andola'],
  'kalyaani':['kampita','spurita'],'mechakalyani':['kampita','spurita'],
  'bilahari':['kampita','spurita'],'harikamboji':['kampita','spurita'],
  'shankarabharanam':['kampita','spurita','andola'],
};
function gamakaFor(name){ return GAMAKA_MAP[name.toLowerCase().replace(/[\s_-]/g,'')] || ['kampita']; }

// ── Fuzzy raga lookup ─────────────────────────────────────────────────
function findRaga(requestedName) {
  const ragas = _loadRagaDB();
  const norm = s => s.toLowerCase()
    .replace(/aa/g,'A').replace(/ii/g,'I').replace(/uu/g,'U')
    .replace(/[^a-z0-9]/g,'');
  const query = norm(requestedName);

  // 1. Exact (normalised) match
  let hit = ragas.find(r => norm(r.n) === query);
  if (hit) return hit;

  // 2. Starts-with match (longest first)
  const starts = ragas.filter(r => norm(r.n).startsWith(query) || query.startsWith(norm(r.n)));
  if (starts.length) {
    starts.sort((a,b) => Math.abs(norm(a.n).length - query.length) - Math.abs(norm(b.n).length - query.length));
    return starts[0];
  }

  // 3. Contains match
  const contains = ragas.filter(r => norm(r.n).includes(query) || query.includes(norm(r.n)));
  if (contains.length) return contains[0];

  // 4. Fallback: parse melakarta number from string like "raamapriyaA (#52)"
  const numMatch = requestedName.match(/#(\d+)/);
  if (numMatch) {
    const mela = parseInt(numMatch[1]);
    const melaEntry = ragas.find(r => r.m === mela && r.j === 0);
    if (melaEntry) return melaEntry;
    const anyMela = ragas.find(r => r.m === mela);
    if (anyMela) return anyMela;
  }

  // 5. Absolute fallback — Adi tala favourite (Harikamboji #28)
  console.warn(`compose: raga "${requestedName}" not found — using Harikamboji fallback`);
  return ragas.find(r => r.m === 28 && r.j === 0) || ragas[0];
}

// Build tala info for response
const TALA_DB = {
  'Adi (8 beats)':         { beats:8,  groups:[4,2,2],    tradition:'carnatic' },
  'Rupaka (6 beats)':      { beats:6,  groups:[4,2],      tradition:'carnatic' },
  'Misra Chapu (7 beats)': { beats:7,  groups:[3,2,2],    tradition:'carnatic' },
  'Khanda Chapu (5 beats)':{ beats:5,  groups:[2,3],      tradition:'carnatic' },
  'Jhampai (10 beats)':    { beats:10, groups:[7,1,2],    tradition:'carnatic' },
  'Dhruva (14 beats)':     { beats:14, groups:[4,2,4,4],  tradition:'carnatic' },
  'Matya (9 beats)':       { beats:9,  groups:[4,2,3],    tradition:'carnatic' },
  'Triputa (7 beats)':     { beats:7,  groups:[4,2,2],    tradition:'carnatic' },
  'Eka (4 beats)':         { beats:4,  groups:[4],        tradition:'carnatic' },
  'Tisra Triputa (7 beats)':{ beats:7, groups:[3,2,2],    tradition:'carnatic' },
  'Teental (16 beats)':    { beats:16, groups:[4,4,4,4],  tradition:'hindustani' },
  'Ektal (12 beats)':      { beats:12, groups:[2,2,2,2,2,2],tradition:'hindustani'},
  'Jhaptal (10 beats)':    { beats:10, groups:[2,3,2,3],  tradition:'hindustani' },
};

router.post('/', express.json(), async (req,res)=>{
  try {
    await db.getDb();
    const {
      title = 'Untitled Composition',
      raga, tala = 'Adi (8 beats)', tempo = 80,
      instruments = ['veena','mridangam'],
      lyrics = '', language = 'Telugu', sections = {}
    } = req.body || {};

    if (!raga) return res.status(400).json({ error:'raga required' });

    // ── Find the exact raga from the 7599-entry DB ──────────────────
    const ragaEntry = findRaga(raga);
    const ragaName  = ragaEntry.n;
    const melakarta = ragaEntry.m;
    const aroha     = ragaEntry.a;
    const avaroha   = ragaEntry.v;
    const mood      = ragaEntry.mood || moodFor(ragaName);
    const gamakas   = ragaEntry.gamakas || gamakaFor(ragaName);
    const chakra    = ragaEntry.chakra  || chakraForMela(melakarta);

    const ragaObj = {
      label: ragaName, ragaNumber: melakarta,
      chakra, aroha, avaroha, mood, gamakas,
    };

    // Generate sheet music with user lyrics
    const compOpts = {
      title,
      tala,
      sections: {
        pallavi:    sections.pallavi    || lyrics || `${title} — Pallavi`,
        anupallavi: sections.anupallavi || `${title} — Anupallavi`,
        charanam:   sections.charanam   || `${title} — Charanam`,
      }
    };

    const xml  = generateSheetMusicXml(ragaObj, compOpts);
    const midi = generateMidi(ragaObj, { instruments, tempo });
    const id   = crypto.randomBytes(8).toString('hex');

    // Save composition
    db.run(
      `INSERT OR REPLACE INTO compositions
       (id,title,raga,tala,tempo,instruments,lyrics,sheetMusicXml,midiB64,createdAt)
       VALUES(?,?,?,?,?,?,?,?,?,strftime('%s','now'))`,
      [id, title, ragaName, tala, tempo,
       JSON.stringify(instruments), lyrics, xml, midi]
    );

    const talaInfo = TALA_DB[tala] || { beats:8, groups:[4,2,2], tradition:'carnatic' };

    res.json({
      id, title,
      raga:       ragaName,        // ← the SELECTED raga, not a fallback
      ragaNumber: melakarta,
      chakra,
      tala, tempo, instruments, lyrics, language,
      aroha, avaroha, mood, gamakas,
      talaInfo,
      sheetMusicXml: xml,
      midiB64: midi,
      sections: {
        pallavi:    sections.pallavi    || lyrics || `${title} — Pallavi`,
        anupallavi: sections.anupallavi || `${title} — Anupallavi`,
        charanam:   sections.charanam   || `${title} — Charanam`,
      },
      createdAt: new Date().toISOString(),
    });
  } catch(e) {
    console.error('compose:', e);
    res.status(500).json({ error:e.message });
  }
});

// GET /api/compose
router.get('/', async (req,res)=>{
  await db.getDb();
  const rows = db.all('SELECT id,title,raga,tala,tempo,instruments,createdAt FROM compositions ORDER BY createdAt DESC LIMIT 50');
  res.json({ count:rows.length, compositions:rows.map(r=>({...r,instruments:tryParse(r.instruments,[])})) });
});

// GET /api/compose/:id
router.get('/:id', async (req,res)=>{
  await db.getDb();
  const row = db.get('SELECT * FROM compositions WHERE id=?',[req.params.id]);
  if(!row) return res.status(404).json({error:'not found'});
  res.json({...row, instruments:tryParse(row.instruments,[])});
});

// GET /api/ragas-full — all ragas for compose dropdown (v3 full DB)
router.get('/ragas/all', async (req,res)=>{
  const ragas = _loadRagaDB();
  // Return id(ref), name, melakarta, aroha, avaroha
  const out = ragas.map(r=>({ref:r.ref,n:r.n,m:r.m,j:r.j,a:r.a,v:r.v}));
  res.json({ count:out.length, ragas:out });
});

function tryParse(s,d){ try{return JSON.parse(s);}catch(_){return d;} }
module.exports = router;
