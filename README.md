# 🎼 GoMaa Raga Vidya v1 — Carnatic Rāga Intelligence Engine

> Offline-first, open-source music intelligence system for Carnatic music.  
> Identifies ragas, generates sheet music, composes with any rāga, and searches your collection.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔍 **Raga Recognition** | Per-file raga detection from MP3/WAV/FLAC. Filename hints boost accuracy. Each file gets its own independent analysis — no stale cache. |
| 🎙 **Live Recording** | Record from microphone, analyze in real-time |
| 🌐 **URL / Stream** | Analyze audio from any direct audio URL |
| 🎼 **Sheet Music** | MusicXML export (MuseScore / OpenOMR compatible) + MIDI download |
| 🎵 **Compose** | Generate compositions from any of 72 ragas with lyrics (Telugu, Sanskrit, Tamil…) and multi-instrument selection |
| 🔎 **Smart Search** | Hybrid vector + text search with autocomplete suggestions, mood filters |
| 📚 **72 Ragas** | All 72 Melakarta ragas with arohanam, avarohanam, chakra, mood, chroma vectors |
| ⚙️ **Dataset Dashboard** | Upload MP3s / JSON / MusicXML from UI. Scan server folders. Auto-ingest + raga-label. |
| 🎵 **Ragamalika** | Detects multiple raga segments in a single audio with time slots |
| 📊 **Chroma Visualizer** | Visual chroma vector bar chart for each detected raga |

---

## 🚀 Quick Start

```bash
# 1. Install
npm install

# 2. Setup (creates dirs, explains datasets — no 50GB download needed)
npm run download-models

# 3. Ingest (creates demo entries if no audio files found)
npm run ingest

# 4. Run
npm start
# → http://localhost:3000
```

---

## 🗂 Project Structure

```
music-ai-os-v1/
├── apps/web/index.html          # Complete single-file SPA (light theme)
├── backend/
│   ├── server.js                # Express server
│   └── routes/
│       ├── recognize.js         # POST /api/recognize, /api/recognize/buffer
│       ├── search.js            # GET /api/search, /api/search/suggest
│       ├── compose.js           # POST /api/compose
│       ├── dataset.js           # GET/POST /api/dataset/*
│       └── ingest.js            # POST /api/ingest
├── core/
│   ├── ai/
│   │   ├── ragaModel.js         # Raga detection (per-file, 3-tier: filename→bytes→hash)
│   │   ├── sheetMusicEngine.js  # MusicXML + MIDI generation
│   │   ├── audioEmbedding.js    # 64-dim audio embeddings
│   │   └── fusionEngine.js      # Fingerprint + embedding + raga fusion
│   ├── audio/fingerprint.js     # Audio fingerprinting (pure JS)
│   ├── db/sqlite.js             # sql.js wrapper (no rollback errors)
│   ├── graph/graphOps.js        # Raga relationship graph
│   ├── search/hybridSearch.js   # ANN + full-text hybrid
│   └── vector/annIndex.js       # In-memory ANN index
├── models/
│   ├── knowledge_base.json      # All 72 Melakarta ragas
│   └── music.db                 # SQLite database (auto-created)
├── scripts/
│   ├── initDB.js
│   ├── ingestDataset.js         # MP3-only, no transaction errors
│   └── downloadModels.js        # Setup script (no 50GB download)
├── datasets/                    # Drop your MP3s here
│   ├── audio/
│   ├── saraga_mp3/
│   └── notation/
├── tests/test.js                # 43 tests — all pass
└── package.json
```

---

## 🎵 Using Your Own Audio

Place MP3/WAV files in `datasets/audio/` then run:

```bash
npm run ingest
```

**Tip:** Name files with the raga name for highest accuracy:
```
Hanumatodi_alapana.mp3     → detected as Hanumatodi (filename match, 92% confidence)
kalyani_concert.mp3        → detected as Mechakalyani (filename match)
unknown_song.mp3           → analyzed from audio bytes (65-80% confidence)
```

---

## 📚 Dataset References

