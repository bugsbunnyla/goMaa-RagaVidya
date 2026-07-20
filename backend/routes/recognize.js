'use strict';
/**
 * GoMaa Raga Vidya v3 — /api/recognize
 *
 * Full audio analysis pipeline for every uploaded file:
 *   a. Pitch extraction   — frame-by-frame YIN + autocorrelation
 *   b. Detect audio scale — dominant pitch classes → 12-semi chroma
 *   c. Detect aroha/avaroha — ascending / descending pitch trajectory
 *   d. Map to CSV raga DB — scale-exact + cosine match against 7599 ragas
 *   e. Swara evaluation   — each frame → nearest Carnatic swara
 *   f. Sahityam evaluation — aligned syllable grid (swara per beat)
 *   g. Lyrics evaluation  — section labels (pallavi/anupallavi/charanam)
 *   h. Instrument detection— spectral band energy → instrument probabilities
 *   i. Gamaka detection   — pitch-bend rate, vibrato index, kampita/andola/neravel
 *   j. Sheet music + score — MusicXML + MIDI from detected swaras
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const http    = require('http');
const https   = require('https');

const db       = require('../../core/db/sqlite');
const { generateFingerprint, matchFingerprint } = require('../../core/audio/fingerprint');
const { extractAudioMeta, parseTala } = require('../../core/audio/audioMeta');
const { detectRaga, detectRagamalika, detectRagaFromScale } = require('../../core/ai/ragaModel');
const { decodeToFloatPCM: _decodeRaw, isFFmpegAvailable }   = require('../../core/audio/audioDecode');
const { analysePitch, detectGamakaSequence }    = require('../../core/ai/pitchDetect');
const { detectTala: detectTalaReal }            = require('../../core/ai/talaDetect');
const { embedAudio }   = require('../../core/ai/audioEmbedding');
const { fuse }         = require('../../core/ai/fusionEngine');
const { generateSheetMusicXml, generateMidi, RAGA_DEMO_LYRICS, SWARA_DISPLAY }
                       = require('../../core/ai/sheetMusicEngine');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 200 * 1024 * 1024 } });

const YT_HOSTS = ['youtube.com','youtu.be','soundcloud.com','spotify.com','music.apple.com','tidal.com'];
const FETCH_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':'audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/*,*/*;q=0.8',
  'Accept-Encoding':'identity',
  'Cache-Control':'no-cache',
  'Range':'bytes=0-',
};

// ── Swara semitone map ────────────────────────────────────────────────
const SWARA_SEMI = {
  S:0, R1:1, R2:2, R3:3,
  G1:2, G2:3, G3:4,
  M1:5, M2:6,
  P:7,
  D1:8, D2:9, D3:10,
  N1:10, N2:11, N3:11
};
const SEMI_TO_SWARA_DEFAULT = {
  0:'S', 1:'R1', 2:'R2', 3:'R3', 4:'G3', 5:'M1', 6:'M2',
  7:'P', 8:'D1', 9:'D2', 10:'D3', 11:'N3'
};

// ══════════════════════════════════════════════════════════════════════
// a. PITCH EXTRACTION — YIN-inspired autocorrelation
// Returns array of { freq, midi, semi, confidence } per frame
// ══════════════════════════════════════════════════════════════════════
// ── ffmpeg-based PCM extraction + YIN pitch detection ────────────────────────
// Decodes any audio format (mp3/m4a/webm/wav/ogg/flac) to raw f32le PCM first,
// then runs autocorrelation per frame. Without decoding, encoded bytes produce
// garbage pitch data (compressed audio is not PCM).
const { spawnSync } = require('child_process');
const os = require('os');

function _decodeToPCM(buf, filePath) {
  // Use the file path (has correct extension) for format detection
  const ext = (filePath || '').match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'mp3';
  const tmpIn  = path.join(os.tmpdir(), `gomaa_in_${Date.now()}.${ext}`);
  const tmpOut = path.join(os.tmpdir(), `gomaa_pcm_${Date.now()}.raw`);
  try {
    require('fs').writeFileSync(tmpIn, buf);
    const r = spawnSync('ffmpeg', [
      '-y', '-i', tmpIn,
      '-ac', '1',           // mono
      '-ar', '22050',       // 22050 Hz
      '-f', 'f32le',        // raw 32-bit float PCM
      '-acodec', 'pcm_f32le',
      tmpOut
    ], { timeout: 30000, stdio: 'pipe' });
    if (r.status !== 0) return null;
    const raw = require('fs').readFileSync(tmpOut);
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  } catch (e) {
    return null;
  } finally {
    try { require('fs').unlinkSync(tmpIn);  } catch (_) {}
    try { require('fs').unlinkSync(tmpOut); } catch (_) {}
  }
}

function extractPitchFrames(buf, sampleRate = 22050, filePath = '') {
  const HOP    = 512;
  const WIN    = 2048;
  const MIN_F  = 80;
  const MAX_F  = 1200;
  const minLag = Math.floor(sampleRate / MAX_F);
  const maxLag = Math.floor(sampleRate / MIN_F);
  const pitchFrames = [];

  // Decode encoded audio to float32 PCM
  let samples = _decodeToPCM(buf, filePath);

  // Fallback: treat as u8 PCM if decode fails (WAV without header etc.)
  if (!samples) {
    samples = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) samples[i] = (buf[i] - 128) / 128.0;
  }

  const frames_n = Math.floor((samples.length - WIN) / HOP);

  for (let fi = 0; fi < frames_n; fi++) {
    const off = fi * HOP;
    let rms = 0;
    for (let n = 0; n < WIN; n++) rms += samples[off + n] ** 2;
    rms = Math.sqrt(rms / WIN);

    if (rms < 0.003) {
      pitchFrames.push({ freq: 0, midi: 0, semi: -1, confidence: 0, rms });
      continue;
    }

    // YIN-style autocorrelation
    let bestLag = minLag, bestCorr = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let n = 0; n < WIN - lag; n++) corr += samples[off+n] * samples[off+n+lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    const freq = sampleRate / bestLag;
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const semi = ((midi - 60) % 12 + 12) % 12;

    pitchFrames.push({ freq: +freq.toFixed(2), midi, semi,
      confidence: Math.min(1.0, rms * 8), rms });
  }

  return pitchFrames;
}

// ══════════════════════════════════════════════════════════════════════
// b. DETECT AUDIO SCALE — dominant pitch classes from pitch frames
// Returns sorted array of semitone indices present in the audio
// ══════════════════════════════════════════════════════════════════════
function detectAudioScale(pitchFrames) {
  const energy = new Array(12).fill(0);
  let total = 0;

  for (const f of pitchFrames) {
    if (f.semi < 0 || f.confidence < 0.1) continue;
    energy[f.semi] += f.confidence;
    total += f.confidence;
  }

  if (total === 0) return { semis: [0, 2, 4, 7, 9], energy, chroma: energy };

  // Normalise
  const maxE = Math.max(...energy, 1);
  const chroma = energy.map(e => e / maxE);

  // Adaptive threshold: keep pitch classes with >20% of peak energy
  // (handles audava/5-note ragas like bilahari vs sampurna/7-note ragas)
  const threshold = 0.20;
  const semis = chroma
    .map((e, i) => ({ semi: i, e }))
    .filter(x => x.e >= threshold)
    .sort((a, b) => a.semi - b.semi)
    .map(x => x.semi);

  return { semis, energy, chroma };
}

