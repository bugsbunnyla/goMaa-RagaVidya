#!/usr/bin/env node
/**
 * Model & dataset setup script.
 * 
 * WHAT WE DOWNLOAD:
 *   - knowledge_base.json (already bundled — 72 ragas, no download needed)
 *   - Saraga metadata JSON (small, ~5MB) - OPTIONAL
 * 
 * WHAT WE SKIP:
 *   - 50GB audio from Zenodo (not needed — app works with local MP3s)
 *   - compmusic / mirdata (Python only — not needed for JS backend)
 *   - OpenOMR notation files (optional future feature)
 * 
 * HOW TO USE YOUR OWN MP3s:
 *   Place any MP3 files in:  datasets/  folder
 *   Then run:  npm run ingest
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODELS_DIR = path.join(__dirname, '../models');
const DATASETS_DIR = path.join(__dirname, '../datasets');

function ensureDirs() {
  [MODELS_DIR, DATASETS_DIR, 
   path.join(DATASETS_DIR, 'saraga_mp3'),
   path.join(DATASETS_DIR, 'audio')
  ].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

function checkKnowledgeBase() {
  const kb = path.join(MODELS_DIR, 'knowledge_base.json');
  if (fs.existsSync(kb)) {
    const data = JSON.parse(fs.readFileSync(kb, 'utf8'));
    console.log(`✅ Knowledge base: ${data.ragas.length} ragas loaded`);
    return true;
  }
  console.log('⚠️  knowledge_base.json not found — will use built-in ragas');
  return false;
}

function printDatasetInstructions() {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎵 MUSIC AI OS — DATASET SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 The app works with LOCAL MP3 FILES — no 50GB download needed!

 ► OPTION 1: Use your own Carnatic MP3s
   Drop any MP3 files into:  datasets/audio/
   Then run:  npm run ingest

 ► OPTION 2: Download Saraga samples (free, small subset)
   Visit: https://zenodo.org/record/7278510
   Download a few MP3s and put in:  datasets/saraga_mp3/

 ► OPTION 3: Run with demo data (works immediately!)
   Just run:  npm run ingest
   The app creates demo entries from the 72-raga knowledge base.

 ► REFERENCES (for your records):
   • Saraga audio:    https://doi.org/10.5281/zenodo.7278510  
   • Saraga features: https://doi.org/10.5281/zenodo.7278505
   • CompMusic:       https://compmusic.upf.edu/
   • mirdata docs:    https://mirdata.readthedocs.io/
   • MuseScore:       https://musescore.org/
   • OpenOMR/AI:      https://www.songscription.ai/

 ℹ️  All 72 Melakarta ragas are pre-loaded in knowledge_base.json
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function main() {
  console.log('\n🎼 Music AI OS — Model Setup\n');
  ensureDirs();
  checkKnowledgeBase();
  printDatasetInstructions();
  console.log('✅ Setup complete. Run: npm run ingest\n');
}

main().catch(console.error);
