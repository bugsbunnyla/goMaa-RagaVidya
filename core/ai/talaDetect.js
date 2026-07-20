'use strict';
/**
 * Tala (rhythm cycle) detection engine for Carnatic music.
 * 
 * Pipeline:
 *   1. Onset detection  — find note/beat events in PCM samples
 *   2. Tempo estimation — autocorrelation of onset envelope → BPM
 *   3. Beat tracking    — align beats to onset peaks
 *   4. Pattern matching — map beat-group period to tala_db.json
 *
 * Source: https://www.karnatik.com/taalatable.shtml  (35 standard talas)
 * Suladi Sapta Tala system: 7 parent × 5 jaati = 35 talas
 */
const fs   = require('fs');
const path = require('path');

let _talaDB = null;
function _loadTalaDB() {
  if (_talaDB) return _talaDB;
  const p = path.join(__dirname, '../../models/tala_db.json');
  _talaDB = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _talaDB;
}

// ── 1. Onset strength ──────────────────────────────────────────────────
function computeOnsetStrength(samples, sr, hopSize = 512) {
  const frames = Math.floor(samples.length / hopSize);
  const onset  = new Float32Array(frames);
  let prevEnergy = 0;

  for (let f = 0; f < frames; f++) {
    const off = f * hopSize;
    let energy = 0;
    for (let i = 0; i < hopSize && (off + i) < samples.length; i++) {
      energy += samples[off + i] ** 2;
    }
    energy = Math.sqrt(energy / hopSize);
    // Positive energy increase = onset candidate
    onset[f] = Math.max(0, energy - prevEnergy);
    prevEnergy = energy;
  }
  return onset;
}

// ── 2. Tempo via autocorrelation ───────────────────────────────────────
function estimateTempo(onset, sr, hopSize) {
  const framesPerSec = sr / hopSize;
  // Search BPM range 30–360
  const minLag = Math.round(framesPerSec * 60 / 360);
  const maxLag = Math.round(framesPerSec * 60 / 30);
  const N = onset.length;

  let bestLag = minLag, bestCorr = -1;
  for (let lag = minLag; lag <= Math.min(maxLag, N - 1); lag++) {
    let c = 0;
    for (let i = 0; i < N - lag; i++) c += onset[i] * onset[i + lag];
    if (c > bestCorr) { bestCorr = c; bestLag = lag; }
  }

  const bpm = Math.round((framesPerSec * 60) / bestLag);
  return Math.max(30, Math.min(360, bpm));
}

// ── 3. Beat positions ──────────────────────────────────────────────────
function extractBeatPositions(onset, sr, hopSize, bpm) {
  const framesPerBeat = (sr / hopSize) * (60 / bpm);
  const beats = [];
  let phase = 0;

  // Find best phase by summing onset at beat positions
  let bestPhase = 0, bestSum = -1;
  for (let p = 0; p < framesPerBeat; p++) {
    let s = 0;
    for (let b = 0; b * framesPerBeat + p < onset.length; b++) {
      const idx = Math.round(b * framesPerBeat + p);
      if (idx < onset.length) s += onset[idx];
    }
    if (s > bestSum) { bestSum = s; bestPhase = p; }
  }

  for (let b = 0; bestPhase + b * framesPerBeat < onset.length; b++) {
    const frame = Math.round(bestPhase + b * framesPerBeat);
    const timeSec = (frame * hopSize) / sr;
    beats.push({ frame, timeSec, strength: onset[Math.min(frame, onset.length - 1)] });
  }
  return beats;
}

// ── 4. Group beats into vibhagam (beat-group) pattern ─────────────────
// Detect where the "sam" (first beat) occurs by looking for strong beats
function detectVibhagamPattern(beats, totalBeats) {
  if (!beats.length) return [4];
  // Strong beats cluster: look for periodic amplitude peaks
  const strengths = beats.map(b => b.strength);
  const mean = strengths.reduce((s, v) => s + v, 0) / strengths.length;
  const strong = strengths.map(s => s > mean * 1.3 ? 1 : 0);

  // Find period of strong beats
  const intervals = [];
  let last = -1;
  for (let i = 0; i < strong.length; i++) {
    if (strong[i] && last >= 0) intervals.push(i - last);
    if (strong[i]) last = i;
  }
  if (!intervals.length) return [totalBeats];
  const medInterval = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  return [Math.max(2, Math.round(medInterval))];
}

