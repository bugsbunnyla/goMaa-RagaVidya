'use strict';
/**
 * Decode any audio file (MP3/WAV/WebM/FLAC/OGG/M4A) to raw PCM Float32 samples
 * using ffmpeg (system binary). This replaces the byte-chroma proxy with
 * real decoded audio for pitch/tala/scale detection.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGET_SR = 22050; // sufficient for vocal pitch range (up to ~1.5kHz fundamental)

/**
 * Decode audio file to mono Float32Array PCM samples at TARGET_SR.
 * @param {string} filePath
 * @returns {{samples: Float32Array, sr: number, duration: number}}
 */
function decodeToFloatPCM(filePath) {
  const tmpRaw = path.join(os.tmpdir(), `gomaa_pcm_${Date.now()}_${Math.random().toString(36).slice(2)}.raw`);
  try {
    execFileSync('ffmpeg', [
      '-y', '-i', filePath,
      '-f', 'f32le',          // 32-bit float PCM
      '-acodec', 'pcm_f32le',
      '-ac', '1',              // mono
      '-ar', String(TARGET_SR),
      tmpRaw
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 });

    const buf = fs.readFileSync(tmpRaw);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const duration = samples.length / TARGET_SR;

    return { samples, sr: TARGET_SR, duration };
  } catch (e) {
    throw new Error('ffmpeg decode failed: ' + e.message);
  } finally {
    try { fs.unlinkSync(tmpRaw); } catch (_) {}
  }
}

/** Check if ffmpeg is available */
function isFFmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (_) { return false; }
}

module.exports = { decodeToFloatPCM, isFFmpegAvailable, TARGET_SR };
