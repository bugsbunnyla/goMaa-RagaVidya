'use strict';
/**
 * Pitch detection + scale extraction engine.
 * Uses YIN autocorrelation for fundamental frequency per frame.
 * Maps Hz → Carnatic shruti via just-intonation ratios (22-shruti model).
 * Outputs: sa_hz, bpm, ascSemis, descSemis, detectedAroha, detectedAvaroha,
 *          pitchFrames, westernAroha, westernAvaroha
 *
 * Ref: Subramanya et al., VIIRJ 2022, https://www.viirj.org/vol14issue1/5.pdf
 */
const { hzToShrutiEntry, detectSaHz, SEMI_TO_SWARA_PRIMARY, SEMI_TO_WESTERN, SA_HZ } = require('./shrutiModel');

const FRAME = 2048;
const HOP   = 512;

// ── YIN pitch detector (autocorrelation-based) ─────────────────────────
function yinPitch(frame, sr) {
  const N     = frame.length;
  const half  = Math.floor(N / 2);
  const diff  = new Float32Array(half);
  let runSum  = 0;

  diff[0] = 1.0;
  for (let tau = 1; tau < half; tau++) {
    let d = 0;
    for (let i = 0; i < half; i++) {
      const delta = frame[i] - frame[i + tau];
      d += delta * delta;
    }
    diff[tau] = d;
    runSum += d;
    diff[tau] *= tau > 0 ? tau / runSum : 1;
  }

  // Find first minimum below threshold (tighter threshold = higher confidence required)
  const threshold = 0.10;
  for (let tau = 2; tau < half - 1; tau++) {
    if (diff[tau] < threshold && diff[tau] < diff[tau - 1] && diff[tau] <= diff[tau + 1]) {
      const better = tau + (diff[tau + 1] - diff[tau - 1]) / (2 * (2 * diff[tau] - diff[tau - 1] - diff[tau + 1]));
      const clarity = 1 - diff[tau]; // 0..1, higher = more periodic/confident
      return { freq: sr / better, clarity };
    }
  }

  // Fallback: global minimum, but flag low confidence
  let minV = Infinity, minTau = 0;
  for (let tau = 2; tau < half; tau++) {
    if (diff[tau] < minV) { minV = diff[tau]; minTau = tau; }
  }
  return minTau > 0 ? { freq: sr / minTau, clarity: 1 - minV } : { freq: 0, clarity: 0 };
}

// ── RMS energy per frame ───────────────────────────────────────────────
function rms(frame) {
  let s = 0;
  for (const v of frame) s += v * v;
  return Math.sqrt(s / frame.length);
}

