/**
 * Fusion engine: combines fingerprint match, embedding similarity, and raga detection
 * into a unified recognition result.
 */

function fuse(fpMatch, embedResult, ragaResult) {
  // Weights: fingerprint is most reliable for exact ID,
  // embedding for similarity, raga for musical context
  const fpScore   = fpMatch  ? (fpMatch.score  || 0) : 0;
  const embedScore = embedResult ? (embedResult.score || 0) : 0;
  const ragaScore  = ragaResult  ? (ragaResult.score  || 0) : 0;

  const fusedScore = fpScore * 0.5 + embedScore * 0.3 + ragaScore * 0.2;

  return {
    id:         fpMatch?.id        || null,
    title:      fpMatch?.title     || null,
    score:      parseFloat(fusedScore.toFixed(3)),
    raga:       ragaResult?.label  || null,
    ragaNumber: ragaResult?.ragaNumber || null,
    aroha:      ragaResult?.aroha  || null,
    avaroha:    ragaResult?.avaroha || null,
    mood:       ragaResult?.mood   || null,
    gamakas:    ragaResult?.gamakas || [],
    confidence: fpScore > 0.8 ? 'high' : fpScore > 0.5 ? 'medium' : 'low',
    topCandidates: ragaResult?.topCandidates || [],
    matchType:  fpMatch?.matchType || 'new'
  };
}

module.exports = { fuse };
