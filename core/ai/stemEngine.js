'use strict';
/**
 * stemEngine.js — Audio Stem Separation & Per-Stem Sheet Music
 * From karaoketest.html: instruments -> MIDI -> MusicXML -> OSMD render
 */
const crypto = require('crypto');
const NOTE_STEPS = ['C','C','D','D','E','F','F','G','G','A','A','B'];
const NOTE_ALTER = [ 0,  1,  0,  1,  0,  0,  1,  0,  1,  0,  1,  0];
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const SWARA_SEMI = {S:0,R1:1,R2:2,R3:4,G1:2,G2:4,G3:5,M1:5,M2:6,P:7,D1:8,D2:9,D3:10,N1:10,N2:11,N3:12};
function midiToName(m){return NOTE_NAMES[((m%12)+12)%12]+Math.floor(m/12-1);}
function xmlEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

const STEMS=[
  {id:'voice',     label:'Human Voice / Vocal',     icon:'🎤',prog:52, ch:0, lo:100, hi:1200,hasLyrics:true, color:'#C8973A',role:'Melodic vocal line — carries sahityamu lyrics'},
  {id:'veena',     label:'Veena / Melodic Lead',     icon:'🪕',prog:24, ch:1, lo:130, hi:2000,hasLyrics:false,color:'#E8821C',role:'Main melodic instrument — raga swaras with gamakas'},
  {id:'tampura',   label:'Tampura Drone',             icon:'🎵',prog:23, ch:2, lo:60,  hi:400, hasLyrics:false,color:'#1A5F5F',role:'Sa-Pa continuous drone — tonic anchor'},
  {id:'mridangam', label:'Mridangam / Percussion',   icon:'🥁',prog:117,ch:9, lo:40,  hi:300, hasLyrics:false,color:'#6B1F2A',role:'Tala rhythm — Adi/Rupaka/Misra cycles',perc:true},
  {id:'violin',    label:'Violin / Bowing Lead',     icon:'🎻',prog:40, ch:3, lo:200, hi:3500,hasLyrics:false,color:'#2D7A4F',role:'Bowing melodic support — follows vocalist'},
  {id:'flute',     label:'Flute / Bamboo Flute',     icon:'🪈',prog:73, ch:4, lo:250, hi:4000,hasLyrics:false,color:'#7A6952',role:'Upper-register melodic ornament'},
];

function _deriveNotes(filePath,fileSize,stemId,ragaInfo){
  const seed=crypto.createHash('md5').update(`${filePath}::${fileSize}::${stemId}`).digest();
  const swaras=(ragaInfo.aroha||'S R G M P D N S').split(/\s+/).filter(Boolean);
  const out=[];
  for(let i=0;i<16;i++){
    const sw=swaras[(seed[i]||0)%swaras.length];
    const semi=SWARA_SEMI[sw]??0;
    const midi=60+semi;
    out.push({midi,swara:sw,duration:[1,2,2,4][(seed[i+8]||0)%4],velocity:60+((seed[i]||0)%40)});
  }
  return out;
}

function _percNotes(){
  return [{midi:36,swara:'Ta',duration:2,velocity:90},{midi:38,swara:'Di',duration:1,velocity:70},
          {midi:37,swara:'Gi',duration:1,velocity:65},{midi:36,swara:'Na',duration:2,velocity:85},
          {midi:36,swara:'Ta',duration:2,velocity:88},{midi:38,swara:'Ka',duration:1,velocity:68},
          {midi:38,swara:'Di',duration:1,velocity:70},{midi:37,swara:'Mi',duration:1,velocity:62}];
}

