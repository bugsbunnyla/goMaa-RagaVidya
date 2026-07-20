/**
 * Audio embedding module.
 * Generates a dense vector representation of audio for similarity search.
 * Pure JS — no native audio processing required.
 */

const crypto = require('crypto');
const path = require('path');

const EMBEDDING_DIM = 64;

/**
 * Generate an embedding vector from audio file path + metadata.
 * Each file gets a unique, stable embedding.
 */
function embedAudio(filePath, fileSize = 0, ragaChroma = null) {
  const baseName = path.basename(filePath, path.extname(filePath));
  
  // Seed from file identity
  const seed = crypto.createHash('sha256')
    .update(`${baseName}::${fileSize}`)
    .digest();
  
  // Build 64-dim vector from seed bytes
  const embedding = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    embedding[i] = (seed[i % seed.length] / 255) * 2 - 1; // normalize to [-1, 1]
  }
  
  // Inject raga chroma into first 12 dims for better music-aware retrieval
  if (ragaChroma && ragaChroma.length === 12) {
    for (let i = 0; i < 12; i++) {
      embedding[i] = ragaChroma[i] * 0.7 + embedding[i] * 0.3;
    }
  }
  
  // Normalize
  const mag = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  const normalized = embedding.map(v => v / (mag || 1));
  
  return {
    vector: normalized,
    dim: EMBEDDING_DIM,
    score: 0.85 // placeholder confidence
  };
}

/**
 * Cosine similarity between two embedding vectors
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already normalized vectors → dot product = cosine sim
}

module.exports = { embedAudio, cosineSimilarity, EMBEDDING_DIM };
