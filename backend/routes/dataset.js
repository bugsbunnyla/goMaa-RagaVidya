'use strict';
/**
 * /api/dataset  — dashboard-driven dataset loading
 * Accepts: MP3 folder scan, JSON knowledge-base upload, notation XML upload
 */
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const db       = require('../../core/db/sqlite');
const { detectRaga }   = require('../../core/ai/ragaModel');
const { embedAudio }   = require('../../core/ai/audioEmbedding');
const { generateFingerprint } = require('../../core/audio/fingerprint');
const { addToIndex }   = require('../../core/vector/annIndex');

const DS_DIR = path.join(__dirname,'../../datasets');
const upload = multer({ dest: path.join(DS_DIR,'uploads'), limits:{fileSize:200*1024*1024} });

// ── GET  /api/dataset/status ──────────────────────────────────────────
router.get('/status', async(req,res)=>{
  await db.getDb();
  const songs  = db.get('SELECT COUNT(*) n FROM music');
  const ragas  = db.get('SELECT COUNT(DISTINCT raga) n FROM music');
  const comps  = db.get('SELECT COUNT(*) n FROM compositions');
  const dirs   = ['audio','saraga_mp3','notation','mp3']
    .map(d=>path.join(DS_DIR,d))
    .filter(d=>fs.existsSync(d))
    .map(d=>({
      path:d,
      files: fs.readdirSync(d).filter(f=>/\.(mp3|wav|flac|ogg|xml|json|mxl)$/i.test(f)).length
    }));
  res.json({ songs:songs?.n||0, distinctRagas:ragas?.n||0,
             compositions:comps?.n||0, dirs });
});

// ── POST /api/dataset/scan  — scan local folder ───────────────────────
router.post('/scan', express.json(), async(req,res)=>{
  await db.getDb();
  const { folder } = req.body||{};
  const target = folder ? path.resolve(folder) : DS_DIR;
  if (!fs.existsSync(target)) return res.status(404).json({error:`Folder not found: ${target}`});

  const files=[]; _walk(target, files, 4);
  let inserted=0, skipped=0, errors=0;
  for(const {fp,sz} of files){
    try {
      const id=crypto.createHash('md5').update(fp).digest('hex');
      if(db.get('SELECT id FROM music WHERE id=?',[id])){ skipped++; continue; }
      const buf = fs.existsSync(fp) ? fs.readFileSync(fp) : null;
      const raga=detectRaga(fp,sz,buf);
      const emb =embedAudio(fp,sz,null);
      const title=path.basename(fp,path.extname(fp)).replace(/[-_]+/g,' ').trim();
      db.run(
        `INSERT OR REPLACE INTO music(id,title,raga,ragaNumber,aroha,avaroha,mood,gamakas,duration,filePath,embedding,createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))`,
        [id,title,raga.label,raga.ragaNumber,raga.aroha,raga.avaroha,raga.mood,
         JSON.stringify(raga.gamakas||[]), Math.round(sz/16000), fp, JSON.stringify(emb.vector)]
      );
      db.run('INSERT OR REPLACE INTO fingerprint(hash,music_id)VALUES(?,?)',
        [generateFingerprint(fp).hash, id]);
      addToIndex(id,emb.vector,{title,raga:raga.label});
      inserted++;
    } catch(e){ errors++; }
  }
  res.json({ scanned:files.length, inserted, skipped, errors });
});

// ── POST /api/dataset/upload  — upload file(s) from browser ──────────
router.post('/upload', upload.array('files',50), async(req,res)=>{
  await db.getDb();
  const results=[];
  for(const f of req.files||[]){
    const ext=path.extname(f.originalname||'').toLowerCase();
    try {
      if(/\.(mp3|wav|flac|ogg|webm)$/.test(ext)){
        // audio file → ingest
        const dest=path.join(DS_DIR,'audio',f.originalname||f.filename+ext);
        fs.mkdirSync(path.dirname(dest),{recursive:true});
        fs.renameSync(f.path,dest);
        const sz=fs.statSync(dest).size;
        const buf=fs.readFileSync(dest);
        const id=crypto.createHash('md5').update(dest).digest('hex');
        const raga=detectRaga(dest,sz,buf);
        const emb=embedAudio(dest,sz,null);
        const title=path.basename(dest,ext).replace(/[-_]+/g,' ').trim();
        db.run(
          `INSERT OR REPLACE INTO music(id,title,raga,ragaNumber,aroha,avaroha,mood,gamakas,duration,filePath,embedding,createdAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))`,
          [id,title,raga.label,raga.ragaNumber,raga.aroha,raga.avaroha,raga.mood,
           JSON.stringify(raga.gamakas||[]),Math.round(sz/16000),dest,JSON.stringify(emb.vector)]
        );
        addToIndex(id,emb.vector,{title,raga:raga.label});
        results.push({file:f.originalname,type:'audio',status:'ingested',raga:raga.label});
      } else if(ext==='.json'){
        // knowledge base JSON
        const txt=fs.readFileSync(f.path,'utf8');
        const data=JSON.parse(txt);
        fs.unlinkSync(f.path);
        results.push({file:f.originalname,type:'knowledge_base',status:'parsed',
                      ragas:data.ragas?.length||0});
      } else if(/\.(xml|mxl|musicxml)$/.test(ext)){
        // notation file → store
        const dest=path.join(DS_DIR,'notation',f.originalname||f.filename+ext);
        fs.mkdirSync(path.dirname(dest),{recursive:true});
        fs.renameSync(f.path,dest);
        results.push({file:f.originalname,type:'notation',status:'saved',path:dest});
      } else {
        fs.unlinkSync(f.path);
        results.push({file:f.originalname,type:'unknown',status:'skipped'});
      }
    } catch(e){ results.push({file:f.originalname,status:'error',error:e.message}); }
  }
  res.json({ uploaded:req.files?.length||0, results });
});

function _walk(dir,out,maxDepth,depth=0){
  if(depth>maxDepth||!fs.existsSync(dir)) return;
  for(const e of fs.readdirSync(dir)){
    const fp=path.join(dir,e);
    try {
      const st=fs.statSync(fp);
      if(st.isDirectory()) _walk(fp,out,maxDepth,depth+1);
      else if(/\.(mp3|wav|flac|ogg)$/i.test(e)) out.push({fp,sz:st.size});
    } catch(_){}
  }
}

module.exports = router;
