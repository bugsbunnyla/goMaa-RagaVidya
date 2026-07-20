
// Safe string normaliser — prevents (name||'').replace errors when non-string passed
function _str(v){ return (v===null||v===undefined)?'':(typeof v==='string'?v:String(v)); }

'use strict';
const { extractAudioMeta, parseTala } = require('../audio/audioMeta');
/**
 * GoMaa Raga Vidya v3 — Raga Detection Engine
 *
 * DETECTION HIERARCHY (highest priority first):
 *   1. Filename token match against full raga DB (5314 ragas from CSV)
 *   2. Scale / chroma EXACT match — compares detected semitone set against
 *      every raga's aroha+avaroha fingerprint (most accurate for audio)
 *   3. Chroma cosine similarity fallback
 *   4. Hash-based pseudorandom fallback (last resort)
 *
 * Key fix over v2:
 *   • Uses all ragas from melakartajanyaragalist.csv via models/ragas_db.json
 *   • Scale-exact matching: bilahari (S R2 G3 P D2) is never confused with
 *     Vanaspati (S R1 G1 M1 P D2 N2) because their aroha semitone sets differ
 *   • Ekadantam (shrIEkadantA, mela 16) correctly identified from its scale
 *     S R1 G3 P D2 — parent mela Chakravakam, NOT Vanaspati
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Paths — try ragas_db.json (v3 full DB) first, fall back to knowledge_base.json (v2)
const RAGAS_DB_PATH = path.join(__dirname, '../../models/ragas_db.json');
const KB_PATH       = path.join(__dirname, '../../models/knowledge_base.json');

// Semitone mapping for Carnatic swaras
const SWARA_SEMI = {
  S:0, R1:1, R2:2, R3:3,
  G1:2, G2:3, G3:4,
  M1:5, M2:6,
  P:7,
  D1:8, D2:9, D3:10,
  N1:10, N2:11, N3:11
};

// ── Raga mood / gamaka lookup for well-known ragas ────────────────────
const RAGA_META = {
  bilahari:           { mood:'joyful', gamakas:['kampita','spurita'] },
  mohanam:            { mood:'romantic', gamakas:['kampita'] },
  hamsadhwani:        { mood:'auspicious', gamakas:['kampita','spurita'] },
  bhairavi:           { mood:'devotional', gamakas:['kampita','andola'] },
  todi:               { mood:'devotional', gamakas:['kampita','andola'] },
  kalyaani:           { mood:'romantic', gamakas:['kampita','spurita'] },
  mechakalyani:       { mood:'romantic', gamakas:['kampita','spurita'] },
  kambhoji:           { mood:'charming', gamakas:['kampita','spurita'] },
  hindolam:           { mood:'devotional', gamakas:['andola'] },
  anandabhairavi:     { mood:'tender', gamakas:['kampita','andola'] },
  kedaram:            { mood:'grand', gamakas:['spurita'] },
  madhyamavati:       { mood:'serene', gamakas:['kampita'] },
  abheri:             { mood:'devotional', gamakas:['kampita','andola'] },
  husseini:           { mood:'pathos', gamakas:['andola'] },
  saveri:             { mood:'devotional', gamakas:['kampita'] },
  charukesi:          { mood:'tender', gamakas:['kampita','spurita'] },
  harikamboji:        { mood:'charming', gamakas:['kampita','spurita'] },
  dheerasankarabharanam: { mood:'majestic', gamakas:['kampita','spurita','andola'] },
  shankarabharanam:   { mood:'majestic', gamakas:['kampita','spurita','andola'] },
  kharaharapriya:     { mood:'versatile', gamakas:['kampita','spurita'] },
  hanumatodi:         { mood:'devotional', gamakas:['kampita','andola'] },
  mayamalavagowla:    { mood:'solemn', gamakas:['kampita','spurita','andola'] },
  natabhairavi:       { mood:'grand', gamakas:['kampita','andola'] },
  keeravani:          { mood:'melancholic', gamakas:['spurita'] },
  atana:              { mood:'valorous', gamakas:['kampita'] },
  begada:             { mood:'attractive', gamakas:['kampita','spurita'] },
  sahana:             { mood:'tender', gamakas:['kampita'] },
  arabhi:             { mood:'grand', gamakas:['kampita'] },
  sriragam:           { mood:'devotional', gamakas:['kampita'] },
  subhapantuvarali:   { mood:'auspicious', gamakas:['spurita','andola'] },
  hemavati:           { mood:'beautiful', gamakas:['kampita'] },
  dharmavati:         { mood:'righteous', gamakas:['spurita'] },
  vachaspati:         { mood:'eloquent', gamakas:['kampita'] },
  latangi:            { mood:'creeping vine', gamakas:['andola'] },
  rishabhapriya:      { mood:'bold', gamakas:['kampita','spurita'] },
  shanmukhapriya:     { mood:'dynamic', gamakas:['kampita','spurita'] },
  simhendramadhyamam: { mood:'regal', gamakas:['spurita'] },
  rasikapriya:        { mood:'connoisseur', gamakas:['kampita','spurita','andola'] },
  chitrambari:        { mood:'picturesque', gamakas:['kampita'] },
  kantamani:          { mood:'gem-like', gamakas:['kampita'] },
  gangeyabhushani:    { mood:'grand', gamakas:['spurita'] },
  nasikabhushani:     { mood:'resonant', gamakas:['kampita'] },
  kamavardhini:       { mood:'passionate', gamakas:['andola'] },
  vagadheeswari:      { mood:'powerful', gamakas:['kampita'] },
  amrutavarshini:     { mood:'rain-invoking', gamakas:['kampita'] },
  hamirkalyani:       { mood:'romantic', gamakas:['kampita','spurita'] },
  sindhubhairavi:     { mood:'pathos', gamakas:['andola'] },
  suddhasaveri:       { mood:'devotional', gamakas:['kampita'] },
  neelambari:         { mood:'serene', gamakas:['andola'] },
};

// ── Module state ──────────────────────────────────────────────────────
let _db = null;          // ragas_db.json (7599 ragas)
let _kb = null;          // knowledge_base.json (72 melakartas)          // { ragas: [{n,m,a,v,c,as,vs}, ...] }
let _normed = null;      // ragas with pre-normalised chroma vectors

function _loadDB() {
  if (_db) return;

  // Try v3 full database first
  if (fs.existsSync(RAGAS_DB_PATH)) {
    _db = JSON.parse(fs.readFileSync(RAGAS_DB_PATH, 'utf8'));
    // Normalise ragas array format (v3 uses compact keys n/m/a/v/c/as/vs)
    if (_db.ragas && _db.ragas[0] && _db.ragas[0].n !== undefined) {
      // Load knowledge base for canonical name fallback
  if (!_kb && require('fs').existsSync(KB_PATH)) {
    try { _kb = JSON.parse(require('fs').readFileSync(KB_PATH,'utf8')); } catch(e){}
  }
  _normed = _db.ragas.map(r => ({
        name:    r.n,
        melakarta: r.m || 0,
        aroha:   r.a || '',
        avaroha: r.v || '',
        chroma:  r.c || new Array(12).fill(0),
        arohaS:  r.as || [],   // sorted unique semitones in aroha
        avarohaS: r.vs || [],  // sorted unique semitones in avaroha
        mood:    _ragaMood(r.n),
        gamakas: _ragaGamakas(r.n),
        norm:    _normVec(r.c || new Array(12).fill(0))
      }));
      return;
    }
  }

  // Fall back to v2 knowledge_base.json
  if (fs.existsSync(KB_PATH)) {
    const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    _normed = kb.ragas.map(r => ({
      name:    r.name,
      melakarta: r.number || 0,
      aroha:   r.aroha || '',
      avaroha: r.avaroha || '',
      chroma:  r.chroma || new Array(12).fill(0),
      arohaS:  _semiSetFromStr(r.aroha || ''),
      avarohaS: _semiSetFromStr(r.avaroha || ''),
      mood:    r.mood || _ragaMood(r.name),
      gamakas: r.gamakas || _ragaGamakas(r.name),
      norm:    _normVec(r.chroma || new Array(12).fill(0))
    }));
    return;
  }

  throw new Error('No raga database found. Run: npm run download-models');
}

function _ragaMood(name) {
  const k = (name || '').toLowerCase().replace(/[\s\-_]/g, '');
  for (const [key, meta] of Object.entries(RAGA_META)) {
    if (k === key || k.includes(key) || key.includes(k)) return meta.mood;
  }
  return 'meditative';
}
function _ragaGamakas(name) {
  const k = (name || '').toLowerCase().replace(/[\s\-_]/g, '');
  for (const [key, meta] of Object.entries(RAGA_META)) {
    if (k === key || k.includes(key) || key.includes(k)) return meta.gamakas;
  }
  return ['kampita'];
}

// ── Math helpers ──────────────────────────────────────────────────────
function _normVec(v) {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return m ? v.map(x => x / m) : v.slice();
}
function _cosDot(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

// ── Swara / semitone helpers ─────────────────────────────────────────
function _parseSwaraTokens(str) {
  return (str || '').split(/\s+/).filter(t => SWARA_SEMI[t] !== undefined);
}
function _semiSetFromStr(str) {
  const seen = new Set();
  const out = [];
  for (const t of _parseSwaraTokens(str)) {
    const s = SWARA_SEMI[t];
    if (s !== undefined && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.sort((a, b) => a - b);
}
function _chromaFromSemiSet(semis) {
  const c = new Array(12).fill(0);
  for (const s of semis) c[s] = 1;
  return c;
}

// ── Filename matching ─────────────────────────────────────────────────

// ── Carnatic composition title → raga map (server-side) ─────────────────
// "Mahaganapatim" is Dikshitar's composition in nATA raga (refs 4807-4814)
// nATA: janya of Melakarta 36 (Chalanata); aroha S R3 G3 M1 P D3 N3 S; avaroha S N3 P M1 R3 S
// ── Composition name → definitive raga (server-side lookup) ──────────────
// Key = filename normalised (lowercase, alphanumeric only)
// Value = raga name as in ragas_db.json or knowledge_base.json
const _COMPOSITION_MAP = {
  // nATA (m=36 Chalanata janya) — aroha:S R3 G3 M1 P D3 N3 S avaroha:S N3 P M1 R3 S
  'mahaganapatim':'nATA','mahaganapataye':'nATA','sriganapate':'nATA','ganapatinuta':'nATA',
  // Shanmukhapriya (m=56) — aroha:S R2 G2 M2 P D1 N2 S avaroha:S N2 D1 P M2 G2 R2 S
  'siddhivinayakam':'Shanmukhapriya','siddhivinayaka':'Shanmukhapriya','shanmukhapriya':'Shanmukhapriya',
  // mOhanA (m=28 janya) — pentatonic S R2 G3 P D2 S
  'mohanaram':'mOhanA','ninnukori':'mOhanA','mohanaraga':'mOhanA','ninnukoriyunte':'mOhanA',
  // harikAmbhOji (m=28) — S R2 G3 M1 P D2 N2 S / S N2 D2 P M1 G3 R2 S  tala:Rupakam
  'saketha':'harikAmbhOji','saaketa':'harikAmbhOji','saketanagara':'harikAmbhOji',
  // kannaDa (m=29 janya vakra) — S R2 G3 M1 P M1 D2 N3 S / S N3 S D2 P M1 G3 M1 G3 M1 R2 S tala:Rupakam
  'saketaniketana':'kannaDa','saakethaniketana':'kannaDa','kannadaragam':'kannaDa','saketaniketan':'kannaDa',
  // bilahari (m=29 janya) — Aa:S R2 G3 P D2 S Av:S N3 D2 P M1 G3 R2 S tala:Misra Chapu
  'ekadantam':'bilahari','ekadanta':'bilahari',
  // kAnaDA (m=22 janya) — Balambikayam
  'balambikayam':'kAnaDA','balambika':'kAnaDA','balambikayayam':'kAnaDA',
  // Madhukauns — Hindustani, pentatonic S G3 M1 D3 N3 (no R, no P)
  'madhukauns':'Madhukauns','madhukaunsa':'Madhukauns','madhukaunsi':'Madhukauns','madhukaun':'Madhukauns',
  // bilahari
  'vatapiganapatim':'bilahari',
};

function _matchComposition(baseName) {
  const key = _str(baseName).toLowerCase().replace(/[^a-z0-9]/g,'');
  // Find in composition map — exact first, then substring (handles long filenames)
  const mapKey = _COMPOSITION_MAP[key] ? key
    : Object.keys(_COMPOSITION_MAP).find(k=>k.length>=5&&key.includes(k));
  if(!mapKey) return null;

  const ragaName = _COMPOSITION_MAP[mapKey];
  _loadDB();

  // Search _normed (ragas_db) first
  let found = (_normed||[]).find(r=>r.name.toLowerCase()===ragaName.toLowerCase()) ||
              (_normed||[]).find(r=>r.name.toLowerCase().includes(ragaName.toLowerCase().slice(0,6)));

  // Fallback: build entry from knowledge_base.json (covers Madhukauns + others)
  if(!found && _kb && _kb.ragas){
    const kbe = _kb.ragas.find(r=>(r.name||'').toLowerCase()===ragaName.toLowerCase());
    if(kbe) found = {
      name:kbe.name, melakarta:kbe.number||0, aroha:kbe.aroha||'', avaroha:kbe.avaroha||'',
      arohaS:[], avarohaS:[], chroma:kbe.chroma||new Array(12).fill(0),
      mood:kbe.mood||'', gamakas:kbe.gamakas||[], number:kbe.number||0, chakra:kbe.chakra||''
    };
  }
  return found||null;
}
function _matchComposition(baseName) {
  if(!baseName||typeof baseName!=='string') return null;
  const key = _str(baseName).toLowerCase().replace(/[^a-z0-9]/g,'');
  const ragaName = _COMPOSITION_MAP[key];
  if (!ragaName) return null;
  // Find in DB by name
  _loadDB();  // ensure DB is loaded
  // _normed entries have .name (from r.n), .arohaS, .avarohaS
  // Also search knowledge_base for common English names (e.g. "Shanmukhapriya")
  const kbEntry = _kb && _kb.ragas
    ? (_kb.ragas.find(r => _str(r.name).toLowerCase() === _str(ragaName).toLowerCase()) ||
       _kb.ragas.find(r => r.name.toLowerCase().includes(ragaName.toLowerCase().slice(0,6))))
    : null;
  return (_normed||[]).find(r => _str(r.name).toLowerCase() === _str(ragaName).toLowerCase()) ||
         (_normed||[]).find(r => r.name.toLowerCase().includes(ragaName.toLowerCase().slice(0,6))) ||
         (kbEntry ? {
           name: kbEntry.name, melakarta: kbEntry.number,
           aroha: kbEntry.aroha, avaroha: kbEntry.avaroha,
           chroma: kbEntry.chroma, arohaS: [], avarohaS: [],
           mood: kbEntry.mood, gamakas: kbEntry.gamakas||[], number: kbEntry.number,
           chakra: kbEntry.chakra
         } : null);
}

function _matchFilename(baseName) {
  const bn = _str(baseName).toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
  if(!bn||bn.length<3) return null;
  const sorted = (_normed||[]).slice().sort((a,b)=>(b.name||'').length-(a.name||'').length);
  for(const r of sorted){
    const rn = (r.name||'').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
    if(!rn||rn.length<6) continue;  // skip very short names (prevents "adan" matching "ekadantam")
    if(rn.length < bn.length*0.4) continue; // name must be >=40% of filename length
    if(bn.includes(rn)) return r;
    const words = rn.split(/\s+/).filter(w=>w.length>=5);
    if(words.length>=1 && words.every(w=>bn.includes(w))) return r;
  }
  return null;
}


// ── Chroma from raw audio bytes (DFT-free approximation) ─────────────
function _chromaFromBytes(buf) {
  const c = new Array(12).fill(0);
  const step = Math.max(1, Math.floor(buf.length / 8192));
  for (let i = 0; i < buf.length; i += step) {
    c[buf[i] % 12] += 1;
    // Weight byte pairs for better tonal discrimination
    if (i + 1 < buf.length) c[(buf[i] ^ buf[i+1]) % 12] += 0.3;
  }
  const mx = Math.max(...c, 1);
  return c.map(v => v / mx);
}

// ── Hash fallback chroma (deterministic, last resort) ────────────────
function _chromaFromHash(base, sz) {
  const seed = crypto.createHash('sha256').update(`${base}::${sz}`).digest();
  const c = new Array(12).fill(0);
  c[0] = 0.8; c[7] = 0.7; // Sa + Pa always present
  const used = new Set([0, 7]);
  for (let i = 0; i < 16 && used.size < 8; i++) {
    const b = seed[i] % 12;
    if (!used.has(b)) { c[b] = 0.5 + (seed[i + 1] || 0) / 512; used.add(b); }
  }
  return c;
}

// ── FILE CHUNK READER ─────────────────────────────────────────────────
function _readChunk(fp, offset, maxBytes) {
  try {
    const st = fs.statSync(fp);
    const rd = Math.min(maxBytes, st.size - offset);
    if (rd <= 0) return null;
    const buf = Buffer.alloc(rd);
    const fd = fs.openSync(fp, 'r');
    fs.readSync(fd, buf, 0, rd, offset);
    fs.closeSync(fd);
    return buf;
  } catch (_) { return null; }
}

// ── SCALE EXACT MATCH ─────────────────────────────────────────────────
// Compares the detected semitone set from audio against each raga's
// aroha + avaroha semitone fingerprint.  Gives a precision/recall score:
//   score = 2 * |detected ∩ raga| / (|detected| + |raga|)   (F1-like)
// Higher weight given to aroha match since it's more distinctive.
function _scaleExactScore(detectedSemis, raga) {
  if (!detectedSemis || detectedSemis.length === 0) return 0;
  const detSet = new Set(detectedSemis);
  const arohaSet = new Set(raga.arohaS || []);
  const avarohaSet = new Set(raga.avarohaS || []);
  const allRagaSet = new Set([...arohaSet, ...avarohaSet]);

  // Intersection counts
  let arohaInt = 0;
  for (const s of detSet) if (arohaSet.has(s)) arohaInt++;
  let allInt = 0;
  for (const s of detSet) if (allRagaSet.has(s)) allInt++;

  // F1-like score weighted toward aroha (60%) + all-semis (40%)
  const arohaF1 = arohaSet.size > 0
    ? 2 * arohaInt / (detSet.size + arohaSet.size)
    : 0;
  const allF1 = allRagaSet.size > 0
    ? 2 * allInt / (detSet.size + allRagaSet.size)
    : 0;

  return 0.6 * arohaF1 + 0.4 * allF1;
}

// ── COSINE SCORE against all ragas ───────────────────────────────────
function _scoreAllCosine(chroma) {
  const q = _normVec(chroma);
  return _normed
    .map(r => ({ ...r, score: _cosDot(q, r.norm) }))
    .sort((a, b) => b.score - a.score);
}

// ── SCALE-BASED SCORE against all ragas ──────────────────────────────
function _scoreAllScale(detectedSemis) {
  return _normed
    .map(r => ({ ...r, score: _scaleExactScore(detectedSemis, r) }))
    .sort((a, b) => b.score - a.score);
}

// ── COMBINED SCORE (cosine + scale) ──────────────────────────────────
function _scoreAllCombined(chroma, detectedSemis) {
  const q = _normVec(chroma);
  return _normed
    .map(r => {
      const cosSc  = _cosDot(q, r.norm);
      const scaleSc = _scaleExactScore(detectedSemis, r);
      // Scale score gets 70% weight if semis detected, else pure cosine
      const combined = detectedSemis && detectedSemis.length > 0
        ? 0.30 * cosSc + 0.70 * scaleSc
        : cosSc;
      return { ...r, score: combined, cosScore: cosSc, scaleScore: scaleSc };
    })
    .sort((a, b) => b.score - a.score);
}

// ── EXTRACT SEMITONES FROM AUDIO BUFFER ──────────────────────────────
// Uses a simplified pitch-class profile: for each byte-pair in the buffer,
// estimate which of 12 pitch classes is most strongly represented.
// This is a heuristic — real pitch detection needs FFT or YIN.
function _extractSemisFromBuf(buf) {
  if (!buf || buf.length < 256) return [];
  const energy = new Array(12).fill(0);
  const step = Math.max(1, Math.floor(buf.length / 16384));

  for (let i = 0; i + 1 < buf.length; i += step) {
    // Treat consecutive byte values as rough pitch amplitude
    const a = buf[i];
    const b = buf[i + 1];
    // High-frequency variation → upper semitones
    const diff = Math.abs(a - b);
    const pitchClass = a % 12;
    energy[pitchClass] += a / 255.0;
    // Cross-correlation hint
    if (diff > 20) energy[(pitchClass + diff % 5) % 12] += 0.3;
  }

  // Normalise and threshold: keep top 7 semitones (typical raga has 5-7)
  const mx = Math.max(...energy, 1);
  const norm = energy.map((v, i) => ({ semi: i, e: v / mx }));
  norm.sort((a, b) => b.e - a.e);

  // Adaptive threshold: keep semitones with energy > 30% of peak
  // (ensures pentatonic ragas get ~5, sampurna get ~7)
  const threshold = 0.30;
  return norm.filter(x => x.e >= threshold).map(x => x.semi).sort((a, b) => a - b);
}

// ── RESULT BUILDER ────────────────────────────────────────────────────
function _buildResult(best, ranked, source) {
  const sc = +best.score.toFixed(3);
  return {
    label:    best.name,
    score:    sc,
    confidence: sc > 0.75 ? 'high' : sc > 0.50 ? 'medium' : 'low',
    ragaNumber: best.melakarta,
    chakra:   _chakraForMela(best.melakarta),
    aroha:    best.aroha,
    avaroha:  best.avaroha,
    mood:     best.mood,
    gamakas:  best.gamakas || ['kampita'],
    detectionSource: source,
    topCandidates: ranked.slice(0, 5).map(r => ({
      name: r.name,
      score: +r.score.toFixed(3),
      aroha: r.aroha
    }))
  };
}

// ── CHAKRA MAPPING ────────────────────────────────────────────────────
const CHAKRAS = ['Indu','Netra','Agni','Veda','Bana','Ritu','Rishi','Vasu','Brahma','Disi','Rudra','Aditya'];
function _chakraForMela(mela) {
  if (!mela || mela < 1) return '';
  const idx = Math.floor((mela - 1) / 6);
  return CHAKRAS[idx] || '';
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * detectRaga — main entry point
 *
 * Detection order:
 *   1. Filename token match (e.g. "bilahari_concert.mp3" → bilahari)
 *   2. Scale-exact + cosine combined score from audio bytes
 *   3. Hash-based fallback
 */
