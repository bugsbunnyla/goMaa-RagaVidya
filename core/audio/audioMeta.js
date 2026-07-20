'use strict';
/**
 * audioMeta.js — Extract raga+tala from MP3/MP4/WAV/FLAC/OGG/WebM ID3 tags
 * Uses ffprobe. Primary detection — deterministic, no audio processing.
 * Source: karnatik.com tala table (35 talas + chapu)
 */
const { spawnSync } = require('child_process');

const TALA_MAP = {
  'adi':           {name:'Adi Tala',     beats:8, pattern:[4,2,2]},
  'aadi':          {name:'Adi Tala',     beats:8, pattern:[4,2,2]},
  'rupakam':       {name:'Rupakam',      beats:6, pattern:[2,4]},
  'roopakam':      {name:'Rupakam',      beats:6, pattern:[2,4]},
  'rupaka':        {name:'Rupakam',      beats:6, pattern:[2,4]},
  'misra chapu':   {name:'Misra Chapu',  beats:7, pattern:[3,2,2]},
  'misrachapu':    {name:'Misra Chapu',  beats:7, pattern:[3,2,2]},
  'mishrachapu':   {name:'Misra Chapu',  beats:7, pattern:[3,2,2]},
  'khanda chapu':  {name:'Khanda Chapu', beats:5, pattern:[2,3]},
  'khandachapu':   {name:'Khanda Chapu', beats:5, pattern:[2,3]},
  'jhampa':        {name:'Jhampa Tala',  beats:7, pattern:[4,1,2]},
  'ata':           {name:'Ata Tala',     beats:12,pattern:[4,4,2,2]},
  'dhruva':        {name:'Dhruva Tala',  beats:14,pattern:[4,2,4,4]},
  'tisra eka':     {name:'Tisra Eka',    beats:3, pattern:[3]},
  'tisraeka':      {name:'Tisra Eka',    beats:3, pattern:[3]},
};

function extractAudioMeta(filePath) {
  try {
    const r = spawnSync('ffprobe',['-v','quiet','-print_format','json',
      '-show_format',filePath],{encoding:'utf8',timeout:15000});
    if(r.status!==0||!r.stdout) return null;
    const tags = JSON.parse(r.stdout).format?.tags || {};
    const dur  = parseFloat(JSON.parse(r.stdout).format?.duration)||0;

    const get = (...keys) => keys.map(k=>tags[k]||tags[k.toUpperCase()]||'')
      .find(v=>v.trim())||'';

    const comment  = get('comment','description').replace(/\0/g,'').trim();
    const title    = get('title','TIT2').trim();
    const composer = get('composer','artist','TPE1').trim();

    // Parse raga + tala from comment or title
    let ragaHint=null, talaHint=null;
    const searchStr = (comment||title||'').toLowerCase();
    const talaKey   = Object.keys(TALA_MAP).find(k=>searchStr.includes(k));
    if(talaKey) talaHint = TALA_MAP[talaKey];

    // Raga = comment minus tala words
    if(comment && comment.length<60 && !comment.includes('http')){
      ragaHint = talaKey
        ? comment.replace(new RegExp(talaKey,'i'),'').replace(/[-–,\s]+/g,' ').trim()
        : comment.length < 40 ? comment : null;
    }
    if(!ragaHint && title && title.length<50) ragaHint = title;

    return { title, composer, duration:+dur.toFixed(2),
             comment, ragaHint, talaHint, allTags:tags };
  } catch(_){ return null; }
}

function parseTala(str){
  if(!str) return null;
  const key=Object.keys(TALA_MAP).find(k=>str.toLowerCase().includes(k));
  return key?TALA_MAP[key]:null;
}

module.exports = { extractAudioMeta, parseTala, TALA_MAP };
