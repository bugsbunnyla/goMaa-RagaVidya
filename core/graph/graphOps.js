const db = require('../db/sqlite');

async function addEdge(fromId, toId, type, weight = 1.0) {
  await db.getDb();
  db.run(
    'INSERT OR REPLACE INTO edges (from_id, to_id, type, weight) VALUES (?, ?, ?, ?)',
    [fromId, toId, type, weight]
  );
}

async function getRelated(id, type = null, limit = 10) {
  await db.getDb();
  
  let sql = `
    SELECT e.to_id, e.type, e.weight, m.title, m.raga, m.artist, m.mood
    FROM edges e
    LEFT JOIN music m ON m.id = e.to_id
    WHERE e.from_id = ?
  `;
  const params = [id];
  
  if (type) {
    sql += ' AND e.type = ?';
    params.push(type);
  }
  
  sql += ' ORDER BY e.weight DESC LIMIT ?';
  params.push(limit);
  
  return db.all(sql, params);
}

async function buildRagaGraph() {
  await db.getDb();
  
  // Link songs of the same raga
  const ragas = db.all('SELECT DISTINCT raga FROM music WHERE raga IS NOT NULL');
  
  for (const { raga } of ragas) {
    const songs = db.all('SELECT id FROM music WHERE raga = ?', [raga]);
    for (let i = 0; i < songs.length; i++) {
      for (let j = i + 1; j < songs.length; j++) {
        db.run(
          'INSERT OR REPLACE INTO edges (from_id, to_id, type, weight) VALUES (?, ?, ?, ?)',
          [songs[i].id, songs[j].id, 'same_raga', 0.9]
        );
        db.run(
          'INSERT OR REPLACE INTO edges (from_id, to_id, type, weight) VALUES (?, ?, ?, ?)',
          [songs[j].id, songs[i].id, 'same_raga', 0.9]
        );
      }
    }
  }
  
  db.persist();
  return { ragasLinked: ragas.length };
}

module.exports = { addEdge, getRelated, buildRagaGraph };