// ══════════════════════════════════════════════════════════════════════
// c. DETECT AROHA / AVAROHA from pitch trajectory
// Separates ascending (aroha) and descending (avaroha) pitch motion
// ══════════════════════════════════════════════════════════════════════
function detectArohaAvaroha(pitchFrames, allSemis, ragaAroha, ragaAvaroha) {
  // Build swara-to-semi mapping from the matched raga's scale
  const ragaArohaS = parseSwaras(ragaAroha);
  const ragaAvarohaS = parseSwaras(ragaAvaroha);
  const semiToSwara = buildSemiToSwara(ragaArohaS, ragaAvarohaS);

  // Segment frames into ascending vs descending runs
  const WINDOW = 20; // frames to look ahead/behind for direction
  let arohaFrames = [], avarohaFrames = [];

  for (let i = WINDOW; i < pitchFrames.length - WINDOW; i++) {
    const f = pitchFrames[i];
    if (f.semi < 0 || f.confidence < 0.1) continue;

    // Count ascending vs descending frames in window
    let up = 0, down = 0;
    for (let j = -WINDOW; j < WINDOW; j++) {
      const prev = pitchFrames[i + j]?.midi || 0;
      const next = pitchFrames[i + j + 1]?.midi || 0;
      if (next > prev) up++;
      else if (next < prev) down++;
    }

    if (up > down * 1.2) arohaFrames.push(f);
    else if (down > up * 1.2) avarohaFrames.push(f);
  }

  // Build ordered swara sequences from ascending/descending frames
  function framestoSwaraSeq(frames) {
    if (!frames.length) return [];
    const semis = [...new Set(frames.map(f => f.semi))];
    return semis
      .sort((a, b) => a - b)
      .map(s => semiToSwara[s] || SEMI_TO_SWARA_DEFAULT[s] || 'S');
  }

  const detectedAroha   = framestoSwaraSeq(arohaFrames);
  const detectedAvaroha = framestoSwaraSeq(avarohaFrames).reverse();

  // If insufficient frames detected, fall back to raga's known scale
  const aroha   = detectedAroha.length >= 3   ? detectedAroha   : ragaArohaS;
  const avaroha = detectedAvaroha.length >= 3  ? detectedAvaroha : ragaAvarohaS;

  return {
    aroha:   aroha.join(' '),
    avaroha: avaroha.join(' '),
    detectedAroha:   detectedAroha.join(' '),
    detectedAvaroha: detectedAvaroha.join(' '),
  };
}

function parseSwaras(str) {
  return (str || '').split(/\s+/).filter(t => SWARA_SEMI[t] !== undefined);
}

function buildSemiToSwara(arohaS, avarohaS) {
  const map = {};
  // Use all swaras from both directions
  for (const sw of [...arohaS, ...avarohaS]) {
    const semi = SWARA_SEMI[sw];
    if (semi !== undefined && !map[semi]) map[semi] = sw;
  }
  // Fill gaps
  for (let s = 0; s < 12; s++) {
    if (!map[s]) {
      // Find nearest mapped semitone
      let best = 'S', bestDist = 99;
      for (const [k, v] of Object.entries(map)) {
        const d = Math.min(Math.abs(+k - s), 12 - Math.abs(+k - s));
        if (d < bestDist) { bestDist = d; best = v; }
      }
      map[s] = best;
    }
  }
  return map;
}

// ══════════════════════════════════════════════════════════════════════
// e. SWARA EVALUATION — map pitch frames to Carnatic swaras
// Returns { frames: [{time, swara, freq, gamaka}], sections }
// ══════════════════════════════════════════════════════════════════════
function evaluateSwaras(pitchFrames, semiToSwara, sampleRate, hop = 512) {
  const swaraFrames = [];
  let prevSwara = null;

  for (let fi = 0; fi < pitchFrames.length; fi++) {
    const f = pitchFrames[fi];
    const time = (fi * hop) / sampleRate;

    if (f.semi < 0 || f.confidence < 0.08) {
      swaraFrames.push({ time: +time.toFixed(3), swara: '.', freq: 0, gamaka: 'silence' });
      prevSwara = null;
      continue;
    }

    const swara = semiToSwara[f.semi] || 'S';
    const isSustain = (swara === prevSwara);

    swaraFrames.push({
      time:   +time.toFixed(3),
      swara,
      freq:   f.freq,
      midi:   f.midi,
      gamaka: isSustain ? 'sustain' : 'attack',
      confidence: +f.confidence.toFixed(3),
    });
    prevSwara = swara;
  }

  return swaraFrames;
}

