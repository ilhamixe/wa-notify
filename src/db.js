/**
 * Database SQLite (better-sqlite3). Semua query terpusat di file ini.
 *
 * Tabel:
 * - suppliers  : nomor WA tukang sayur + pemetaan ke produk / kategori
 * - outbox     : antrean pesan WA (pola outbox: order tak boleh gagal gara-gara WA)
 * - notify_log : ringkasan tiap order yang masuk (untuk dashboard)
 * - settings   : key-value (mis. nomor admin, nama toko)
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import config from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.sessionDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,               -- format 628xxx
  mapping_type TEXT NOT NULL,               -- 'product' | 'category'
  ref_id       TEXT NOT NULL,               -- id produk atau id kategori
  active       INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
-- Satu nomor tidak boleh didaftarkan dua kali untuk target yang sama.
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_map
  ON suppliers(mapping_type, ref_id, phone);
CREATE INDEX IF NOT EXISTS idx_supplier_lookup ON suppliers(active, mapping_type, ref_id);

CREATE TABLE IF NOT EXISTS notify_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT NOT NULL,
  customer_name TEXT DEFAULT '',
  items_count   INTEGER DEFAULT 0,
  supplier_hits INTEGER DEFAULT 0,
  unmapped      TEXT DEFAULT '',            -- JSON: nama produk tanpa supplier
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notify_order ON notify_log(order_id);

CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        TEXT NOT NULL,
  supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name   TEXT DEFAULT '',
  to_jid          TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
  attempts        INTEGER DEFAULT 0,
  last_error      TEXT DEFAULT '',
  next_attempt_at TEXT DEFAULT (datetime('now')),
  sent_at         TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_order ON outbox(order_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
`);

const setDefault = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
setDefault.run("shop_name", "Sayur Sukabumi");

// ---------- Suppliers ----------
export const supplierQueries = {
  create: db.prepare(
    `INSERT INTO suppliers (name, phone, mapping_type, ref_id, active)
     VALUES (@name, @phone, @mapping_type, @ref_id, @active)`
  ),
  update: db.prepare(
    `UPDATE suppliers SET name=@name, phone=@phone, mapping_type=@mapping_type,
       ref_id=@ref_id, active=@active, updated_at=datetime('now') WHERE id=@id`
  ),
  delete: db.prepare(`DELETE FROM suppliers WHERE id = ?`),
  findById: db.prepare(`SELECT * FROM suppliers WHERE id = ?`),
  all: db.prepare(`SELECT * FROM suppliers ORDER BY mapping_type, name`),
  activeByMap: db.prepare(
    `SELECT * FROM suppliers WHERE active = 1 AND mapping_type = ? AND ref_id = ?`
  ),
};

// ---------- Outbox ----------
export const outboxQueries = {
  create: db.prepare(
    `INSERT INTO outbox (order_id, supplier_id, supplier_name, to_jid, body)
     VALUES (@order_id, @supplier_id, @supplier_name, @to_jid, @body)`
  ),
  due: db.prepare(
    `SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= datetime('now')
     ORDER BY id LIMIT ?`
  ),
  markSent: db.prepare(
    `UPDATE outbox SET status='sent', sent_at=datetime('now'), attempts = attempts + 1 WHERE id = ?`
  ),
  markRetry: db.prepare(
    `UPDATE outbox SET attempts = attempts + 1, last_error = ?,
       next_attempt_at = datetime('now', '+' || ? || ' minutes') WHERE id = ?`
  ),
  markFailed: db.prepare(
    `UPDATE outbox SET status='failed', attempts = attempts + 1, last_error = ? WHERE id = ?`
  ),
  recent: db.prepare(`SELECT * FROM outbox ORDER BY id DESC LIMIT ?`),
  byOrder: db.prepare(`SELECT * FROM outbox WHERE order_id = ? ORDER BY id`),
  stats: db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed
    FROM outbox
  `),
};

// ---------- Notify log ----------
export const notifyLogQueries = {
  create: db.prepare(
    `INSERT INTO notify_log (order_id, customer_name, items_count, supplier_hits, unmapped)
     VALUES (@order_id, @customer_name, @items_count, @supplier_hits, @unmapped)`
  ),
  findByOrder: db.prepare(`SELECT * FROM notify_log WHERE order_id = ?`),
  recent: db.prepare(`SELECT * FROM notify_log ORDER BY id DESC LIMIT ?`),
};

// ---------- Settings ----------
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
const allSettingsStmt = db.prepare(`SELECT key, value FROM settings`);

export const settings = {
  get: (key) => getSettingStmt.get(key)?.value ?? "",
  set: (key, value) => setSettingStmt.run(key, String(value)),
  all: () => Object.fromEntries(allSettingsStmt.all().map((r) => [r.key, r.value])),
};

export default db;