// ── Extract directional semitone sets from pitch frames ─────────────────
// Uses HISTOGRAM THRESHOLDING: a semitone only counts as part of the scale
// if it appears in a meaningful fraction of voiced, STABLE (non-transient) frames.
// This filters out percussion bleed, gamaka glide transients, and noise.
function extractDirectionalSemis(pitchFrames, sa_hz) {
  const voiced = pitchFrames.filter(f => f && f.freq > 0 && f.semi !== null && f.semi !== undefined);
  if (voiced.length < 8) return { ascending: [], descending: [] };

  // STEP 1: Median-filter the semitone sequence to remove single-frame glitches
  const semis = voiced.map(f => f.semi);
  const MED_WIN = 3;
  const smoothed = semis.map((_, i) => {
    const lo = Math.max(0, i - MED_WIN), hi = Math.min(semis.length, i + MED_WIN + 1);
    const window = semis.slice(lo, hi).slice().sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)];
  });

  // STEP 2: Find STABLE plateaus — runs where semitone doesn't change for >= MIN_RUN frames
  // (a frame ≈ HOP/sr seconds; MIN_RUN=6 frames ≈ 140ms — long enough to be a real note,
  //  short enough to catch fast passages, but excludes gamaka glide transients)
  const MIN_RUN = 4;
  const histogram = {};       // semi → total stable frame count
  const directionalAsc  = {}; // semi → count when pitch was rising into it
  const directionalDesc = {}; // semi → count when pitch was falling into it

  let runStart = 0;
  for (let i = 1; i <= smoothed.length; i++) {
    if (i === smoothed.length || smoothed[i] !== smoothed[i - 1]) {
      const runLen = i - runStart;
      const semi = smoothed[runStart];
      if (runLen >= MIN_RUN) {
        histogram[semi] = (histogram[semi] || 0) + runLen;
        // Direction: compare to previous stable plateau
        if (runStart > 0) {
          const prevSemi = smoothed[runStart - 1];
          if (semi > prevSemi || (semi < prevSemi && Math.abs(semi - prevSemi) > 6)) {
            directionalAsc[semi] = (directionalAsc[semi] || 0) + runLen;
          }
          if (semi < prevSemi || (semi > prevSemi && Math.abs(semi - prevSemi) > 6)) {
            directionalDesc[semi] = (directionalDesc[semi] || 0) + runLen;
          }
        } else {
          directionalAsc[semi]  = (directionalAsc[semi]  || 0) + runLen;
          directionalDesc[semi] = (directionalDesc[semi] || 0) + runLen;
        }
      }
      runStart = i;
    }
  }

  // STEP 3: Threshold + Top-K — Carnatic ragas have at most 7 distinct swaras
  // (sampurna) per direction. Take the top-8 most prominent semitones by
  // stable-frame weight, then apply a relative-prominence cutoff (drop any
  // semitone with <25% the weight of the most common one — these are
  // passing tones / gamaka transients / percussion bleed, not scale notes).
  const totalStableFrames = Object.values(histogram).reduce((s, v) => s + v, 0) || 1;
  const ranked = Object.entries(histogram)
    .map(([semi, count]) => ({ semi: parseInt(semi), count, pct: count / totalStableFrames }))
    .sort((a, b) => b.count - a.count);

  const maxCount = ranked[0]?.count || 1;
  const RELATIVE_CUTOFF = 0.22;  // keep semis with ≥22% of the strongest semitone's weight
  const MAX_SWARAS = 8;          // hard cap — even sampurna ragas have ≤7 notes (+ octave Sa)

  const significantSemis = ranked
    .filter(r => r.count / maxCount >= RELATIVE_CUTOFF)
    .slice(0, MAX_SWARAS)
    .map(r => r.semi);

  // Build ascending/descending sets, but restrict to significant semitones only
  const ascSet  = new Set(Object.keys(directionalAsc).map(Number).filter(s => significantSemis.includes(s)));
  const descSet = new Set(Object.keys(directionalDesc).map(Number).filter(s => significantSemis.includes(s)));

  // Always include Sa(0) if present at all (tonic anchor)
  if (significantSemis.includes(0)) { ascSet.add(0); descSet.add(0); }

  // Fallback: if filtering removed everything, use raw significant semis for both directions
  if (ascSet.size === 0)  significantSemis.forEach(s => ascSet.add(s));
  if (descSet.size === 0) significantSemis.forEach(s => descSet.add(s));

  return {
    ascending:  [...ascSet].sort((a, b) => a - b),
    descending: [...descSet].sort((a, b) => a - b),
    histogram,           // exposed for debugging/UI confidence display
    totalStableFrames,
  };
}