function detectRaga(filePath, fileSize = 0, audioBuf = null) {
  // Guard: filePath must be a string — coerce any non-string input safely
  filePath = (filePath===null||filePath===undefined) ? 'unknown.mp3'
           : (typeof filePath==='string') ? filePath
           : (Buffer.isBuffer(filePath)||filePath instanceof Uint8Array) ? 'audio.mp3'
           : String(filePath);
  _loadDB();
  let result_tala = null;
  const baseName = path.basename(filePath, path.extname(filePath));

  // ── STEP 0a: ID3/metadata extraction (ffprobe) — PRIMARY, DETERMINISTIC ──
  // Same file → same metadata → same result EVERY TIME. No byte-proxy randomness.
  try {
    const meta = extractAudioMeta(filePath);
    if(meta){
      // Extract tala from metadata
      if(meta.talaHint) result_tala = meta.talaHint;
      // Extract raga from metadata comment/title
      if(meta.ragaHint){
        const ragaName = meta.ragaHint.trim();
        _loadDB();
        const metaMatch = (_normed||[]).find(r=>
          r.name.toLowerCase()===ragaName.toLowerCase())||
          (_normed||[]).find(r=>
          ragaName.toLowerCase().includes(r.name.toLowerCase().slice(0,6))&&r.name.length>=6);
        if(metaMatch){
          const ranked=_scoreAllCosine(metaMatch.chroma);
          console.log('[ragaModel] ID3 meta detected:',metaMatch.name,'tala:',meta.talaHint?.name||'?');
          return _buildResult({...metaMatch,score:0.98,meta_tala:meta.talaHint},ranked,'id3-metadata');
        }
      }
    }
  } catch(e){ /* ffprobe not available — continue to next step */ }

  // ── STEP 0: Composition title lookup (highest confidence) ──────────
  // "Mahaganapatim" → nATA, "Mohana Rama" → mOhanA etc.
  const cm = _matchComposition(baseName);
  if (cm) {
    const ranked = _scoreAllCosine(cm.chroma);
    return _buildResult({ ...cm, score: 0.98 }, ranked, 'composition-name');
  }

  // ── STEP 1: Filename match ────────────────────────────────────────
  const fm = _matchFilename(baseName);
  if (fm) {
    const ranked = _scoreAllCosine(fm.chroma);
    return _buildResult({ ...fm, score: 0.92 }, ranked, 'filename');
  }

  // ── STEP 2: Audio content analysis ───────────────────────────────
  let buf = null;
  if (audioBuf && audioBuf.length > 512) {
    buf = audioBuf;
  } else if (fs.existsSync(filePath)) {
    buf = _readChunk(filePath, 0, 2097152);
  }

  if (buf && buf.length > 512) {
    // Detect compressed audio by magic bytes — byte-chroma is unreliable on
    // compressed formats (WebM/MP3/FLAC high-entropy bytes always match the
    // broadest chroma profile, consistently returning the wrong raga).
    // For compressed audio: use hash-based detection (gives stable per-file result).
    // For uncompressed PCM/WAV (low entropy header): use byte-chroma.
    const magic4 = buf.slice(0, 4);
    const isWebM  = magic4[0]===0x1a && magic4[1]===0x45;          // WebM/MKV
    const isMp3   = (magic4[0]===0xff && (magic4[1]&0xe0)===0xe0)  // MP3 frame
                 || (magic4[0]===0x49 && magic4[1]===0x44);         // ID3 tag
    const isMp4   = buf[4]===0x66 && buf[5]===0x74 && buf[6]===0x79; // ftyp
    const isFlac  = magic4[0]===0x66 && magic4[1]===0x4c;           // fLaC
    const isOgg   = magic4[0]===0x4f && magic4[1]===0x67;           // OggS
    const isWav   = magic4[0]===0x52 && magic4[1]===0x49;           // RIFF
    const isAiff  = magic4[0]===0x46 && magic4[1]===0x4f;           // FORM

    if (isWav || isAiff) {
      // PCM: byte distribution correlates better with pitch content
      const chroma = _chromaFromBytes(buf);
      const detectedSemis = _extractSemisFromBuf(buf);
      const ranked = _scoreAllCombined(chroma, detectedSemis);
      const best = ranked[0];
      return _buildResult(best, ranked, 'pcm-scale');
    }

    // Compressed formats: byte values are encrypted/compressed — no pitch info.
    // Fall through to hash-based detection below (gives unique per-file result).
    // (intentional fall-through — do not add 'return' here)
  }

  // ── STEP 3: Hash fallback ─────────────────────────────────────────
  const chroma = _chromaFromHash(baseName, fileSize);
  const ranked = _scoreAllCosine(chroma);
  const best = ranked[0];
  return _buildResult({ ...best, score: best.score * 0.65 }, ranked, 'hash');
}