// ══════════════════════════════════════════════════════════════════════
// i. GAMAKA DETECTION — analyze pitch modulation patterns
// Kampita: vibrato (oscillation), Andola: slow oscillation,
// Neravel: melodic phrase repetition, Gamaka: generic ornament
// ══════════════════════════════════════════════════════════════════════
function detectGamakas(pitchFrames, sampleRate, hop = 512) {
  const detected = new Set();
  const WINDOW = 30; // frames for analysis window

  for (let i = WINDOW; i < pitchFrames.length - WINDOW; i++) {
    if (pitchFrames[i].confidence < 0.1) continue;

    // Get freq series in window
    const freqs = pitchFrames.slice(i - WINDOW, i + WINDOW)
      .filter(f => f.freq > 0)
      .map(f => f.freq);

    if (freqs.length < 10) continue;

    const mean = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    const variance = freqs.reduce((s, f) => s + (f - mean) ** 2, 0) / freqs.length;
    const stddev = Math.sqrt(variance);
    const deviation = stddev / mean;

    // Count zero-crossings of (freq - mean) — measures oscillation rate
    let crossings = 0;
    for (let j = 1; j < freqs.length; j++) {
      if ((freqs[j] - mean) * (freqs[j-1] - mean) < 0) crossings++;
    }
    const crossingRate = crossings / (WINDOW * 2 * hop / sampleRate); // per second

    if (deviation > 0.008 && crossingRate > 4) {
      // Fast oscillation (4+ crossings/sec) = kampita (vibrato)
      detected.add('kampita');
    }
    if (deviation > 0.015 && crossingRate >= 1 && crossingRate < 4) {
      // Slow wide oscillation = andola
      detected.add('andola');
    }
    if (deviation > 0.004 && deviation <= 0.008) {
      // Gentle pitch inflection = spurita
      detected.add('spurita');
    }
  }

  // Detect neravel: check for repeated swara sequences (melodic echoes)
  const swaraseq = pitchFrames
    .filter(f => f.confidence > 0.2)
    .map(f => Math.round(f.semi));

  for (let len = 3; len <= 6; len++) {
    for (let i = 0; i < swaraseq.length - len * 2; i++) {
      const pat = swaraseq.slice(i, i + len).join(',');
      const rest = swaraseq.slice(i + len, i + len * 4).join(',');
      if (rest.includes(pat)) { detected.add('neravel'); break; }
    }
    if (detected.has('neravel')) break;
  }

  return [...detected].filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════
// h. INSTRUMENT DETECTION — spectral band energy classification
// ══════════════════════════════════════════════════════════════════════
function detectInstruments(buf) {
  const instruments = [];
  const len = buf.length;
  if (len < 1000) return [{ name: 'unknown', confidence: 0.5 }];

  // Compute energy in 4 frequency bands (rough: low/mid-low/mid-high/high)
  // Using byte-domain heuristics (no FFT available in pure Node.js easily)
  const q1 = Math.floor(len / 4);
  const q2 = Math.floor(len / 2);
  const q3 = Math.floor(3 * len / 4);

  function bandEnergy(start, end) {
    let e = 0;
    const step = Math.max(1, Math.floor((end - start) / 4096));
    for (let i = start; i < end; i += step) {
      const v = (buf[i] - 128) / 128.0;
      e += v * v;
    }
    return Math.sqrt(e / Math.ceil((end - start) / step));
  }

  // Compute byte-level zero-crossing rate (correlates with tone vs noise)
  let zcr = 0;
  const zcrStep = Math.max(1, Math.floor(len / 8192));
  for (let i = zcrStep; i < len; i += zcrStep) {
    if ((buf[i] - 128) * (buf[i - zcrStep] - 128) < 0) zcr++;
  }
  const zcrNorm = zcr / (len / zcrStep);

  const lowE  = bandEnergy(0, q1);
  const midLE = bandEnergy(q1, q2);
  const midHE = bandEnergy(q2, q3);
  const highE = bandEnergy(q3, len);
  const totalE = lowE + midLE + midHE + highE + 0.001;

  const lowRatio  = lowE  / totalE;
  const midRatio  = (midLE + midHE) / totalE;
  const highRatio = highE / totalE;

  // Heuristic classification rules
  // Voice: strong midrange, ZCR moderate
  if (midRatio > 0.55 && zcrNorm > 0.08 && zcrNorm < 0.35) {
    instruments.push({ name: 'vocal', label: 'Human Voice', confidence: +Math.min(0.9, midRatio * 1.3).toFixed(2) });
  }

  // Veena/String: low-mid heavy, smooth ZCR
  if (lowRatio > 0.30 && midLE / totalE > 0.30 && zcrNorm < 0.25) {
    instruments.push({ name: 'veena', label: 'Veena / String', confidence: +Math.min(0.85, (lowRatio + midLE/totalE) * 0.9).toFixed(2) });
  }

  // Flute: high content, periodic ZCR
  if (highRatio > 0.25 && zcrNorm > 0.20) {
    instruments.push({ name: 'flute', label: 'Flute / Wind', confidence: +Math.min(0.80, highRatio * 1.5).toFixed(2) });
  }

  // Mridangam/Percussion: peaky low, high ZCR
  if (lowE > midLE * 1.5 && zcrNorm > 0.30) {
    instruments.push({ name: 'mridangam', label: 'Mridangam / Percussion', confidence: +Math.min(0.80, lowRatio * 2).toFixed(2) });
  }

  // Tampura drone: low+mid, very low ZCR (sustained)
  if (lowRatio > 0.35 && zcrNorm < 0.12) {
    instruments.push({ name: 'tampura', label: 'Tampura / Drone', confidence: +Math.min(0.75, lowRatio * 1.4).toFixed(2) });
  }

  // Violin: mid-high range, moderate ZCR
  if (midHE / totalE > 0.28 && highRatio > 0.15 && zcrNorm > 0.15 && zcrNorm < 0.30) {
    instruments.push({ name: 'violin', label: 'Violin / Bowing', confidence: +Math.min(0.78, (midHE / totalE + highRatio)).toFixed(2) });
  }

  // Always return at least one instrument
  if (instruments.length === 0) {
    instruments.push({ name: 'mixed', label: 'Mixed / Ensemble', confidence: 0.5 });
  }

  return instruments.sort((a, b) => b.confidence - a.confidence);
}

// ══════════════════════════════════════════════════════════════════════
// f/g. SAHITYAM + LYRICS — tala-aligned swara → syllable grid
// ══════════════════════════════════════════════════════════════════════
// ── buildSahityamGrid: tala-aware swara grid ──────────────────────────
// talaObj is the full tala detection result (with .beats, .sections etc.)
// tempo   is the detected BPM (used for framesPerBeat)
// ─────────────────────────────────────────────────────────────────────
function buildSahityamGrid(swaraFrames, pitchFrames, talaObj, tempo, raga, sampleRate) {
  const HOP         = 512;
  const beatsPerSec = tempo / 60;
  const framesPerBeat = Math.round(sampleRate / HOP / beatsPerSec);

  // Resolve talaObj: accept either a string name or a full tala object
  const tala = (typeof talaObj === 'string') ? parseTala(talaObj) : (talaObj || parseTala('Adi'));
  const talaBeats = tala.beats || 8;
  const sections  = tala.sections || [4, 2, 2];  // anga beat counts

  // ── Group frames into individual beats ─────────────────────────────
  const beatSwaras = [];
  let curBeat = [], beatCount = 0;

  for (let fi = 0; fi < swaraFrames.length; fi++) {
    curBeat.push(swaraFrames[fi]);
    if (curBeat.length >= framesPerBeat || fi === swaraFrames.length - 1) {
      const freq = {};
      for (const f of curBeat) {
        if (f.swara && f.swara !== '.') freq[f.swara] = (freq[f.swara] || 0) + 1;
      }
      const domSwara = Object.keys(freq).length
        ? Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]
        : '.';
      beatSwaras.push({ swara: domSwara, beat: beatCount });
      beatCount++;
      curBeat = [];
    }
  }

  // ── Build notation string with tala anga markers ────────────────────
  // Each anga section ends with | (dhrutam boundary) or || (cycle end)
  // Clap positions (clapOn[i]) marked with ^ in the annotation track
  function buildNotation(swaras) {
    const tokens = [];
    let posInCycle = 0;      // current beat position within tala cycle
    let posInSection = 0;    // current beat position within current anga section
    let sectionIdx = 0;      // which anga section we're in

    for (const bs of swaras) {
      tokens.push(bs.swara || '.');
      posInCycle++;
      posInSection++;

      // Check if this beat completes the current anga section
      const currentSectionLen = sections[sectionIdx] || talaBeats;
      if (posInSection >= currentSectionLen) {
        posInSection = 0;
        sectionIdx++;
        // Check if full cycle completed
        if (sectionIdx >= sections.length || posInCycle >= talaBeats) {
          tokens.push('||');   // tala cycle end (sam / avartanam)
          posInCycle = 0;
          sectionIdx = 0;
        } else {
          tokens.push('|');    // anga section boundary (vibhag)
        }
      }
    }
    return tokens.join(' ');
  }

  // ── Divide beats into Pallavi / Anupallavi / Charanam sections ─────
  // Try to align section boundaries to complete tala cycles
  const totalBeats = beatSwaras.length;
  const cyclesAvailable = Math.floor(totalBeats / talaBeats);
  const pCycles   = Math.max(1, Math.floor(cyclesAvailable / 3));
  const apCycles  = Math.max(1, Math.floor(cyclesAvailable / 3));
  const chCycles  = Math.max(1, cyclesAvailable - pCycles - apCycles);

  const pEnd  = pCycles  * talaBeats;
  const apEnd = pEnd + apCycles * talaBeats;

  const pallaviSwaras    = beatSwaras.slice(0,    pEnd);
  const anupallaviSwaras = beatSwaras.slice(pEnd,  apEnd);
  const charanamSwaras   = beatSwaras.slice(apEnd);

  // Look up known composition lyrics from demo KB
  const kbLyrics = RAGA_DEMO_LYRICS[raga] || {};

  return {
    tala:     tala.name || 'Adi',
    talaObj:  tala,    // full tala structure for UI rendering
    tempo,
    // Detected swaras from actual audio, formatted with tala markers
    swaras_pallavi:    buildNotation(pallaviSwaras),
    swaras_anupallavi: buildNotation(anupallaviSwaras),
    swaras_charanam:   buildNotation(charanamSwaras),
    // Text lyrics from KB if known composition
    pallavi:    kbLyrics.pallavi    || '',
    anupallavi: kbLyrics.anupallavi || '',
    charanam:   kbLyrics.charanam   || '',
    composer:   kbLyrics.composer   || '',
    composition: kbLyrics.composition || '',
    language:   kbLyrics.language   || 'Telugu',
    _fromAudio: true,
    _notFound:  false,
  };
}

// ══════════════════════════════════════════════════════════════════════
// CARNATIC TALA DATABASE
// Source: 7 core talas × 5 jatis = 35 Carnatic talas + Hindustani talas
//
// Anga structure per tala:
//   Laghu (L) = jati count (4/3/5/7/9 per jati)
//   Dhrutam (D) = 2 beats always
//   Anudhrutam (U) = 1 beat always
//
// Structure notation: 'L' = laghu, 'D' = dhrutam, 'U' = anudhrutam
// Beat count = sum of all anga values
// ══════════════════════════════════════════════════════════════════════

// 5 jati values for laghu
const JATI = { chatusra: 4, tisra: 3, khanda: 5, misra: 7, sankirna: 9 };

// 7 core Carnatic talas with their anga sequences [using laghu=L, dhrutam=D, anudhrutam=U]
// Anga sequence array: each element = beat count of that section
function buildCarnaticTalas() {
  const talas = [];

  // name, angas array template (L=laghu placeholder, D=2, U=1)
  const templates = [
    { name:'Dhruva',  angas:['L','D','L','L'],   clap:[true,false,true,true]  },
    { name:'Matya',   angas:['L','D','L'],         clap:[true,false,true]       },
    { name:'Rupaka',  angas:['D','L'],             clap:[false,true]            },
    { name:'Jhampa',  angas:['L','U','D'],         clap:[true,true,false]       },
    { name:'Triputa', angas:['L','D','D'],         clap:[true,false,false]      },
    { name:'Ata',     angas:['L','L','D','D'],     clap:[true,true,false,false] },
    { name:'Eka',     angas:['L'],                 clap:[true]                  },
  ];

  for (const [jatiName, laghu] of Object.entries(JATI)) {
    for (const tmpl of templates) {
      const sectionBeats = tmpl.angas.map(a => {
        if (a === 'L') return laghu;
        if (a === 'D') return 2;
        if (a === 'U') return 1;
        return laghu;
      });
      const totalBeats = sectionBeats.reduce((a, b) => a + b, 0);

      // Adi tala = Chatusra Triputa (4+2+2 = 8 beats) — most common
      const isAdi = (tmpl.name === 'Triputa' && jatiName === 'chatusra');

      talas.push({
        name:       isAdi ? 'Adi' : `${jatiName.charAt(0).toUpperCase() + jatiName.slice(1)} ${tmpl.name}`,
        shortName:  isAdi ? 'Adi' : tmpl.name,
        jati:       jatiName,
        coreTala:   tmpl.name,
        beats:      totalBeats,
        sections:   sectionBeats,
        clapOn:     tmpl.clap,      // which anga sections get a clap
        tradition:  'carnatic',
      });
    }
  }
  return talas;
}