// ── 5. Match tala from beats count ────────────────────────────────────
function matchTala(bpm, detectedBeats, vibhagamHint) {
  const db = _loadTalaDB();
  const allTalas = [
    ...db.talas,
    ...db.chapuTalas,
  ];

  // Score each tala by how well its beat count matches detected cycle length
  const cycleLen = detectedBeats || vibhagamHint || 8;

  const scored = allTalas.map(t => {
    const b = t.beats || t.pattern?.reduce((s, v) => s + v, 0) || 8;
    const diff = Math.abs(b - cycleLen);
    const score = 1 / (1 + diff);
    return { tala: t, score, beats: b };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0].tala;
  const beatsPerCycle = best.beats || best.pattern?.reduce((s, v) => s + v, 0) || 8;

  return {
    name:         best.name || best.commonName || 'Unknown',
    commonName:   best.commonName || best.name,
    parent:       best.parent || '',
    jaati:        best.jaati || '',
    beats:        beatsPerCycle,
    pattern:      best.pattern || best.vibhagam || [beatsPerCycle],
    beatPattern:  best.beatPattern || String(beatsPerCycle),
    angas:        best.angas || 'I',
    bpm,
    tempoName:    bpm < 45 ? 'Ati Vilambita' : bpm < 80 ? 'Vilambita' : bpm < 140 ? 'Madhyama' : bpm < 200 ? 'Druta' : 'Ati Druta',
    confidence:   scored[0].score > 0.85 ? 'high' : scored[0].score > 0.6 ? 'medium' : 'low',
    top3:         scored.slice(0, 3).map(s => ({
      name: s.tala.name, commonName: s.tala.commonName || s.tala.name,
      beats: s.beats, score: +s.score.toFixed(3)
    }))
  };
}

// ── 6. Section segmentation ────────────────────────────────────────────
// Detects Aalapana / Pallavi / Anupallavi / Charanam / Chittaswaram
function detectSections(beats, onset, sr, hopSize, totalDur) {
  const sections = [];
  if (!beats.length || totalDur < 10) {
    return [{ type: 'Song', label: 'Full Audio', start: 0, end: totalDur }];
  }

  // Energy profile: split into 10 equal windows
  const WIN = 10;
  const windowDur = totalDur / WIN;
  const energyProfile = [];
  const framesPerSec = sr / hopSize;

  for (let w = 0; w < WIN; w++) {
    const startF = Math.round(w * windowDur * framesPerSec);
    const endF   = Math.round((w + 1) * windowDur * framesPerSec);
    let e = 0, count = 0;
    for (let f = startF; f < Math.min(endF, onset.length); f++) {
      e += onset[f]; count++;
    }
    energyProfile.push(count > 0 ? e / count : 0);
  }

  const meanE = energyProfile.reduce((s, v) => s + v, 0) / WIN;

  // Heuristic section detection based on energy + position
  const isAlap = energyProfile.slice(0, 2).every(e => e < meanE * 0.7);
  let cursor = 0;

  if (isAlap && totalDur > 60) {
    const alapEnd = totalDur * 0.15;
    sections.push({ type: 'Aalaapana', label: 'Aalaapana (Free rhythmic raga exposition)', start: 0, end: +alapEnd.toFixed(1) });
    cursor = alapEnd;
  }

  if (totalDur > 30) {
    const pallaviStart = cursor;
    const pallaviEnd   = cursor + totalDur * (isAlap ? 0.25 : 0.30);
    sections.push({ type: 'Pallavi', label: 'Pallavi (Main theme)', start: +pallaviStart.toFixed(1), end: +pallaviEnd.toFixed(1) });
    cursor = pallaviEnd;
  }

  if (totalDur > 90) {
    const anuStart = cursor;
    const anuEnd   = cursor + totalDur * 0.20;
    sections.push({ type: 'Anupallavi', label: 'Anupallavi (Counter theme)', start: +anuStart.toFixed(1), end: +anuEnd.toFixed(1) });
    cursor = anuEnd;
  }

  if (totalDur > 120) {
    const charStart = cursor;
    const charEnd   = cursor + totalDur * 0.25;
    sections.push({ type: 'Charanam', label: 'Charanam (Verse)', start: +charStart.toFixed(1), end: +charEnd.toFixed(1) });
    cursor = charEnd;
  }

  if (totalDur > 180) {
    const cswStart = cursor;
    const cswEnd   = cursor + totalDur * 0.15;
    sections.push({ type: 'Chittaswaram', label: 'Chittaswaram (Fixed swara passage)', start: +cswStart.toFixed(1), end: +cswEnd.toFixed(1) });
    cursor = cswEnd;
  }

  // Remaining → Instrumental / Finale
  if (cursor < totalDur - 5) {
    sections.push({ type: 'Instrumental', label: 'Instrumental / Finale', start: +cursor.toFixed(1), end: +totalDur.toFixed(1) });
  }

  return sections.length ? sections : [{ type: 'Song', label: 'Full Audio', start: 0, end: totalDur }];
}

// ── Main entry: detectTala(samples, sr) ──────────────────────────────
function detectTala(samples, sr) {
  _loadTalaDB();
  const HOP = 512;
  const onset  = computeOnsetStrength(samples, sr, HOP);
  const bpm    = estimateTempo(onset, sr, HOP);
  const beats  = extractBeatPositions(onset, sr, HOP, bpm);
  const totalDur = samples.length / sr;

  // Estimate beats per cycle from beat spacing patterns
  const cycleLen = _estimateCycleLength(beats, bpm, sr, HOP);
  const tala   = matchTala(bpm, cycleLen, null);
  const sects  = detectSections(beats, onset, sr, HOP, totalDur);

  return {
    ...tala,
    beatCount:   beats.length,
    duration:    +totalDur.toFixed(2),
    cycleLength: cycleLen,
    beatPositions: beats.slice(0, 32).map(b => +b.timeSec.toFixed(3)),
    sections:    sects,
  };
}

function _estimateCycleLength(beats, bpm, sr, hop) {
  // Use energy-weighted beat grouping to find the tala cycle
  if (beats.length < 4) return 8;
  const strengths = beats.map(b => b.strength);
  const mean = strengths.reduce((s, v) => s + v, 0) / strengths.length;
  // Find how many beats between strong beats
  const strongIdx = strengths.map((s, i) => s > mean * 1.4 ? i : -1).filter(i => i >= 0);
  if (strongIdx.length < 2) return 8;
  const gaps = [];
  for (let i = 1; i < strongIdx.length; i++) gaps.push(strongIdx[i] - strongIdx[i - 1]);
  if (!gaps.length) return 8;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // Map to nearest standard tala beat count
  const candidates = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16];
  return candidates.reduce((prev, c) => Math.abs(c - median) < Math.abs(prev - median) ? c : prev, 8);
}

module.exports = { detectTala, matchTala, detectSections, computeOnsetStrength, estimateTempo };