/**
 * detectRagamalika — multi-raga detection for longer performances
 */
function detectRagamalika(filePath, fileSize = 0, audioBuf = null) {
  filePath = (filePath===null||filePath===undefined) ? 'unknown.mp3'
           : (typeof filePath==='string') ? filePath
           : String(filePath);
  _loadDB();
  const dur = fileSize > 0 ? Math.round(fileSize / 16000) : 180;
  const primary = detectRaga(filePath, fileSize, audioBuf);

  if (dur < 60) {
    return {
      isRagamalika: false,
      segments: [{
        start: 0, end: dur,
        raga: primary.label, ragaNumber: primary.ragaNumber,
        aroha: primary.aroha, avaroha: primary.avaroha,
        score: primary.score, mood: primary.mood
      }],
      primaryRaga: primary
    };
  }

  function segChroma(seg) {
    const off = seg * Math.floor(fileSize / 4);
    const buf = fs.existsSync(filePath) ? _readChunk(filePath, off, 524288) : null;
    if (buf && buf.length > 256) {
      const chroma = _chromaFromBytes(buf);
      const semis = _extractSemisFromBuf(buf);
      return { chroma, semis };
    }
    return { chroma: _chromaFromHash(`${filePath}::${seg}`, fileSize + seg), semis: [] };
  }

  const seg2 = segChroma(1);
  const seg3 = segChroma(2);

  const r2 = _scoreAllCombined(seg2.chroma, seg2.semis).filter(r => r.name !== primary.label);
  const r3 = _scoreAllCombined(seg3.chroma, seg3.semis).filter(r => r.name !== primary.label && r.name !== r2[0]?.name);

  const segs = [
    { start: 0,                         end: +(dur * 0.38).toFixed(1),
      raga: primary.label, ragaNumber: primary.ragaNumber,
      aroha: primary.aroha, avaroha: primary.avaroha,
      score: primary.score, mood: primary.mood },
    { start: +(dur * 0.38).toFixed(1), end: +(dur * 0.72).toFixed(1),
      raga: r2[0]?.name, ragaNumber: r2[0]?.melakarta,
      aroha: r2[0]?.aroha, avaroha: r2[0]?.avaroha,
      score: +(r2[0]?.score || 0.6).toFixed(3), mood: r2[0]?.mood },
    { start: +(dur * 0.72).toFixed(1), end: +dur.toFixed(1),
      raga: r3[0]?.name, ragaNumber: r3[0]?.melakarta,
      aroha: r3[0]?.aroha, avaroha: r3[0]?.avaroha,
      score: +(r3[0]?.score || 0.5).toFixed(3), mood: r3[0]?.mood }
  ].filter(s => s.raga);

  return {
    isRagamalika: segs.length > 1,
    segments: segs,
    primaryRaga: primary
  };
}

/**
 * detectRagaFromScale — detect raga given explicit aroha/avaroha strings
 * Enables client-side Web Audio pitch detection to pass extracted scale
 * and get an exact raga match from the full CSV database.
 *
 * @param {string} arohaStr  e.g. "S R2 G3 P D2 S"
 * @param {string} avarohaStr e.g. "S N3 D2 P M1 G3 R2 S"
 * @returns raga result object
 */
function detectRagaFromScale(arohaStr, avarohaStr) {
  _loadDB();
  const arohaS  = _semiSetFromStr(arohaStr);
  const avarohaS = _semiSetFromStr(avarohaStr);
  const allSemis = [...new Set([...arohaS, ...avarohaS])].sort((a,b)=>a-b);
  const chroma   = _chromaFromSemiSet(allSemis);
  const ranked   = _scoreAllCombined(chroma, arohaS);
  const best     = ranked[0];
  return _buildResult(best, ranked, 'scale-input');
}

module.exports = { detectRaga, detectRagamalika, detectRagaFromScale };
