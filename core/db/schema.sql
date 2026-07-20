CREATE TABLE IF NOT EXISTS music (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT,
  raga TEXT,
  ragaNumber INTEGER,
  aroha TEXT,
  avaroha TEXT,
  mood TEXT,
  gamakas TEXT,
  tala TEXT,
  tempo REAL,
  duration REAL,
  filePath TEXT,
  embedding TEXT,
  chromaVector TEXT,
  sections TEXT,
  sheetMusic TEXT,
  midiData TEXT,
  language TEXT,
  createdAt INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS fingerprint (
  hash TEXT NOT NULL,
  music_id TEXT NOT NULL,
  time_offset REAL DEFAULT 0,
  PRIMARY KEY (hash, music_id)
);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  music_id TEXT NOT NULL,
  type TEXT,
  raga TEXT,
  start_time REAL,
  end_time REAL,
  swaras TEXT,
  gamaka TEXT,
  stress TEXT,
  tala TEXT,
  lyrics TEXT
);
CREATE TABLE IF NOT EXISTS compositions (
  id TEXT PRIMARY KEY,
  title TEXT,
  raga TEXT,
  tala TEXT,
  tempo REAL,
  instruments TEXT,
  lyrics TEXT,
  sheetMusicXml TEXT,
  midiB64 TEXT,
  createdAt INTEGER DEFAULT (strftime('%s','now'))
);