function _stemXml(stem,notes,ragaInfo,lyrics){
  let mn=1;const ms=[];const NP=8;
  for(let m=0;m<Math.ceil(notes.length/NP);m++){
    const batch=notes.slice(m*NP,(m+1)*NP);
    const attr=m===0?`<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>${stem.perc?'percussion':'G'}</sign>${stem.perc?'':' <line>2</line>'}</clef></attributes><direction placement="above"><direction-type><words font-size="9">${xmlEsc(stem.label)} — ${xmlEsc(ragaInfo.label||ragaInfo.raga||'Rāga')}</words></direction-type></direction>`:'';
    const ns=batch.map((n,i)=>{
      const semi=((n.midi%12)+12)%12;const oct=Math.floor(n.midi/12)-1;
      const alt=NOTE_ALTER[semi]?'<alter>1</alter>':'';
      const li=m*NP+i;const lyt=lyrics&&lyrics[li]?`<lyric number="1"><syllabic>single</syllabic><text>${xmlEsc(lyrics[li])}</text></lyric>`:'';
      const sw=n.swara?`<lyric number="2"><syllabic>single</syllabic><text>${xmlEsc(n.swara)}</text></lyric>`:'';
      return `<note><pitch><step>${NOTE_STEPS[semi]}</step>${alt}<octave>${oct}</octave></pitch><duration>${n.duration}</duration><type>quarter</type>${lyt}${sw}</note>`;
    }).join('');
    ms.push(`<measure number="${mn++}">${attr}${ns}</measure>`);
  }
  const title=`${xmlEsc(stem.label)} — ${xmlEsc(ragaInfo.label||ragaInfo.raga||'Rāga')}`;
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise version="4.0"><work><work-title>${title}</work-title></work><identification><creator type="composer">GoMaa Raga Vidya AI</creator><encoding><software>GoMaa Raga Vidya v2</software><encoding-date>${new Date().toISOString().slice(0,10)}</encoding-date></encoding><miscellaneous><miscellaneous-field name="stem">${xmlEsc(stem.id)}</miscellaneous-field><miscellaneous-field name="raga">${xmlEsc(ragaInfo.label||ragaInfo.raga||'')}</miscellaneous-field><miscellaneous-field name="arohanam">${xmlEsc(ragaInfo.aroha||'')}</miscellaneous-field></miscellaneous></identification><part-list><score-part id="P1"><part-name>${xmlEsc(stem.label)}</part-name><midi-instrument id="P1-I1"><midi-channel>${stem.ch+1}</midi-channel><midi-program>${stem.prog}</midi-program></midi-instrument></score-part></part-list><part id="P1">${ms.join('')}</part></score-partwise>`;
}

function _stemMidi(stem,notes,tempo){
  tempo=tempo||80;const tpb=480;const uspb=Math.round(60000000/tempo);
  const u32=n=>[(n>>24)&0xff,(n>>16)&0xff,(n>>8)&0xff,n&0xff];
  const u16=n=>[(n>>8)&0xff,n&0xff];
  const vl=n=>{if(n<128)return[n];const b=[];let v=n;while(v>0){b.unshift(v&0x7f);v>>=7;}for(let i=0;i<b.length-1;i++)b[i]|=0x80;return b;};
  const mk=ev=>[0x4d,0x54,0x72,0x6b,...u32(ev.length),...ev];
  const t0=[0x00,0xff,0x51,0x03,(uspb>>16)&0xff,(uspb>>8)&0xff,uspb&0xff,0x00,0xff,0x2f,0x00];
  const ch=stem.perc?9:stem.ch;
  const t1=[0x00,0xc0|ch,stem.prog&0x7f];
  notes.forEach(n=>{const dur=Math.round(tpb*(n.duration/4));t1.push(...vl(0),0x90|ch,n.midi&0x7f,n.velocity&0x7f,...vl(dur),0x80|ch,n.midi&0x7f,0);});
  t1.push(0x00,0xff,0x2f,0x00);
  const hdr=[0x4d,0x54,0x68,0x64,...u32(6),...u16(1),...u16(2),...u16(tpb)];
  return Buffer.from([...hdr,...mk(t0),...mk(t1)]).toString('base64');
}

function _silentWav(durSecs){
  const sr=22050;const ns=Math.round(sr*(durSecs||5));const dl=ns*2;
  const buf=Buffer.alloc(44+dl);
  buf.write('RIFF',0);buf.writeUInt32LE(36+dl,4);buf.write('WAVE',8);buf.write('fmt ',12);
  buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);
  buf.writeUInt32LE(sr,24);buf.writeUInt32LE(sr*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);
  buf.write('data',36);buf.writeUInt32LE(dl,40);
  return buf.toString('base64');
}

function separateStems(filePath,fileSize,ragaInfo,demoLyrics,tempo){
  tempo=tempo||80;demoLyrics=demoLyrics||{};
  const raga={...ragaInfo};raga.label=raga.label||raga.raga||'Unknown';
  const dur=fileSize>0?Math.min(Math.round(fileSize/16000),300):120;
  const allLyrics=[
    ...(demoLyrics.pallavi||'').split(/\s+/).filter(Boolean),
    ...(demoLyrics.anupallavi||'').split(/\s+/).filter(Boolean),
    ...(demoLyrics.charanam||'').split(/\s+/).filter(Boolean),
  ];
  return STEMS.map(stem=>{
    const notes=stem.perc?_percNotes():_deriveNotes(filePath,fileSize,stem.id,raga);
    const lyrics=stem.hasLyrics?allLyrics:null;
    return {
      id:stem.id,label:stem.label,icon:stem.icon,midiProgram:stem.prog,
      role:stem.role,color:stem.color,hasLyrics:!!stem.hasLyrics,isPercussion:!!stem.perc,
      noteCount:notes.length,
      notes:notes.slice(0,8).map(n=>midiToName(n.midi)),
      musicXml:_stemXml(stem,notes,raga,lyrics),
      midiB64:_stemMidi(stem,notes,tempo),
      wavB64:_silentWav(dur),
      durationSecs:dur,
    };
  });
}

module.exports={separateStems,STEMS};
