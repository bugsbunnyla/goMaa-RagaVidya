'use strict';
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit:'20mb' }));
app.use(express.urlencoded({ extended:true }));

// static SPA
app.use(express.static(path.join(__dirname,'../apps/web')));

// ── API ──────────────────────────────────────────────────────────────
app.use('/api/recognize', require('./routes/recognize'));
app.use('/api/search',    require('./routes/search'));
app.use('/api/compose',   require('./routes/compose'));
app.use('/api/dataset',   require('./routes/dataset'));
app.use('/api/ingest',    require('./routes/ingest'));
app.use('/api/recognize/scale', require('./routes/scale'));
app.use('/api/transcribe',      require('./routes/transcribe'));

app.get('/api/health', (_req,res)=>{
  res.json({ status:'ok', app:'GoMaa Raga Vidya v1', version:'1.0.0',
             timestamp:new Date().toISOString() });
});
app.get('/api/ragas', (_req,res)=>{
  res.json(require('../models/knowledge_base.json'));
});

// download sheet XML
app.get('/api/sheet/:compositionId', async(req,res)=>{
  const db = require('../core/db/sqlite');
  await db.getDb();
  const row = db.get('SELECT sheetMusicXml,title FROM compositions WHERE id=?',[req.params.compositionId]);
  if(!row||!row.sheetMusicXml) return res.status(404).send('not found');
  res.setHeader('Content-Type','application/xml');
  res.setHeader('Content-Disposition',`attachment; filename="${(row.title||'composition').replace(/[^a-z0-9]/gi,'_')}.musicxml"`);
  res.send(row.sheetMusicXml);
});

// download MIDI
app.get('/api/midi/:compositionId', async(req,res)=>{
  const db = require('../core/db/sqlite');
  await db.getDb();
  const row = db.get('SELECT midiB64,title FROM compositions WHERE id=?',[req.params.compositionId]);
  if(!row||!row.midiB64) return res.status(404).send('not found');
  res.setHeader('Content-Type','audio/midi');
  res.setHeader('Content-Disposition',`attachment; filename="${(row.title||'composition').replace(/[^a-z0-9]/gi,'_')}.mid"`);
  res.send(Buffer.from(row.midiB64,'base64'));
});

// SPA fallback
app.get('*',(_req,res)=>{
  res.sendFile(path.join(__dirname,'../apps/web/index.html'));
});

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n🎼  GoMaa Raga Vidya  →  http://localhost:${PORT}\n`);
});
module.exports=app;