// Hindustani talas — fixed cycle (theka) based
const HINDUSTANI_TALAS = [
  { name:'Tintal',    beats:16, sections:[4,4,4,4], clapOn:[true,true,false,true],  tradition:'hindustani' },
  { name:'Ektal',     beats:12, sections:[2,2,2,2,2,2], clapOn:[true,false,true,false,true,false], tradition:'hindustani' },
  { name:'Jhaptal',   beats:10, sections:[2,3,2,3], clapOn:[true,true,false,true],  tradition:'hindustani' },
  { name:'Rupak',     beats:7,  sections:[3,2,2],   clapOn:[false,true,true],        tradition:'hindustani' },
  { name:'Dhamar',    beats:14, sections:[5,2,3,4], clapOn:[true,true,false,true],   tradition:'hindustani' },
  { name:'Keherwa',   beats:8,  sections:[4,4],     clapOn:[true,false],             tradition:'hindustani' },
  { name:'Dadra',     beats:6,  sections:[3,3],     clapOn:[true,false],             tradition:'hindustani' },
  { name:'Teental',   beats:16, sections:[4,4,4,4], clapOn:[true,true,false,true],   tradition:'hindustani' },
  { name:'Deepchandi',beats:14, sections:[3,4,3,4], clapOn:[true,true,false,true],   tradition:'hindustani' },
  { name:'Tilwada',   beats:16, sections:[4,4,4,4], clapOn:[true,true,false,true],   tradition:'hindustani' },
  { name:'Tivra',     beats:7,  sections:[3,2,2],   clapOn:[true,true,false],        tradition:'hindustani' },
];

// Complete tala database: all 35 Carnatic + 11 Hindustani
const ALL_TALAS = [...buildCarnaticTalas(), ...HINDUSTANI_TALAS];

// Named lookup for parseTala() → used by buildSahityamGrid
const TALA_BY_NAME = {};
for (const t of ALL_TALAS) {
  const k = ((t&&t.name)||'').toLowerCase().replace(/[\s\-_]/g,'');
  TALA_BY_NAME[k] = t;
}

// Parse a tala name string → structured tala object

// ══════════════════════════════════════════════════════════════════════
// ESTIMATE TEMPO — onset autocorrelation, multiple-pass voted result
// Returns { bpm, beatPeriodFrames, confidence }
// ══════════════════════════════════════════════════════════════════════
function estimateTempo(buf, sampleRate) {
  const HOP    = 512;
  const NFRAMES = Math.floor(buf.length / HOP);
  if (NFRAMES < 8) return { bpm: 80, beatPeriodFrames: Math.round(sampleRate * 0.75 / HOP), confidence: 0 };

  // Build onset strength function (energy flux — positive differences only)
  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) {
    let e = 0;
    for (let n = 0; n < HOP; n++) {
      const v = (buf[f * HOP + n] - 128) / 128.0;
      e += v * v;
    }
    energy[f] = Math.sqrt(e / HOP);
  }

  // Onset strength = half-wave rectified first difference of energy
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  // ── PASS 1–3: autocorrelation at three sub-segments, then vote ─────
  // Three independent segments of the audio → 3 tempo estimates → median
  const segLen = Math.floor(NFRAMES / 3);
  const tempoVotes = [];

  for (let pass = 0; pass < 3; pass++) {
    const segStart = pass * segLen;
    const seg = onset.slice(segStart, segStart + segLen);

    // BPM range: 40–240 → period range in frames
    const periodMin = Math.floor(sampleRate / (240 * HOP / sampleRate)); // frames for 240 bpm
    const periodMax = Math.floor(sampleRate / (40  * HOP / sampleRate)); // frames for 40 bpm
    // More directly: period = (sr/HOP) * (60/bpm)
    const fPerSec = sampleRate / HOP;
    const lagMin = Math.round(fPerSec * 60 / 240);  // ~frames for 240 bpm
    const lagMax = Math.round(fPerSec * 60 / 40);   // ~frames for 40 bpm

    // Autocorrelation over lag range
    let bestLag = lagMin, bestCorr = -Infinity;
    for (let lag = lagMin; lag <= Math.min(lagMax, seg.length - 1); lag++) {
      let corr = 0;
      for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n + lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    const bpm = Math.round((sampleRate / HOP) * 60 / bestLag);
    tempoVotes.push(Math.max(40, Math.min(240, bpm)));
  }

  // Median vote across 3 passes
  tempoVotes.sort((a, b) => a - b);
  const bpm = tempoVotes[1]; // median
  const beatPeriodFrames = Math.round((sampleRate / HOP) * 60 / bpm);
  const confidence = tempoVotes[0] === tempoVotes[2] ? 0.9 :
                     Math.abs(tempoVotes[0] - tempoVotes[2]) < 10 ? 0.7 : 0.4;

  return { bpm, beatPeriodFrames, confidence };
}

// ══════════════════════════════════════════════════════════════════════
// DETECT TALA — multi-pass cycle detection from onset envelope
//
// Algorithm:
//   1. Find beat period T (frames per beat) from autocorrelation
//   2. Find cycle period C (frames per tala cycle) at longer time scales
//   3. Cycle length in beats = C / T
//   4. Match to nearest tala from ALL_TALAS by beat count
//   5. Run 3 passes on different segments → vote for most consistent tala
//   6. Return full tala object with anga structure, jati, tradition
//
// This is fundamentally different from guessTala() which WRONGLY used
// BPM→tala name. Tala is a CYCLE STRUCTURE, not a tempo.
// ══════════════════════════════════════════════════════════════════════
function detectTala(buf, sampleRate, tempoResult) {
  const HOP      = 512;
  const NFRAMES  = Math.floor(buf.length / HOP);
  const fPerSec  = sampleRate / HOP;
  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(fPerSec * 60 / 80);

  if (NFRAMES < beatPeriod * 8) {
    // Not enough audio for cycle detection — return Adi as default
    return _defaultTala('Adi', 'Insufficient audio for tala detection');
  }

  // ── Build onset strength function ──────────────────────────────────
  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) {
    let e = 0;
    for (let n = 0; n < HOP; n++) {
      const v = (buf[f * HOP + n] - 128) / 128.0;
      e += v * v;
    }
    energy[f] = Math.sqrt(e / HOP);
  }

  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  // ── PASS 1-3: find tala cycle length from 3 audio segments ─────────
  const segLen = Math.floor(NFRAMES / 3);
  const cycleVotes = []; // beat count per cycle from each pass

  for (let pass = 0; pass < 3; pass++) {
    const segStart = pass * segLen;
    const seg = onset.slice(segStart, segStart + segLen);

    // Search for cycle period: from 3 beats to 20 beats * beatPeriod
    const cycleMin = beatPeriod * 3;
    const cycleMax = Math.min(beatPeriod * 20, seg.length - 1);

    let bestCycleLag = cycleMin, bestCycleCorr = -Infinity;
    for (let lag = cycleMin; lag <= cycleMax; lag++) {
      let corr = 0;
      for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n + lag];
      // Normalize by lag length to avoid bias toward longer lags
      corr /= (seg.length - lag);
      if (corr > bestCycleCorr) { bestCycleCorr = corr; bestCycleLag = lag; }
    }

    // Beats per cycle = cycleLag / beatPeriod (rounded to nearest integer)
    const beatsPerCycle = Math.round(bestCycleLag / beatPeriod);
    if (beatsPerCycle >= 3 && beatsPerCycle <= 32) {
      cycleVotes.push(beatsPerCycle);
    }
  }

  if (cycleVotes.length === 0) {
    return _defaultTala('Adi', 'No cycle detected');
  }

  // Median cycle length from 3 passes
  cycleVotes.sort((a, b) => a - b);
  const detectedBeats = cycleVotes[Math.floor(cycleVotes.length / 2)];
  const cycleConsistency = cycleVotes.filter(v => v === detectedBeats).length / cycleVotes.length;

  // ── Match detected beat count to tala database ─────────────────────
  // Find closest tala(s) by beat count, then rank by tradition probability
  // (Carnatic > Hindustani for SA-based audio; adjust via raga analysis)
  const candidates = ALL_TALAS
    .map(t => ({
      ...t,
      beatDiff: Math.abs(t.beats - detectedBeats),
      // Prefer common talas: Adi(8) >> Rupaka(6) >> Misra Chapu(7) > others
      popularityBonus: _talaPopularity(t.name)
    }))
    .sort((a, b) => {
      if (a.beatDiff !== b.beatDiff) return a.beatDiff - b.beatDiff;
      return b.popularityBonus - a.popularityBonus;
    });

  const best = candidates[0];
  const confidence = cycleConsistency * (1 - best.beatDiff * 0.1);

  // Build full result
  return {
    name:        best.name,
    shortName:   best.shortName || best.name,
    coreTala:    best.coreTala  || best.name,
    jati:        best.jati      || 'chatusra',
    tradition:   best.tradition,
    beats:       best.beats,
    sections:    best.sections,
    clapOn:      best.clapOn,
    // Human-readable anga description
    angaStr:     _angaStr(best),
    // Detection metadata
    detectedBeats,
    cycleVotes,
    confidence:  +confidence.toFixed(3),
    note:        _talaNoteStr(best, detectedBeats, cycleVotes),
    // Alternative candidates
    alternatives: candidates.slice(1, 4).map(t => ({
      name: t.name, beats: t.beats, beatDiff: t.beatDiff
    })),
  };
}

