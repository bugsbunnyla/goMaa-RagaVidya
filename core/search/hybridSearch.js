const { searchANN } = require('../vector/annIndex');
const db = require('../db/sqlite');

async function search(queryVec, queryText = '', limit = 20) {
  const dbInstance = await db.getDb();
  
  // Vector search
  const vectorResults = queryVec && queryVec.length > 0
    ? searchANN(queryVec, limit)
    : [];
  
  // Text search on title/raga
  let textResults = [];
  if (queryText && queryText.trim()) {
    const q = `%${queryText.trim().toLowerCase()}%`;
    textResults = db.all(
      `SELECT id, title, raga, ragaNumber, aroha, avaroha, mood, artist, duration 
       FROM music 
       WHERE lower(title) LIKE ? OR lower(raga) LIKE ? OR lower(artist) LIKE ?
       LIMIT ?`,
      [q, q, q, limit]
    );
  }
  
  // Merge: vector results enriched with DB data
  const enriched = vectorResults.map(r => {
    const dbRow = db.get('SELECT * FROM music WHERE id = ?', [r.id]);
    return dbRow ? { ...dbRow, vectorScore: r.score } : r;
  });
  
  // Combine and deduplicate
  const seen = new Set();
  const combined = [...enriched, ...textResults].filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  
  return combined.slice(0, limit);
}

module.exports = { search };
