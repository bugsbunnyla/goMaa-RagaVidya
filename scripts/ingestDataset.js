/**
 * Ingest dataset from local MP3 files.
 * - MP3-only mode: no Saraga annotations/JSON required
 * - No explicit transactions (avoids sql.js rollback errors)
 * - Works with any folder of MP3s
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../core/db/sqlite');
const { detectRaga } = require('../core/ai/ragaModel');
const { embedAudio } = require('../core/ai/audioEmbedding');
const { generateFingerprint } = require('../core/audio/fingerprint');
const { addToIndex } = require('../core/vector/annIndex');
const { addEdge } = require('../core/graph/graphOps');

const DATASET_DIRS = [
  path.join(__dirname, '../datasets/saraga_mp3'),
  path.join(__dirname, '../datasets/audio'),
  path.join(__dirname, '../datasets/mp3'),
  path.join(__dirname, '../datasets'),
];

function findMp3Files(dirPath, maxDepth = 3) {
  const files = [];
  if (!fs.existsSync(dirPath)) return files;
  
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (/\.(mp3|wav|flac|ogg)$/i.test(entry)) {
          files.push({ filePath: full, size: stat.size });
        }
      } catch (e) { /* skip */ }
    }
  }
  
  walk(dirPath, 0);
  return files;
}

function extractTitleFromPath(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // Clean up common filename patterns
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\d{4}\b/g, '')    // remove years
    .replace(/\s+/g, ' ')
    .trim();
}

function extractArtistFromPath(filePath) {
  const parts = filePath.split(path.sep);
  // Artist is often the parent folder name
  if (parts.length >= 2) {
    return parts[parts.length - 2].replace(/[-_]+/g, ' ').trim();
  }
  return 'Unknown Artist';
}

async function ingestFile(filePath, fileSize) {
  const dbInstance = await db.getDb();
  
  const id = crypto.createHash('md5')
    .update(filePath)
    .digest('hex');
  
  // Skip if already ingested
  const existing = db.get('SELECT id FROM music WHERE id = ?', [id]);
  if (existing) {
    return { status: 'skipped', id };
  }
  
  const title = extractTitleFromPath(filePath);
  const artist = extractArtistFromPath(filePath);
  
  // Per-file raga detection (each file gets its own analysis)
  const raga = detectRaga(filePath, fileSize);
  
  // Generate embedding with raga-aware chroma
  const embed = embedAudio(filePath, fileSize, raga.topCandidates ? null : null);
  
  // Generate fingerprint
  const fp = generateFingerprint(filePath);
  
  // Estimate duration (rough: 1MB ≈ 60s for 128kbps MP3)
  const duration = fileSize > 0 ? Math.round(fileSize / 16000) : 0;
  
  // Insert into DB (no explicit transaction - let sql.js auto-commit)
  const ok = db.run(
    `INSERT OR REPLACE INTO music 
     (id, title, artist, raga, ragaNumber, aroha, avaroha, mood, gamakas, 
      duration, filePath, embedding, chromaVector, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`,
    [
      id,
      title,
      artist,
      raga.label,
      raga.ragaNumber,
      raga.aroha,
      raga.avaroha,
      raga.mood,
      JSON.stringify(raga.gamakas || []),
      duration,
      filePath,
      JSON.stringify(embed.vector),
      JSON.stringify(raga.topCandidates || [])
    ]
  );
  
  if (!ok) return { status: 'error', id };
  
  // Insert fingerprint hashes
  db.run(
    'INSERT OR REPLACE INTO fingerprint (hash, music_id, time_offset) VALUES (?, ?, ?)',
    [fp.hash, id, 0]
  );
  
  // Add to vector index
  addToIndex(id, embed.vector, { title, raga: raga.label });
  
  return { status: 'inserted', id, title, raga: raga.label };
}

async function ingestSaraga() {
  console.log('\n🎵 Music AI OS — Dataset Ingestion (MP3 Mode)\n');
  
  // Find all MP3 files
  let allFiles = [];
  for (const dir of DATASET_DIRS) {
    const found = findMp3Files(dir);
    if (found.length > 0) {
      console.log(`  Found ${found.length} audio files in ${dir}`);
      allFiles = allFiles.concat(found);
    }
  }
  
  if (allFiles.length === 0) {
    console.log('⚠️  No MP3/audio files found in dataset directories.');
    console.log('   Creating demo entries from raga knowledge base...\n');
    await ingestDemoEntries();
    return;
  }
  
  console.log(`\n📀 Processing ${allFiles.length} files...\n`);
  
  let inserted = 0, skipped = 0, errors = 0;
  
  for (const { filePath, size } of allFiles) {
    try {
      const result = await ingestFile(filePath, size);
      if (result.status === 'inserted') {
        inserted++;
        if (inserted % 10 === 0) {
          console.log(`  ✅ ${inserted} ingested... (${path.basename(filePath)})`);
        }
      } else if (result.status === 'skipped') {
        skipped++;
      } else {
        errors++;
      }
    } catch (e) {
      console.error(`  ❌ Error processing ${path.basename(filePath)}: ${e.message}`);
      errors++;
    }
  }
  
  db.persist();
  
  console.log(`\n✅ Ingestion complete:`);
  console.log(`   Inserted: ${inserted}`);
  console.log(`   Skipped:  ${skipped}`);
  console.log(`   Errors:   ${errors}`);
}