function _talaPopularity(name) {
  const popular = {
    'Adi':10, 'Rupaka':9, 'Misra Chapu':8, 'Tisra Triputa':7,
    'Khanda Chapu':7, 'Chatusra Jhampa':6, 'Tintal':8, 'Ektal':7,
    'Keherwa':7, 'Rupak':6, 'Dadra':6, 'Jhaptal':5,
  };
  return popular[name] || 1;
}

function _angaStr(tala) {
  // e.g. Adi: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats"
  if (!tala.sections) return `${tala.beats} beats`;
  const angas = tala.sections.map((s, i) => {
    if (s === 1)  return 'Anudhrutam(1)';
    if (s === 2)  return 'Dhrutam(2)';
    return `Laghu(${s})`;
  });
  return angas.join(' + ') + ` = ${tala.beats} beats`;
}

function _talaNoteStr(tala, detected, votes) {
  const match = detected === tala.beats ? 'exact' : `nearest (detected ${detected})`;
  const tradition = tala.tradition === 'carnatic' ? 'Carnatic' : 'Hindustani';
  return `${tradition} ${tala.name} — ${match} | votes: [${votes.join(',')}]`;
}

function _defaultTala(name, reason) {
  const t = TALA_BY_NAME[name.toLowerCase()] || TALA_BY_NAME['adi'];
  return {
    ...t,
    angaStr:     _angaStr(t),
    detectedBeats: t.beats,
    cycleVotes:  [],
    confidence:  0.3,
    note:        reason || 'Default tala',
    alternatives: [],
  };
}

// ══════════════════════════════════════════════════════════════════════
// j. GENERATE SHEET MUSIC from detected swaras
// ══════════════════════════════════════════════════════════════════════

// ── Real-time Telugu/Sanskrit transcription via faster-whisper ──────────
// Captures actual sung lyrics (NOT raga-name placeholder text).
// Engine: https://github.com/SYSTRAN/faster-whisper
let _whisperAvailable = null;
function _checkWhisperOnce() {
  return new Promise(resolve => {
    if (_whisperAvailable !== null) return resolve(_whisperAvailable);
    execFile('python3', ['-c', 'import faster_whisper'], { timeout: 5000 }, (err) => {
      _whisperAvailable = !err;
      resolve(_whisperAvailable);
    });
  });
}

const _WHISPER_PY = `
import sys, json
from faster_whisper import WhisperModel
audio_path = sys.argv[1]; lang = sys.argv[2] if len(sys.argv)>2 else 'te'
model = WhisperModel('base', device='cpu', compute_type='int8')
segments, info = model.transcribe(audio_path, language=lang, beam_size=5,
    vad_filter=True, vad_parameters=dict(min_silence_duration_ms=200, speech_pad_ms=100),
    word_timestamps=True, condition_on_previous_text=True, temperature=0.0,
    no_speech_threshold=0.3, log_prob_threshold=-0.6)
result={'language':info.language,'text':'','segments':[]}
texts=[]
for seg in segments:
    texts.append(seg.text.strip())
    result['segments'].append({'start':float(seg.start),'end':float(seg.end),'text':seg.text.strip()})
result['text']=' '.join(texts)
print(json.dumps(result, ensure_ascii=False))
`;

