'use strict';
/**
 * POST /api/recognize/scale
 * Full 7599-raga Jaccard match using detected semitone sets from browser pyin.
 * Uses shrutiModel.js for swara/Western note display.
 * Ref: Subramanya et al. VIIRJ 2022, https://www.viirj.org/vol14issue1/5.pdf
 */
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { SEMI_TO_SWARA_PRIMARY, SEMI_TO_WESTERN } = require('../../core/ai/shrutiModel');

let _db = null;
function _getDB(){
  if(_db) return _db;
  _db = JSON.parse(fs.readFileSync(path.join(__dirname,'../../models/ragas_db.json'),'utf8'));
  console.log(`[scale] loaded ${_db.ragas.length} ragas`);
  return _db;
}
function jaccard(A,B){
  if(!A||!B||!A.length||!B.length) return 0;
  const s=new Set(B); let i=0;
  for(const x of A) if(s.has(x)) i++;
  return new Set([...A,...B]).size ? i/new Set([...A,...B]).size : 0;
}
function semisToSwara(semis){ return (semis||[]).map(s=>SEMI_TO_SWARA_PRIMARY[s]||`(${s})`).join(' '); }
function semisToWestern(semis){ return (semis||[]).map(s=>SEMI_TO_WESTERN[s]||'?').join(' / '); }

router.post('/', express.json(), (req,res)=>{
  try{
    const { ascSemis=[], descSemis=[], fileName='' } = req.body||{};
    if(!ascSemis.length&&!descSemis.length)
      return res.status(400).json({error:'ascSemis or descSemis required'});

    const db = _getDB();
    const scored = db.ragas.map(r=>{
      const aS = jaccard(ascSemis, r.as||[]);
      const vS = jaccard(descSemis, r.vs||[]);
      const exactA = aS===1.0 && ascSemis.length===(r.as||[]).length;
      const exactV = vS===1.0 && descSemis.length===(r.vs||[]).length;
      const exact  = exactA && exactV;
      return {r, aS, vS, exact, combined: exact?2.0:0.6*aS+0.4*vS};
    }).sort((a,b)=>b.combined-a.combined);

    const top3 = scored.slice(0,3).map(({r,aS,vS,exact,combined})=>({
      ref: r.ref, name: r.n, melakarta: r.m,
      aroha: r.a, avaroha: r.v,
      aroha_semis: r.as, avaroha_semis: r.vs,
      // Both Carnatic and Western notation for sheet music
      aroha_swara:  semisToSwara(r.as), avaroha_swara:  semisToSwara(r.vs),
      aroha_western:semisToWestern(r.as),avaroha_western:semisToWestern(r.vs),
      aScore:+aS.toFixed(4), vScore:+vS.toFixed(4),
      score:+Math.min(combined,1.0).toFixed(4),
      exact, confidence: exact?'high':combined>0.70?'medium':'low'
    }));

    const best = top3[0];
    res.json({
      raga: best.name, ref: best.ref, melakarta: best.melakarta,
      aroha: best.aroha, avaroha: best.avaroha, score: best.score,
      confidence: best.confidence, exactMatch: best.exact,
      top3,
      // What browser detected → both Carnatic and Western
      detectedAscSemis:  ascSemis,  detectedDescSemis:  descSemis,
      detectedAroha:     semisToSwara(ascSemis),
      detectedAvaroha:   semisToSwara(descSemis),
      detectedArohaWestern:  semisToWestern(ascSemis),
      detectedAvarohaWestern:semisToWestern(descSemis),
    });
  }catch(e){
    console.error('[scale]',e.message);
    res.status(500).json({error:e.message});
  }
});
module.exports = router;