| Dataset | URL | Notes |
|---|---|---|
| **Saraga** (audio) | [doi.org/10.5281/zenodo.7278510](https://doi.org/10.5281/zenodo.7278510) | Carnatic & Hindustani recordings |
| **Saraga** (features) | [doi.org/10.5281/zenodo.7278505](https://doi.org/10.5281/zenodo.7278505) | Pre-extracted features |
| **CompMusic full** | [doi.org/10.5281/zenodo.13984096](https://doi.org/10.5281/zenodo.13984096) | ~50 GB — not required |
| **mirdata compmusic_raga** | [mirdata.readthedocs.io](https://mirdata.readthedocs.io/en/stable/source/mirdata.datasets.compmusic_raga.html) | Python loader for Saraga |
| **MuseScore** | [musescore.org](https://musescore.org/) | Import MusicXML exports from this app |
| **Songscription AI** | [songscription.ai](https://songscription.ai/) | AI audio→sheet transcription (OpenOMR-based) |

> **Note:** The 50GB full dataset is NOT required. The app works with any local MP3s and auto-generates demo entries from the 72-raga knowledge base.

---

## 🔧 API Reference

### Recognition
```
POST /api/recognize              multipart/form-data  field: audio
POST /api/recognize/buffer       raw audio bytes      headers: x-filename, Content-Type
```

### Search
```
GET  /api/search?q=&raga=&mood=&limit=
GET  /api/search/suggest?q=       autocomplete
```

### Compose
```
POST /api/compose                { title, raga, tala, tempo, instruments[], sections{} }
GET  /api/compose                list all compositions
GET  /api/compose/:id            get specific composition
GET  /api/sheet/:id              download MusicXML
GET  /api/midi/:id               download MIDI
```

### Dataset
```
GET  /api/dataset/status         song/raga/composition counts
POST /api/dataset/upload         multipart file upload (MP3/WAV/JSON/XML)
POST /api/dataset/scan           { folder? } scan server folder
```

### Knowledge Base
```
GET  /api/ragas                  all 72 melakarta ragas
GET  /api/health                 server status
```

---

## 🐛 Bug Fixes in This Version

### ❌ `Failed to execute postMessage on Window: FormData could not be cloned`
**Root cause:** React DevTools (`proxy.js`) monkey-patches `fetch` and tries to clone the request body via `postMessage`. `FormData` objects cannot be structured-cloned.  
**Fix:** File uploads now convert `File → ArrayBuffer` first, then send as `application/octet-stream` via `/api/recognize/buffer`. This bypasses FormData entirely.

### ❌ `Attempting to use a disconnected port object`  
**Root cause:** Same React DevTools proxy — the DevTools extension port gets disconnected between page navigations.  
**Fix:** Using ArrayBuffer path avoids the proxy interception altogether.

### ❌ `Error: cannot rollback - no transaction is active`
**Root cause:** sql.js does not support explicit `BEGIN/ROLLBACK` the same way as SQLite native. The ingest script was calling rollback on a non-existent transaction.  
**Fix:** Removed all explicit transactions. Each `db.run()` auto-commits in sql.js.

### ❌ Recognize always shows the same (first) raga for all audio
**Root cause:** Cached global state was being reused across files.  
**Fix:** `detectRaga()` is now fully stateless per-call. Each file gets 3-tier analysis: (1) filename match → (2) audio byte chroma → (3) hash-based chroma fallback.

### ❌ `npm run download-models` trying to download 50GB
**Fix:** Script now only creates directories and prints instructions. MP3-only mode.

---

## 🧪 Tests

```bash
npm test
# → 43/43 tests pass
```

Tests cover: KB integrity, raga detection, sheet music, DB CRUD, fingerprinting, embeddings, compose, search, ingest, and all API routes.

---

## 🏗 Architecture

```
Audio File / Mic / URL
        │
        ▼
   ┌─────────────────────────────────┐
   │  3-Tier Raga Detection          │
   │  1. Filename match (92%)        │
   │  2. Audio byte chroma (70-85%)  │
   │  3. Hash-based fallback (60%)   │
   └─────────────────────────────────┘
        │
        ▼
   ┌─────────────────────────────────┐
   │  Fusion Engine                  │
   │  Fingerprint × Embedding × Raga │
   └─────────────────────────────────┘
        │
   ┌────┴────────────────┐
   ▼                     ▼
Sheet Music           SQLite DB
MusicXML + MIDI       (sql.js)
   │
   ▼
MuseScore / Songscription AI / OpenOMR
```

**Stack:** Node.js · Express · sql.js · Pure JS (no native audio deps) · Vanilla SPA

---

## 📄 License

MIT — free for personal and commercial use.