async function transcribeAudioFile(filePath, lang = 'te', maxDurationSec = 120) {
  const available = await _checkWhisperOnce();
  if (!available) return { available: false, text: '', segments: [] };

  let tmpAudio = null, tmpScript = null, tmpClip = null;
  try {
    // Clip to first maxDurationSec for speed (full transcription available via /api/transcribe)
    tmpClip = path.join(os.tmpdir(), `gomaa_clip_${Date.now()}.wav`);
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', filePath, '-t', String(maxDurationSec),
        '-ar', '16000', '-ac', '1', tmpClip], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
    });

    tmpScript = path.join(os.tmpdir(), `gomaa_whisper_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, _WHISPER_PY);

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('python3', [tmpScript, tmpClip, lang], { timeout: 90000 });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => {
        if (code === 0) { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
        else reject(new Error(err.slice(0, 200)));
      });
      proc.on('error', reject);
    });

    return { available: true, ...result };
  } catch (e) {
    console.warn('[transcribe inline]', e.message);
    return { available: false, error: e.message, text: '', segments: [] };
  } finally {
    [tmpAudio, tmpScript, tmpClip].forEach(p => { try { p && fs.unlinkSync(p); } catch (_) {} });
  }
}

function buildStemInfo(ragaResult) {
  const demo    = RAGA_DEMO_LYRICS[ragaResult.label] || {};
  const swAroha = (ragaResult.aroha  || 'S R G M P D N S').split(/\s+/).filter(Boolean);
  const swAvar  = (ragaResult.avaroha || 'S N D P M G R S').split(/\s+/).filter(Boolean);
  const swPall  = (demo.swaras_pallavi  || ragaResult.aroha  || 'S R G M P').split(/\s+/).filter(Boolean);
  const swAnup  = (demo.swaras_anupallavi || ragaResult.avaroha || 'S N D P').split(/\s+/).filter(Boolean);
  return {
    stems: [
      { id:'vocal',    label:'Human Vocal / Voice',     icon:'🎤', role:'Primary melodic voice',
        swaras:swPall, midiProgram:52, midiChannel:4,
        lyric: demo.pallavi || (ragaResult.label + ' — Pallavi'),
        notes: swPall.map(s => SWARA_DISPLAY[s] || s) },
      { id:'veena',    label:'Veena / Melodic Lead',    icon:'🪕', role:'Full raga scale',
        swaras:[...swAroha,...swAvar], midiProgram:24, midiChannel:0,
        lyric:'', notes:[...swAroha,...swAvar].map(s => SWARA_DISPLAY[s] || s) },
      { id:'tampura',  label:'Tampura / Drone',         icon:'🎵', role:'Sa–Pa drone',
        swaras:['S','P','S'], midiProgram:23, midiChannel:1,
        lyric:'', notes:['Sa','Pa','Sa'] },
      { id:'mridangam',label:'Mridangam / Percussion',  icon:'🥁', role:'Tala cycle',
        swaras:['Ta','Di','Ki','Ta','Tha','Ka','Di','Mi'],
        midiProgram:117, midiChannel:9,
        lyric:'', notes:['Ta','Di','Ki','Ta','Tha','Ka','Di','Mi'] },
      { id:'violin',   label:'Violin / Counter Melody', icon:'🎻', role:'Anupallavi melody',
        swaras:swAnup, midiProgram:40, midiChannel:3,
        lyric: demo.anupallavi || '',
        notes: swAnup.map(s => SWARA_DISPLAY[s] || s) },
    ],
    note:'Stems derived from detected raga scale. Real stem separation: pip install demucs && demucs audio.mp3',
  };
}

function buildLyricsData(ragaResult, sahityamGrid) {
  const demo = RAGA_DEMO_LYRICS[ragaResult.label] || {};
  const grid = sahityamGrid || {};
  return {
    raga:    ragaResult.label,
    aroha:   ragaResult.aroha,
    avaroha: ragaResult.avaroha,
    gamakas: ragaResult.gamakas || [],
    mood:    ragaResult.mood || '',
    // Merge audio-detected swaras with KB text lyrics
    swaras_pallavi:    grid.swaras_pallavi    || demo.swaras_pallavi    || ragaResult.aroha  || '',
    swaras_anupallavi: grid.swaras_anupallavi || demo.swaras_anupallavi || ragaResult.avaroha || '',
    swaras_charanam:   grid.swaras_charanam   || demo.swaras_charanam   || ragaResult.aroha  || '',
    pallavi:    grid.pallavi    || demo.pallavi    || '',
    anupallavi: grid.anupallavi || demo.anupallavi || '',
    charanam:   grid.charanam   || demo.charanam   || '',
    composer:   grid.composer   || demo.composer   || '',
    composition: grid.composition || demo.composition || '',
    language:   grid.language   || demo.language   || 'Telugu',
    tala:       grid?.tala || 'Adi',
    talaObj:    grid?.talaObj || null,
    tempo:      grid?.tempo || 80,
    _fromAudio: !!(grid._fromAudio),
    _notFound:  false,
    sections: [
      { name:'Pallavi (పల్లవి)',    role:'Main refrain',
        telugu: grid.pallavi || demo.pallavi || '',
        swaras: grid.swaras_pallavi || demo.swaras_pallavi || '' },
      { name:'Anupallavi (అనుపల్లవి)', role:'Counter theme',
        telugu: grid.anupallavi || demo.anupallavi || '',
        swaras: grid.swaras_anupallavi || demo.swaras_anupallavi || '' },
      { name:'Charanam (చరణం)',    role:'Verse / stanza',
        telugu: grid.charanam || demo.charanam || '',
        swaras: grid.swaras_charanam || demo.swaras_charanam || '' },
    ],
    references: {
      karnatik: 'https://www.karnatik.com',
      patantara: 'https://patantara.com',
      samgeetam: 'https://samgeetam.blogspot.com',
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS FUNCTION
// Orchestrates steps a–j for a given audio file
// ══════════════════════════════════════════════════════════════════════

// ── Result cache: same file = same result, no variation on button re-clicks ──
// ── Result cache: prevents raga flip on repeated Analyze button clicks ──
// Same audio bytes → same SHA-256 key → same result returned instantly
const _resultCache = new Map();
function _cacheKey(buf){
  if(!buf) return null;
  try{
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    return require('crypto').createHash('sha256')
      .update(b.slice(0, Math.min(32768, b.length))).digest('hex');
  }catch(_){ return null; }
}
function _cacheGet(key){
  if(!key) return null;
  const e = _resultCache.get(key);
  if(!e) return null;
  if(Date.now() - e.ts > 600000){ _resultCache.delete(key); return null; } // 10min TTL
  return e.data;
}
function _cacheSet(key, data){
  if(!key || !data) return;
  _resultCache.set(key, { data, ts: Date.now() });
  if(_resultCache.size > 100) _resultCache.delete(_resultCache.keys().next().value);
}
async function analyseFile(filePath, originalName, fileSize, sourceUrl) {
  // Ensure originalName is always a plain string
  originalName = (typeof originalName === 'string') ? originalName
    : (originalName && originalName.toString) ? String(originalName)
    : path.basename(String(filePath || 'audio.mp3'));

  // ── Read audio bytes ONCE ──────────────────────────────────────────
  let audioBuf = null;
  try { audioBuf = fs.readFileSync(filePath); } catch(_) {}

  // ── Cache: same raw audio bytes → same result on every button click ─
  // Prevents raga flip when Analyze is clicked multiple times
  const cacheKey = audioBuf ? _cacheKey(audioBuf) : null;
  if(cacheKey){ const cached=_cacheGet(cacheKey); if(cached){
    console.log('[GoMaa] Cache hit:', cached.raga, 'for', originalName);
    return cached;
  }}

  // ── d. Raga identification (scale-based + cosine, full 7599-raga DB) ──
  // CRITICAL: use originalName not temp buf_ path — composition map needs real filename
  const _nameForDetect = (typeof originalName==='string'&&originalName.length>0) ? originalName : require('path').basename(String(filePath||'unknown.mp3'));
  const raga   = detectRaga(_nameForDetect, fileSize, audioBuf);
  const ragaM  = detectRagamalika(_nameForDetect, fileSize, audioBuf);

  // ── a/b. Pitch extraction + scale detection (if audio available) ──
  let pitchFrames  = [];
  let audioScale   = { semis: [], chroma: new Array(12).fill(0) };
  let tempo        = 80;
  let tempoResult  = { bpm: 80, beatPeriodFrames: 24, confidence: 0 };
  let talaResult   = _defaultTala('Adi', 'No audio analysis');
  // Try ID3 metadata for tala (most reliable for tagged files)
  if(fs.existsSync(filePath)){
    try{
      const _meta = extractAudioMeta(filePath);
      if(_meta && _meta.talaHint){
        talaResult = { name:_meta.talaHint.name, beats:_meta.talaHint.beats,
          pattern:_meta.talaHint.pattern, sections:[], confidence:'high', source:'id3' };
        console.log('[recognize] ID3 tala:',talaResult.name,'from',_nameForDetect);
      }
      // Also check if raga came from id3 metadata
      if(_meta && raga.detectionSource==='id3-metadata' && _meta.talaHint){
        console.log('[recognize] ID3 raga:',raga.label,'tala:',_meta.talaHint.name);
      }
    }catch(_){}
  }
  // meta_tala_override applied
  let detectedGamakas = raga.gamakas || ['kampita'];
  let detectedInstruments = [{ name:'mixed', label:'Mixed / Ensemble', confidence:0.5 }];

  // ── REAL PCM decode via ffmpeg (replaces byte-proxy chroma) ──────────
  // Source: ffmpeg system binary decodes MP3/WAV/WebM/FLAC/M4A/OGG to
  // true Float32 PCM samples — pitch/tala detection runs on actual audio,
  // not a statistical proxy of compressed bytes.
  let realPitchResult = null;
  let realTalaResult  = null;
  let ffmpegOk = false;

  if (fs.existsSync(filePath)) {
    try {
      ffmpegOk = isFFmpegAvailable();
      if (ffmpegOk) {
        const { samples, sr, duration } = decodeToFloatPCM(filePath);

        // Pitch/scale: analyse a representative middle section (skip intro
        // silence/applause; cap at 90s for response-time on long concert files)
        const skipStart = Math.min(samples.length * 0.10, sr * 8);
        const maxLen     = Math.min(samples.length - skipStart, sr * 90);
        const pitchSlice = samples.slice(skipStart, skipStart + maxLen);
        realPitchResult  = analysePitch(pitchSlice, sr);

        // Tala: analyse a separate section with strong rhythmic content
        // (use up to 60s starting after the pitch slice, for independent signal)
        const talaStart  = Math.min(skipStart + maxLen, samples.length - sr * 10);
        const talaSlice  = samples.slice(Math.max(0, talaStart), Math.min(samples.length, talaStart + sr * 60));
        realTalaResult   = detectTalaReal(talaSlice.length > sr * 5 ? talaSlice : samples.slice(0, sr * 60), sr);
        realTalaResult.duration = +duration.toFixed(1); // full-file duration, not slice

        tempo = realTalaResult.bpm;
        talaResult = {
          name: realTalaResult.commonName || realTalaResult.name,
          beats: realTalaResult.beats,
          pattern: realTalaResult.pattern,
          beatPattern: realTalaResult.beatPattern,
          confidence: realTalaResult.confidence,
          sections: realTalaResult.sections,
        };
      }
    } catch (e) {
      console.warn('[recognize] PCM decode/pitch/tala failed, using byte-proxy fallback:', e.message);
    }
  }

  if (audioBuf && audioBuf.length > 4096) {
    const SR = 22050;
    // Byte-proxy fallback (used only if ffmpeg unavailable/failed)
    if (!ffmpegOk || !realPitchResult) {
      pitchFrames         = extractPitchFrames(audioBuf, SR, filePath);
      audioScale          = detectAudioScale(pitchFrames);
      tempoResult         = estimateTempo(audioBuf, SR);
      tempo               = tempoResult.bpm;
      if (!realTalaResult) talaResult = detectTala(audioBuf, SR, tempoResult);
    } else {
      // Use REAL pitch detection results — far more reliable than byte-proxy
      audioScale = {
        semis: realPitchResult.ascSemis,
        descSemis: realPitchResult.descSemis,
        chroma: new Array(12).fill(0).map((_, i) => realPitchResult.ascSemis.includes(i) ? 1 : 0),
        sa_hz: realPitchResult.sa_hz,
        sa_western: realPitchResult.sa_western,
        detectedAroha: realPitchResult.detectedAroha,
        detectedAvaroha: realPitchResult.detectedAvaroha,
        detectedArohaWestern: realPitchResult.detectedArohaWestern,
        detectedAvarohaWestern: realPitchResult.detectedAvarohaWestern,
      };
    }
    detectedGamakas     = detectGamakas(pitchFrames, SR);
    detectedInstruments = detectInstruments(audioBuf);

    // ── d. Refine raga using REAL detected scale, but ONLY when filename/
    // composition-name match was NOT used (those are ground-truth certain) ──
    if (raga.detectionSource !== 'filename' && raga.detectionSource !== 'composition-name') {
      const ascSemis  = realPitchResult ? realPitchResult.ascSemis  : (audioScale.semis || []);
      const descSemis = realPitchResult ? realPitchResult.descSemis : (audioScale.semis || []);
      if (ascSemis.length >= 4) {
        const scaleRefined = detectRagaFromScale(
          ascSemis.map(s => SEMI_TO_SWARA_DEFAULT[s] || 'S').join(' '),
          descSemis.map(s => SEMI_TO_SWARA_DEFAULT[s] || 'S').join(' ')
        );
        if (scaleRefined && scaleRefined.score > raga.score + 0.05) {
          Object.assign(raga, scaleRefined);
        }
      }
    }
  }

  // Merge detected gamakas with raga's known gamakas
  const mergedGamakas = [...new Set([
    ...(detectedGamakas.length ? detectedGamakas : []),
    ...(raga.gamakas || ['kampita'])
  ])];
  raga.gamakas = mergedGamakas;

  // ── c. Detect aroha/avaroha from pitch trajectory ──────────────────
  const semiToSwara = buildSemiToSwara(
    parseSwaras(raga.aroha  || 'S R G M P D N S'),
    parseSwaras(raga.avaroha || 'S N D P M G R S')
  );

  const arohaAvaroha = realPitchResult
    ? {
        aroha: raga.aroha, avaroha: raga.avaroha,            // confirmed raga's canonical scale
        detectedAroha:   realPitchResult.detectedAroha,        // what the audio actually contains
        detectedAvaroha: realPitchResult.detectedAvaroha,
        detectedArohaWestern:   realPitchResult.detectedArohaWestern,
        detectedAvarohaWestern: realPitchResult.detectedAvarohaWestern,
        sa_hz: realPitchResult.sa_hz, sa_western: realPitchResult.sa_western,
        pitchConfidence: realPitchResult.voicedRatio,
      }
    : audioBuf && pitchFrames.length > 50
    ? detectArohaAvaroha(pitchFrames, audioScale.semis, raga.aroha, raga.avaroha)
    : { aroha: raga.aroha, avaroha: raga.avaroha,
        detectedAroha: raga.aroha, detectedAvaroha: raga.avaroha };

  // ── e. Swara evaluation ─────────────────────────────────────────────
  const swaraFrames = pitchFrames.length > 0
    ? evaluateSwaras(pitchFrames, semiToSwara, 22050)
    : [];

  // ── f/g. Sahityam + lyrics evaluation ──────────────────────────────
  const sahityamGrid = swaraFrames.length > 0
    ? buildSahityamGrid(swaraFrames, pitchFrames, talaResult, tempo, raga.label, 22050)
    : null;

  // ── j. Sheet music + MIDI generation ───────────────────────────────
  // [DETECT_LOG] Always log detection so user can verify from server console
  console.log('\n[GoMaa DETECT] ─────────────────────────────────');
  console.log('[GoMaa DETECT] File    :', _nameForDetect);
  console.log('[GoMaa DETECT] Raga    :', raga.label, '| Melakarta:', raga.ragaNumber||'?');
  console.log('[GoMaa DETECT] Source  :', raga.detectionSource, '| Score:', raga.score);
  console.log('[GoMaa DETECT] Aroha ↑ :', raga.aroha);
  console.log('[GoMaa DETECT] Avaroha↓:', raga.avaroha);
  console.log('[GoMaa DETECT] Tala    :', talaResult.name, '| Beats:', talaResult.beats);
  console.log('[GoMaa DETECT] ─────────────────────────────────\n');
  const sheet = generateSheetMusicXml(raga, sahityamGrid
    ? { tala: talaResult.name,
        sections: {
          pallavi:    sahityamGrid.pallavi,
          anupallavi: sahityamGrid.anupallavi,
          charanam:   sahityamGrid.charanam,
        }}
    : { tala: talaResult.name });
  const midi  = generateMidi(raga, { instruments: ['veena','tampura','mridangam','violin'], tempo });
  const stems = buildStemInfo(raga);

  // ── Build lyricsData (e + f + g combined) ──────────────────────────
  // Enrich sahityamGrid with tala/tempo before passing to buildLyricsData
  const _enrichedGrid = sahityamGrid
    ? { ...sahityamGrid, tala: sahityamGrid.tala || talaResult?.name || 'Adi',
        talaObj: sahityamGrid.talaObj || talaResult || null,
        tempo: sahityamGrid.tempo || tempo || 80 }
    : { tala: talaResult?.name || 'Adi', talaObj: talaResult || null, tempo: tempo || 80 };
  const lyricsData = buildLyricsData(raga, _enrichedGrid);

  // ── REAL transcription (actual sung lyrics, not raga-name lyrics) ────
  // Runs faster-whisper on the audio. Overrides demo/placeholder text
  // when real speech-to-text content is captured.
  let realTranscript = null;
  if (fs.existsSync(filePath) && isFFmpegAvailable()) {
    try {
      realTranscript = await transcribeAudioFile(filePath, 'te', 100);
      if (realTranscript.available && realTranscript.text && realTranscript.text.trim().length > 3) {
        // Distribute transcribed text across pallavi (first section gets real text)
        lyricsData.transcribedText = realTranscript.text;
        lyricsData.transcribedSegments = realTranscript.segments || [];
        lyricsData.transcriptionLanguage = realTranscript.language;
        lyricsData._isRealTranscript = true;
        if (lyricsData.sections && lyricsData.sections[0]) {
          lyricsData.sections[0].telugu = realTranscript.text; // real audio content, not raga-name template
          lyricsData.sections[0].meaning = 'Live transcription (faster-whisper, ' + realTranscript.language + ')';
        }
      } else {
        lyricsData.transcriptionUnavailable = realTranscript.error || 'No speech detected in sample window';
      }
    } catch (e) {
      lyricsData.transcriptionUnavailable = e.message;
    }
  } else {
    lyricsData.transcriptionUnavailable = 'ffmpeg or faster-whisper not available on server';
  }

  // ── Fingerprint + DB ───────────────────────────────────────────────
  const fp      = generateFingerprint(filePath);
  const embed   = embedAudio(filePath, fileSize, null);

  await db.getDb();
  const fpRows    = db.all('SELECT f.hash,f.music_id,m.title,m.raga,m.artist FROM fingerprint f LEFT JOIN music m ON m.id=f.music_id LIMIT 300');
  const fpMatches = matchFingerprint(fp, fpRows.map(r => ({
    id: r.music_id, hash: r.hash, title: r.title,
    raga: r.raga, artist: r.artist, score: r.hash === fp.hash ? 1.0 : 0.2, peaks: fp.peaks
  })));
  fuse(fpMatches[0] || null, { score: 0.75 }, raga);

  // Auto-save to DB
  const recId = crypto.createHash('md5').update(filePath + Date.now()).digest('hex').slice(0, 16);
  try {
    db.run(
      `INSERT OR REPLACE INTO music
       (id,title,artist,raga,ragaNumber,aroha,avaroha,mood,gamakas,filePath,embedding,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))`,
      [recId, originalName || path.basename(filePath),
       sourceUrl || 'upload',
       raga.label, raga.ragaNumber,
       arohaAvaroha.aroha, arohaAvaroha.avaroha,
       raga.mood, JSON.stringify(raga.gamakas || []),
       filePath, JSON.stringify(embed.vector)]
    );
  } catch (_) {}

  return {
    recognized:      fpMatches.length > 0,
    fileName:        originalName || path.basename(filePath),
    sourceUrl:       sourceUrl || null,

    // ── Raga identification result ──────────────────────────────────
    raga:            raga.label,
    ragaNumber:      raga.ragaNumber,
    ragaChakra:      raga.chakra,
    aroha:           arohaAvaroha.aroha,
    avaroha:         arohaAvaroha.avaroha,
    detectedAroha:   arohaAvaroha.detectedAroha,
    detectedAvaroha: arohaAvaroha.detectedAvaroha,
    mood:            raga.mood,
    gamakas:         raga.gamakas,
    confidence:      raga.confidence,
    detectionScore:  raga.score,
    detectionSource: raga.detectionSource,
    topCandidates:   raga.topCandidates,

    // ── Ragamalika ──────────────────────────────────────────────────
    isRagamalika:      ragaM.isRagamalika,
    ragamalikaSegments: ragaM.segments,

    // ── Dual notation: Carnatic + Western (from real 22-shruti pitch model) ──
    arohaWestern:    arohaAvaroha.detectedArohaWestern  || '',
    avarohaWestern:  arohaAvaroha.detectedAvarohaWestern|| '',
    saHz:            arohaAvaroha.sa_hz   || null,
    saWestern:       arohaAvaroha.sa_western || '',
    pitchEngine:      ffmpegOk ? 'ffmpeg-PCM+YIN+22shruti' : 'byte-proxy-fallback',

    // ── Real tala (rhythm cycle) detection — 35-tala karnatik.com DB ──
    talaDetected: realTalaResult ? {
      name:        realTalaResult.commonName || realTalaResult.name,
      parent:      realTalaResult.parent,
      jaati:       realTalaResult.jaati,
      beats:       realTalaResult.beats,
      pattern:     realTalaResult.pattern,
      beatPattern: realTalaResult.beatPattern,
      bpm:         realTalaResult.bpm,
      tempoName:   realTalaResult.tempoName,
      confidence:  realTalaResult.confidence,
      top3:        realTalaResult.top3,
      sections:    realTalaResult.sections,    // Aalaapana/Pallavi/Anupallavi/Charanam/Chittaswaram
    } : null,

    // ── Audio analysis results ──────────────────────────────────────
    audioAnalysis: {
      detectedScale:    audioScale.semis,
      chroma:           audioScale.chroma,
      estimatedTempo:   tempo,
      tempoConfidence:  tempoResult.confidence,
      detectedGamakas,
      instruments:      detectedInstruments,
      pitchFrameCount:  pitchFrames.length,
      pitchEngine:      ffmpegOk ? 'real-PCM' : 'byte-proxy',
      // Tala — full cycle-based detection (NOT a BPM→name guess)
      tala: {
        name:         talaResult.name,
        beats:        talaResult.beats,
        sections:     talaResult.sections,
        angaStr:      talaResult.angaStr,
        jati:         talaResult.jati,
        coreTala:     talaResult.coreTala,
        tradition:    talaResult.tradition,
        clapOn:       talaResult.clapOn,
        detectedBeats: talaResult.detectedBeats,
        confidence:   talaResult.confidence,
        cycleVotes:   talaResult.cycleVotes,
        note:         talaResult.note,
        alternatives: talaResult.alternatives,
      },
    },

    // ── Instrument detection ─────────────────────────────────────────
    instruments: detectedInstruments,

    // ── Gamaka analysis ──────────────────────────────────────────────
    gamakaAnalysis: {
      detected:    raga.gamakas,
      descriptions: {
        kampita: 'Oscillation / vibrato — pitch wavers around the swara',
        andola:  'Slow wide oscillation between two adjacent swaras',
        spurita: 'Light grace note / quick touch before main swara',
        neravel:  'Melodic phrase repeated at different pitch levels',
      },
    },

    // ── Sheet music + MIDI ───────────────────────────────────────────
    sheetMusicXml:  sheet,
    midiData:       midi,
    stems,
    lyricsData,

    matchedSong:   fpMatches[0]
      ? { id: fpMatches[0].id, title: fpMatches[0].title, score: fpMatches[0].score }
      : null,
    autoSavedId:   recId,
    processedAt:   new Date().toISOString(),
  };
  if(cacheKey) _cacheSet(cacheKey, result);
  console.log('[GoMaa]', result.raga||'?', '|', result.detectionSource||'?', '| file:', String(originalName||'').slice(0,40));
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

// POST /api/recognize  (multipart)
router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.mp3';
    const renamed = req.file.path + ext;
    try { fs.renameSync(req.file.path, renamed); } catch (_) {}
    const result = await analyseFile(renamed, req.file.originalname, req.file.size);
    setTimeout(() => { try { fs.unlinkSync(renamed); } catch (_) {} }, 60000);
    res.json(result);
  } catch (e) {
    console.error('recognize:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recognize/buffer (raw ArrayBuffer — avoids FormData CORS)
router.post('/buffer', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty buffer' });
    const id   = crypto.randomBytes(8).toString('hex');
    const xfn  = decodeURIComponent(req.headers['x-filename'] || 'recording');
    const ext  = (xfn.match(/\.(mp3|wav|ogg|flac|webm|m4a)$/i) || ['.webm'])[0];
    const fp   = path.join(UPLOAD_DIR, `buf_${id}${ext}`);
    fs.writeFileSync(fp, req.body);
    const result = await analyseFile(fp, xfn, req.body.length);
    setTimeout(() => { try { fs.unlinkSync(fp); } catch (_) {} }, 60000);
    res.json(result);
  } catch (e) {
    console.error('recognize/buffer:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recognize/url
router.post('/url', express.json(), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (YT_HOSTS.some(h => url.includes(h))) {
      return res.status(400).json({
        error: 'YouTube/Spotify blocks server-side fetch.',
        hint: 'Use the YouTube Player tab to embed and record via mic.',
        ytEmbedHint: true
      });
    }
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }

    const proto = parsedUrl.protocol === 'https:' ? https : http;
    const audioData = await new Promise((resolve, reject) => {
      const chunks = [];
      const opts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { ...FETCH_HEADERS, Referer: parsedUrl.origin || 'https://' + parsedUrl.hostname },
        timeout: 30000
      };
      const req2 = proto.request(opts, r => {
        if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
          const chunks2 = [];
          return proto.get(r.headers.location, { headers: FETCH_HEADERS, timeout: 20000 }, r2 => {
            r2.on('data', c => chunks2.push(c));
            r2.on('end', () => resolve(Buffer.concat(chunks2)));
          }).on('error', reject);
        }
        if (r.statusCode !== 200) return reject(new Error(`Server returned ${r.statusCode}`));
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout (30s)')); });
      req2.end();
    });

    if (audioData.length < 1024) return res.status(400).json({ error: 'URL returned too little data' });
    const suffix = (url.match(/\.(mp3|wav|flac|ogg|m4a)/i) || ['.mp3'])[0];
    const tmpPath = path.join(UPLOAD_DIR, `url_${Date.now()}${suffix}`);
    fs.writeFileSync(tmpPath, audioData);
    const result = await analyseFile(tmpPath, path.basename(parsedUrl.pathname) || 'url_audio', audioData.length, url);
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch (_) {} }, 30000);
    res.json(result);
  } catch (e) {
    console.error('recognize/url:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recognize/path
router.post('/path', express.json(), async (req, res) => {
  try {
    const fp = req.body?.filePath;
    if (!fp) return res.status(400).json({ error: 'filePath required' });
    const sz = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
    res.json(await analyseFile(fp, path.basename(fp), sz));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/recognize/stems/:id
router.get('/stems/:id', async (req, res) => {
  try {
    await db.getDb();
    const row = db.get('SELECT * FROM music WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const raga = {
      label: row.raga, aroha: row.aroha, avaroha: row.avaroha,
      mood: row.mood, gamakas: JSON.parse(row.gamakas || '[]')
    };
    res.json(buildStemInfo(raga));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/recognize/lyrics/:id
router.get('/lyrics/:id', async (req, res) => {
  try {
    await db.getDb();
    const row = db.get('SELECT * FROM music WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const raga = {
      label: row.raga, aroha: row.aroha, avaroha: row.avaroha,
      mood: row.mood, gamakas: JSON.parse(row.gamakas || '[]')
    };
    res.json(buildLyricsData(raga, null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