// ── Main: analyse PCM samples → pitch data + scale ─────────────────────
function analysePitch(samples, sr) {
  const frames = Math.floor((samples.length - FRAME) / HOP);
  const pitchFrames = [];

  for (let f = 0; f < frames; f++) {
    const off   = f * HOP;
    const frame = samples.slice(off, off + FRAME);
    const energy = rms(frame);

    if (energy < 0.006) {     // higher floor — skip quiet/silent passages
      pitchFrames.push(null);
      continue;
    }

    const { freq, clarity } = yinPitch(frame, sr);
    // Require high periodicity confidence — rejects percussion transients & noise
    if (!freq || freq < 140 || freq > 900 || clarity < 0.55) {  // <140Hz = tambura drone, >900Hz = noise
      pitchFrames.push(null);
      continue;
    }

    pitchFrames.push({ freq: +freq.toFixed(2), energy: +energy.toFixed(4), clarity: +clarity.toFixed(3) });
  }

  // Detect Sa (tonic)
  const voiced = pitchFrames.filter(Boolean);
  const sa_hz  = detectSaHz(voiced);

  // Map each frame to shruti entry + semitone
  const mapped = pitchFrames.map(f => {
    if (!f) return null;
    const entry = hzToShrutiEntry(f.freq, sa_hz);
    return { ...f, semi: entry.semi, swara: entry.swara, shruti: entry.id, western: entry.western };
  });

  // Extract ascending / descending semitone sets
  const { ascending, descending } = extractDirectionalSemis(mapped, sa_hz);

  // Build display strings
  const aroha   = ascending.map(s  => SEMI_TO_SWARA_PRIMARY[s]  || String(s)).join(' ');
  const avaroha = descending.map(s => SEMI_TO_SWARA_PRIMARY[s]  || String(s)).join(' ');
  const arohaW  = ascending.map(s  => SEMI_TO_WESTERN[s]        || '?').join(' - ');
  const avarohaW= descending.map(s => SEMI_TO_WESTERN[s]        || '?').join(' - ');

  // Detect western pitch of Sa
  const saMidi    = Math.round(12 * Math.log2(sa_hz / 440) + 69);
  const noteNames = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
  const saWestern = noteNames[((saMidi % 12) + 12) % 12] + Math.floor(saMidi / 12 - 1);

  return {
    sa_hz:         +sa_hz.toFixed(2),
    sa_western:    saWestern,
    sa_midi:       saMidi,
    ascSemis:      ascending,
    descSemis:     descending,
    detectedAroha:    aroha,
    detectedAvaroha:  avaroha,
    detectedArohaWestern:  arohaW,
    detectedAvarohaWestern:avarohaW,
    pitchFrames:   mapped.slice(0, 200),   // sample for UI display
    voicedFrames:  voiced.length,
    totalFrames:   frames,
    voicedRatio:   +(voiced.length / Math.max(1, frames)).toFixed(3),
  };
}


// ── Gamaka detection from pitch frame sequence ─────────────────────────
// Kampita = oscillation ±30-80 cents around a swara
// Meend   = smooth slide between swaras (linear transition)
// Sphurita = quick lower-swara touch + return
// Andolan  = slow wide oscillation
function detectGamakaSequence(frames, sa_hz) {
  const CENT = (f1,f2) => Math.abs(1200 * Math.log2(f1/f2));
  const gamakas = [];
  const WIN = 8; // ~90ms window at 22050Hz/512hop

  for(let i = WIN; i < frames.length - WIN; i++){
    const seg = frames.slice(i-WIN, i+WIN).filter(f=>f&&f.freq>0);
    if(seg.length < WIN) continue;
    const freqs = seg.map(f=>f.freq);
    const mean  = freqs.reduce((s,v)=>s+v,0)/freqs.length;
    const maxCent = Math.max(...freqs.map(f=>CENT(f,mean)));
    const first = freqs[0], last = freqs[freqs.length-1];

    if(maxCent > 30 && maxCent < 80){
      // Check if oscillating (kampita) vs sliding (meend)
      const reversals = freqs.filter((f,j)=>j>0&&j<freqs.length-1&&
        ((f>freqs[j-1]&&f>freqs[j+1])||(f<freqs[j-1]&&f<freqs[j+1]))).length;
      if(reversals >= 2){
        gamakas.push({type:'kampita', frame:i, cents:+maxCent.toFixed(1), freq:+mean.toFixed(1)});
      } else if(CENT(last,first) > 40){
        gamakas.push({type:'meend', frame:i, cents:+CENT(last,first).toFixed(1), fromHz:+first.toFixed(1), toHz:+last.toFixed(1)});
      }
    } else if(maxCent > 80){
      gamakas.push({type:'andolan', frame:i, cents:+maxCent.toFixed(1), freq:+mean.toFixed(1)});
    }
  }
  return gamakas;
}

module.exports = { analysePitch, yinPitch, extractDirectionalSemis, detectGamakaSequence };
