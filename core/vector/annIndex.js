/**
 * Approximate Nearest Neighbor index (in-memory).
 * No native binaries — pure JS implementation.
 */

const { cosineSimilarity } = require('../ai/audioEmbedding');

let _index = []; // { id, vector, metadata }

function buildIndex(entries) {
  _index = entries.map(e => ({
    id: e.id,
    vector: typeof e.embedding === 'string' 
      ? JSON.parse(e.embedding) 
      : (e.embedding || []),
    metadata: { title: e.title, raga: e.raga }
  }));
}

function addToIndex(id, vector, metadata = {}) {
  // Remove existing entry for same id
  _index = _index.filter(e => e.id !== id);
  _index.push({ id, vector, metadata });
}

function searchANN(queryVec, topK = 10) {
  if (_index.length === 0) return [];
  
  const scored = _index
    .filter(e => e.vector && e.vector.length > 0)
    .map(entry => ({
      id: entry.id,
      score: cosineSimilarity(queryVec, entry.vector),
      ...entry.metadata
    }));
  
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function getIndexSize() {
  return _index.length;
}

module.exports = { buildIndex, addToIndex, searchANN, getIndexSize };
