'use strict';
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH     = path.join(__dirname, '../../models/music.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db  = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(Buffer.from(fs.readFileSync(DB_PATH)));
  } else {
    db = new SQL.Database();
  }
  // apply schema statement by statement - no multi-statement transactions
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  schema.split(';').map(s=>s.trim()).filter(Boolean).forEach(s => {
    try { db.run(s+';'); } catch(_) {}
  });
  _save();
  return db;
}

function _save() {
  if (!db) return;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive:true });
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  } catch(e) { console.error('DB save:', e.message); }
}

function run(sql, params=[]) {
  if (!db) throw new Error('DB not initialised');
  try { db.run(sql, params); _save(); return true; }
  catch(e) { console.error('DB run:', e.message); return false; }
}

function get(sql, params=[]) {
  if (!db) return null;
  try {
    const st = db.prepare(sql); st.bind(params);
    const row = st.step() ? st.getAsObject() : null;
    st.free(); return row;
  } catch(e) { console.error('DB get:', e.message); return null; }
}

function all(sql, params=[]) {
  if (!db) return [];
  try {
    const rows=[], st=db.prepare(sql); st.bind(params);
    while(st.step()) rows.push(st.getAsObject());
    st.free(); return rows;
  } catch(e) { console.error('DB all:', e.message); return []; }
}

function persist() { _save(); }

module.exports = { getDb, run, get, all, persist };
