/**
 * Database SQLite (better-sqlite3). Semua query terpusat di file ini.
 *
 * Tabel:
 * - suppliers        : nomor WA tukang sayur
 * - supplier_mappings: pemetaan supplier → produk / kategori (1 supplier = banyak mapping)
 * - outbox           : antrean pesan WA (pola outbox: order tak boleh gagal gara-gara WA)
 * - notify_log       : ringkasan tiap order yang masuk (untuk dashboard)
 * - settings         : key-value (mis. nomor admin, nama toko)
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

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,               -- format 628xxx
  active       INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_phone ON suppliers(phone);

CREATE TABLE IF NOT EXISTS supplier_mappings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  mapping_type  TEXT NOT NULL,               -- 'product' | 'category'
  ref_id        TEXT NOT NULL,               -- id produk atau id kategori
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(supplier_id, mapping_type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_map_lookup ON supplier_mappings(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_map_search ON supplier_mappings(mapping_type, ref_id);

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

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT NOT NULL UNIQUE,
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  address       TEXT DEFAULT '',
  note          TEXT DEFAULT '',
  delivery_slot TEXT DEFAULT '',
  payment_method TEXT DEFAULT '',
  total         INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'pending', -- pending|confirmed|preparing|shipping|delivered|cancelled
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`);

// ---------- Migration: convert old single-mapping suppliers → multi-mapping ----------
try {
  const cols = db.prepare(`PRAGMA table_info(suppliers)`).all().map((c) => c.name);
  if (cols.includes("mapping_type")) {
    console.log("[DB] Migrasi: memindahkan mapping lama ke supplier_mappings...");
    const rows = db.prepare(`SELECT id, name, phone, mapping_type, ref_id, active FROM suppliers`).all();
    const insertMap = db.prepare(
      `INSERT OR IGNORE INTO supplier_mappings (supplier_id, mapping_type, ref_id) VALUES (?, ?, ?)`
    );
    db.pragma("foreign_keys = OFF");  // disable FK so DROP TABLE suppliers doesn't cascade-delete mappings
    const migrate = db.transaction(() => {
      for (const r of rows) {
        if (r.mapping_type && r.ref_id) {
          insertMap.run(r.id, r.mapping_type, r.ref_id);
        }
      }
      // Recreate table without mapping_type/ref_id (SQLite < 3.35 doesn't support DROP COLUMN)
      db.exec(`
        CREATE TABLE suppliers_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL,
          phone        TEXT NOT NULL,
          active       INTEGER DEFAULT 1,
          created_at   TEXT DEFAULT (datetime('now')),
          updated_at   TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO suppliers_new (id, name, phone, active, created_at, updated_at)
          SELECT id, name, phone, active, created_at, updated_at FROM suppliers;
        DROP TABLE suppliers;
        ALTER TABLE suppliers_new RENAME TO suppliers;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_phone ON suppliers(phone);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_supplier_map_lookup ON supplier_mappings(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_supplier_map_search ON supplier_mappings(mapping_type, ref_id);
      `);
    });
    migrate();
    db.pragma("foreign_keys = ON");  // re-enable FK
    console.log(`[DB] Migrasi selesai: ${rows.length} supplier dipindahkan.`);
  }
} catch (e) {
  // If migration fails (e.g. fresh DB with no mapping_type), just continue
  console.warn("[DB] Migration check skipped:", e.message);
}

const setDefault = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
setDefault.run("shop_name", "Sayur Sukabumi");

// ---------- Suppliers ----------
export const supplierQueries = {
  create: db.prepare(
    `INSERT INTO suppliers (name, phone, active) VALUES (@name, @phone, @active)`
  ),
  update: db.prepare(
    `UPDATE suppliers SET name=@name, phone=@phone, active=@active,
       updated_at=datetime('now') WHERE id=@id`
  ),
  delete: db.prepare(`DELETE FROM suppliers WHERE id = ?`),
  findById: db.prepare(`SELECT * FROM suppliers WHERE id = ?`),
  findByPhone: db.prepare(`SELECT * FROM suppliers WHERE phone = ?`),
  all: db.prepare(`SELECT * FROM suppliers ORDER BY name`),
  allWithMappings: db.prepare(`
    SELECT s.*,
      GROUP_CONCAT(sm.mapping_type || ':' || sm.ref_id, '|') AS mappings_raw
    FROM suppliers s
    LEFT JOIN supplier_mappings sm ON sm.supplier_id = s.id
    GROUP BY s.id
    ORDER BY s.name
  `),
};

// ---------- Supplier Mappings ----------
export const mappingQueries = {
  insert: db.prepare(
    `INSERT OR IGNORE INTO supplier_mappings (supplier_id, mapping_type, ref_id)
     VALUES (@supplier_id, @mapping_type, @ref_id)`
  ),
  deleteBySupplier: db.prepare(`DELETE FROM supplier_mappings WHERE supplier_id = ?`),
  findBySupplier: db.prepare(
    `SELECT * FROM supplier_mappings WHERE supplier_id = ? ORDER BY mapping_type, ref_id`
  ),
  activeByMap: db.prepare(
    `SELECT sm.*, s.name AS supplier_name, s.phone AS supplier_phone
     FROM supplier_mappings sm
     JOIN suppliers s ON s.id = sm.supplier_id AND s.active = 1
     WHERE sm.mapping_type = ? AND sm.ref_id = ?`
  ),
};

/** Replace all mappings for a supplier (transaction-safe). */
export const replaceMappings = db.transaction((supplierId, mappings) => {
  mappingQueries.deleteBySupplier.run(supplierId);
  for (const m of mappings) {
    mappingQueries.insert.run({
      supplier_id: supplierId,
      mapping_type: m.mapping_type,
      ref_id: m.ref_id,
    });
  }
});

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

// ---------- Orders ----------
export const orderQueries = {
  create: db.prepare(
    `INSERT INTO orders (order_id, customer_name, customer_phone, address, note, delivery_slot, payment_method, total, status)
     VALUES (@order_id, @customer_name, @customer_phone, @address, @note, @delivery_slot, @payment_method, @total, @status)`
  ),
  findAll: db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`),
  findById: db.prepare(`SELECT * FROM orders WHERE order_id = ?`),
  updateStatus: db.prepare(
    `UPDATE orders SET status = @status, updated_at = datetime('now') WHERE order_id = @order_id`
  ),
  stats: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status='preparing' THEN 1 ELSE 0 END) AS preparing,
      SUM(CASE WHEN status='shipping' THEN 1 ELSE 0 END) AS shipping,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM orders
  `),
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