/**
 * Create demo entries from the 72-raga knowledge base
 * so the app works even without actual audio files.
 */
async function ingestDemoEntries() {
  const KB_PATH = path.join(__dirname, '../models/knowledge_base.json');
  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  
  // Famous Carnatic compositions mapped to ragas
  const demoSongs = [
    { title: 'Nagumomu', raga: 'Abheri',   artist: 'Tyagaraja',    tala: 'Adi' },
    { title: 'Vatapi Ganapatim', raga: 'Hamsadhwani', artist: 'Muthuswami Dikshitar', tala: 'Adi' },
    { title: 'Endaro Mahanubhavulu', raga: 'Sri', artist: 'Tyagaraja', tala: 'Adi' },
    { title: 'Ninnu Kori', raga: 'Mohanam', artist: 'Tyagaraja',   tala: 'Adi' },
    { title: 'Brochevarevarura', raga: 'Kambhoji', artist: 'Mysore Vasudevachar', tala: 'Adi' },
    { title: 'Shankari Shankuru', raga: 'Saveri', artist: 'Papanasam Sivan', tala: 'Misra Chapu' },
    { title: 'Manasa Sancharare', raga: 'Reeti Gowla', artist: 'Tyagaraja', tala: 'Rupakam' },
    { title: 'Enta Muddo', raga: 'Bindumalini', artist: 'Tyagaraja', tala: 'Adi' },
    { title: 'Marugelara', raga: 'Jayantasri', artist: 'Tyagaraja', tala: 'Adi' },
    { title: 'Nee Irangai', raga: 'Atana', artist: 'Tyagaraja', tala: 'Adi' },
  ];
  
  // Also add one entry per melakarta raga
  const melakartas = kb.ragas.slice(0, 36); // first 36 for demo
  
  for (const song of demoSongs) {
    const id = crypto.createHash('md5').update(song.title).digest('hex');
    const existing = db.get('SELECT id FROM music WHERE id = ?', [id]);
    if (existing) continue;
    
    // Find raga details from KB (use Dheerasankarabharanam as fallback)
    const ragaInfo = kb.ragas.find(r => 
      r.name.toLowerCase().includes(song.raga.toLowerCase()) ||
      song.raga.toLowerCase().includes(r.name.toLowerCase().split(' ')[0])
    ) || kb.ragas[28]; // Dheerasankarabharanam
    
    const embed = embedAudio(song.title, 0, ragaInfo.chroma);
    
    db.run(
      `INSERT OR REPLACE INTO music 
       (id, title, artist, raga, ragaNumber, aroha, avaroha, mood, gamakas, 
        tala, duration, filePath, embedding, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`,
      [
        id, song.title, song.artist,
        ragaInfo.name, ragaInfo.number,
        ragaInfo.aroha, ragaInfo.avaroha,
        ragaInfo.mood, JSON.stringify(ragaInfo.gamakas || []),
        song.tala, 240,
        `demo://${song.title.toLowerCase().replace(/\s/g, '_')}.mp3`,
        JSON.stringify(embed.vector)
      ]
    );
    
    addToIndex(id, embed.vector, { title: song.title, raga: ragaInfo.name });
    console.log(`  🎵 Demo: ${song.title} → ${ragaInfo.name}`);
  }
  
  for (const raga of melakartas) {
    const id = crypto.createHash('md5').update(`melakarta::${raga.number}`).digest('hex');
    const existing = db.get('SELECT id FROM music WHERE id = ?', [id]);
    if (existing) continue;
    
    const title = `${raga.name} — Melakarta Alapana`;
    const embed = embedAudio(title, 0, raga.chroma);
    
    db.run(
      `INSERT OR REPLACE INTO music 
       (id, title, artist, raga, ragaNumber, aroha, avaroha, mood, gamakas, 
        duration, filePath, embedding, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`,
      [
        id, title, 'Demo Entry',
        raga.name, raga.number,
        raga.aroha, raga.avaroha,
        raga.mood, JSON.stringify(raga.gamakas || []),
        180,
        `demo://melakarta_${raga.number}_${raga.name.toLowerCase().replace(/\s/g, '_')}.mp3`,
        JSON.stringify(embed.vector)
      ]
    );
    
    addToIndex(id, embed.vector, { title, raga: raga.name });
  }
  
  db.persist();
  console.log(`\n✅ Demo entries created successfully.\n`);
}

async function main() {
  try {
    await db.getDb();
    await ingestSaraga();
  } catch (e) {
    console.error('Fatal ingest error:', e.message);
    process.exit(1);
  }
}

main();
