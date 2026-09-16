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
  lat           REAL,
  lng           REAL,
  total         INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'pending', -- pending|confirmed|preparing|shipping|delivered|cancelled
  courier_name  TEXT DEFAULT '',
  courier_phone TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT NOT NULL,
  product_id    TEXT DEFAULT '',
  category      TEXT DEFAULT '',
  name          TEXT NOT NULL,
  qty           INTEGER DEFAULT 1,
  price         INTEGER DEFAULT 0,
  unit          TEXT DEFAULT '',
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  category        TEXT DEFAULT '',
  category_label  TEXT DEFAULT '',
  price           INTEGER DEFAULT 0,
  original_price  INTEGER,
  unit            TEXT DEFAULT '',
  weight_grams    INTEGER DEFAULT 0,
  stock           INTEGER DEFAULT 0,
  rating          REAL DEFAULT 0,
  reviews_count   INTEGER DEFAULT 0,
  image           TEXT DEFAULT '',
  badge           TEXT DEFAULT '',
  origin          TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  benefits        TEXT DEFAULT '[]',
  storage_tips    TEXT DEFAULT '',
  is_organic      INTEGER DEFAULT 0,
  active          INTEGER DEFAULT 1,
  sort_order      INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS vouchers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  discount_percent INTEGER DEFAULT 0,
  min_spend       INTEGER DEFAULT 0,
  description     TEXT DEFAULT '',
  active          INTEGER DEFAULT 1,
  max_uses        INTEGER DEFAULT 0,
  used_count      INTEGER DEFAULT 0,
  expires_at      TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_active ON vouchers(active);
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

// ---------- Migration: add lat/lng to orders if missing ----------
try {
  const orderCols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
  if (!orderCols.includes("lat")) {
    db.exec(`ALTER TABLE orders ADD COLUMN lat REAL`);
    db.exec(`ALTER TABLE orders ADD COLUMN lng REAL`);
    console.log("[DB] Migrasi: menambahkan kolom lat/lng ke orders");
  }
  if (!orderCols.includes("courier_name")) {
    db.exec(`ALTER TABLE orders ADD COLUMN courier_name TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE orders ADD COLUMN courier_phone TEXT DEFAULT ''`);
    console.log("[DB] Migrasi: menambahkan kolom courier_name/courier_phone ke orders");
  }
} catch (e) {
  console.warn("[DB] Migration orders skipped:", e.message);
}

const setDefault = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
setDefault.run("shop_name", "Sayur Sukabumi");
setDefault.run("delivery_center_lat", "-6.9175");
setDefault.run("delivery_center_lng", "106.9230");
setDefault.run("delivery_max_km", "10");
setDefault.run("delivery_polygon", "[]");
setDefault.run("payment_qris", "1");
setDefault.run("payment_transfer", "1");
setDefault.run("payment_cod", "1");
setDefault.run("payment_qris_image", "");
setDefault.run("couriers", "[]");

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
    `INSERT INTO orders (order_id, customer_name, customer_phone, address, note, delivery_slot, payment_method, lat, lng, total, status)
     VALUES (@order_id, @customer_name, @customer_phone, @address, @note, @delivery_slot, @payment_method, @lat, @lng, @total, @status)`
  ),
  assignCourier: db.prepare(
    `UPDATE orders SET courier_name=@courier_name, courier_phone=@courier_phone, updated_at=datetime('now') WHERE order_id=@order_id`
  ),
  findAll: db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`),
  findById: db.prepare(`SELECT * FROM orders WHERE order_id = ?`),
  findByDateRange: db.prepare(`SELECT * FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY id DESC`),
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
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0) AS revenue
    FROM orders
  `),
  statsByDateRange: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status='preparing' THEN 1 ELSE 0 END) AS preparing,
      SUM(CASE WHEN status='shipping' THEN 1 ELSE 0 END) AS shipping,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0) AS revenue
    FROM orders WHERE created_at >= ? AND created_at < ?
  `),
  revenueByMonth: db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) AS month,
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END) AS revenue,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered
    FROM orders
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `),
  revenueByDay: db.prepare(`
    SELECT
      date(created_at) AS day,
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END) AS revenue,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered
    FROM orders
    WHERE created_at >= ? AND created_at < ?
    GROUP BY day
    ORDER BY day DESC
  `),
};

// ---------- Order Items ----------
export const orderItemQueries = {
  create: db.prepare(
    `INSERT INTO order_items (order_id, product_id, category, name, qty, price, unit)
     VALUES (@order_id, @product_id, @category, @name, @qty, @price, @unit)`
  ),
  findByOrder: db.prepare(`SELECT * FROM order_items WHERE order_id = ?`),
  deleteByOrder: db.prepare(`DELETE FROM order_items WHERE order_id = ?`),
};

// ---------- Products ----------
export const productQueries = {
  findAll: db.prepare(`SELECT * FROM products ORDER BY sort_order ASC, id ASC`),
  findActive: db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, id ASC`),
  findById: db.prepare(`SELECT * FROM products WHERE id = ?`),
  findBySlug: db.prepare(`SELECT * FROM products WHERE slug = ?`),
  create: db.prepare(
    `INSERT INTO products (slug, name, category, category_label, price, original_price, unit, weight_grams, stock, rating, reviews_count, image, badge, origin, description, benefits, storage_tips, is_organic, active, sort_order)
     VALUES (@slug, @name, @category, @category_label, @price, @original_price, @unit, @weight_grams, @stock, @rating, @reviews_count, @image, @badge, @origin, @description, @benefits, @storage_tips, @is_organic, @active, @sort_order)`
  ),
  update: db.prepare(
    `UPDATE products SET slug=@slug, name=@name, category=@category, category_label=@category_label, price=@price, original_price=@original_price, unit=@unit, weight_grams=@weight_grams, stock=@stock, rating=@rating, reviews_count=@reviews_count, image=@image, badge=@badge, origin=@origin, description=@description, benefits=@benefits, storage_tips=@storage_tips, is_organic=@is_organic, active=@active, sort_order=@sort_order, updated_at=datetime('now') WHERE id=@id`
  ),
  delete: db.prepare(`DELETE FROM products WHERE id = ?`),
  count: db.prepare(`SELECT COUNT(*) AS count FROM products`),
};

// Seed products if table is empty
const productCount = productQueries.count.get().count;
if (productCount === 0) {
  console.log("[DB] Seeding 14 produk default...");
  const seedTx = db.transaction(() => {
    const seeds = [
      { slug:'kangkung-hidroponik', name:'Kangkung Hidroponik Sukabumi', category:'daun', category_label:'Sayuran Daun Hijau', price:4500, original_price:6000, unit:'ikat (250g)', weight_grams:250, stock:45, rating:4.9, reviews_count:128, image:'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=600&q=80', badge:'Panen Hari Ini', origin:'Kebun Hidroponik Cisaat, Sukabumi', description:'Kangkung segar tanpa pestisida kimia yang ditanam dengan air pegunungan Gunung Gede. Batang renyah, daun hijau pekat dan tidak pahit saat ditumis.', benefits:JSON.stringify(['Kaya Zat Besi & Mencegah Anemia','Tinggi Vitamin A untuk Kesehatan Mata','Membantu Kualitas Tidur']), storage_tips:'Simpan di kulkas dalam wadah tertutup yang dilapisi tisu kering, tahan hingga 5 hari.', is_organic:1, active:1, sort_order:1 },
      { slug:'bayam-hijau-petik', name:'Bayam Hijau Segar Pagi', category:'daun', category_label:'Sayuran Daun Hijau', price:4000, original_price:null, unit:'ikat (300g)', weight_grams:300, stock:38, rating:4.8, reviews_count:94, image:'https://images.unsplash.com/photo-1576045057995-568f588f82fb?auto=format&fit=crop&w=600&q=80', badge:'Panen Hari Ini', origin:'Kelompok Tani Sukaraja, Sukabumi', description:'Bayam muda dengan daun lembut dan manis alami. Sangat cocok untuk sayur bening keluarga, MPASI bayi, dan jus sayuran sehat.', benefits:JSON.stringify(['Sumber Asam Folat untuk Ibu Hamil','Mengandung Antioksidan Lutein','Memperkuat Sistem Imun']), storage_tips:'Potong sedikit ujung batang, jangan dicuci sebelum dimasukkan ke kulkas. Tahan 4 hari.', is_organic:0, active:1, sort_order:2 },
      { slug:'wortel-manis-selabintana', name:'Wortel Manis Selabintana', category:'umbi_buah', category_label:'Umbi & Sayur Buah', price:9500, original_price:12000, unit:'pack (500g)', weight_grams:500, stock:50, rating:4.9, reviews_count:210, image:'https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?auto=format&fit=crop&w=600&q=80', badge:'Best Seller', origin:'Dataran Tinggi Selabintana, Sukabumi', description:'Wortel manis bertekstur padat renyah yang tumbuh di tanah vulkanik sejuk lereng Gunung Gede. Kaya akan beta karoten alami tanpa pewarna/pengawet.', benefits:JSON.stringify(['Optimalisasi Penglihatan Mata','Tinggi Serat untuk Pencernaan','Mencerahkan Kulit']), storage_tips:'Simpan di laci bawah kulkas tanpa plastik rapat agar tidak berembun. Tahan 2 minggu.', is_organic:1, active:1, sort_order:3 },
      { slug:'brokoli-segar-gede', name:'Brokoli Segar Hijau Gunung Gede', category:'daun', category_label:'Sayuran Daun Hijau', price:14000, original_price:18000, unit:'bonggol (~400g)', weight_grams:400, stock:25, rating:5.0, reviews_count:156, image:'https://images.unsplash.com/photo-1459411621453-7b03977f4bfc?auto=format&fit=crop&w=600&q=80', badge:'Organik', origin:'Perkebunan Organik Kadudampit, Sukabumi', description:'Brokoli segar dengan kuntum rapat hijau tua, bebas dari ulat dan residu pestisida kimia. Manis alami dan gurih saat dikukus atau ditumis.', benefits:JSON.stringify(['Senyawa Sulforaphane Anti Kanker','Kaya Vitamin C Lebih Tinggi dari Jeruk','Menjaga Kesehatan Jantung']), storage_tips:'Bungkus dengan kertas koran/tisu lalu masukkan ke plastik berlubang di kulkas. Tahan 7 hari.', is_organic:1, active:1, sort_order:4 },
      { slug:'tomat-cherry-manis', name:'Tomat Cherry Merah Sukabumi', category:'umbi_buah', category_label:'Umbi & Sayur Buah', price:11000, original_price:null, unit:'kemasan (250g)', weight_grams:250, stock:30, rating:4.8, reviews_count:88, image:'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?auto=format&fit=crop&w=600&q=80', badge:'Diskon', origin:'Greenhouse Nagrak, Sukabumi', description:'Tomat cherry kecil berdaging tebal dengan rasa manis asam segar yang meledak di mulut. Enak dimakan langsung sebagai camilan sehat atau salad.', benefits:JSON.stringify(['Kaya Likopen Pelindung Sel','Menurunkan Tekanan Darah','Menjaga Kesehatan Kulit']), storage_tips:'Simpan di suhu ruang jika ingin segera dikonsumsi, atau kulkas untuk kesegaran tahan 10 hari.', is_organic:1, active:1, sort_order:5 },
      { slug:'paket-sayur-asem-komplit', name:'Paket Sayur Asem Komplit Khas Sunda', category:'paket_masak', category_label:'Paket Masak Hemat', price:13500, original_price:16000, unit:'1 paket (Siap Masak)', weight_grams:700, stock:40, rating:5.0, reviews_count:342, image:'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80', badge:'Best Seller', origin:'Dapur Sayur Sukabumi Express', description:'Isian lengkap: Jagung manis, labu siam, kacang panjang, melinjo & daun so, terong bulat, kacang tanah, asam jawa, dan bumbu racik khas Sukabumi.', benefits:JSON.stringify(['Praktis tanpa repot belanja terpisah','Porsi pas untuk 4-5 orang keluarga','Bumbu racik rempah asli']), storage_tips:'Simpan di chiller kulkas dan olah dalam waktu 1-3 hari setelah pengiriman.', is_organic:0, active:1, sort_order:6 },
      { slug:'paket-sayur-sop-segar', name:'Paket Sayur Sop Sehat Keluarga', category:'paket_masak', category_label:'Paket Masak Hemat', price:12500, original_price:null, unit:'1 paket (Siap Masak)', weight_grams:650, stock:35, rating:4.9, reviews_count:220, image:'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=600&q=80', badge:'Best Seller', origin:'Dapur Sayur Sukabumi Express', description:'Komposisi: Wortel manis, kentang Dieng, kubis segar, buncis, daun bawang, seledri, tomat merah, dan bonus kaldu jamur alami.', benefits:JSON.stringify(['Menghangatkan tubuh','Kaya vitamin komplit','Cocok dinikmati bersama anak-anak']), storage_tips:'Simpan di kulkas suhu 4°C, tahan hingga 4 hari.', is_organic:0, active:1, sort_order:7 },
      { slug:'cabe-rawit-merah-domba', name:'Cabe Rawit Merah Domba Pedas Gurih', category:'bumbu', category_label:'Bumbu & Rempah Dapur', price:12000, original_price:15000, unit:'pack (250g)', weight_grams:250, stock:60, rating:4.9, reviews_count:180, image:'https://images.unsplash.com/photo-1588252303782-cb80119abd6d?auto=format&fit=crop&w=600&q=80', badge:'Panen Hari Ini', origin:'Kebun Cabe Cibadak, Sukabumi', description:'Cabe rawit merah petik pohon dengan tingkat kepedasan maksimal dan aroma segar harum. Sangat renyah dan tidak mudah busuk.', benefits:JSON.stringify(['Meningkatkan Metabolisme Tubuh','Meredakan Nyeri Sendi (Kapsaisin)','Melegakan Pernapasan']), storage_tips:'Petik tangkainya, alasi wadah dengan tisu, simpan di kulkas tanpa dicuci. Tahan hingga 3 minggu.', is_organic:0, active:1, sort_order:8 },
      { slug:'bawang-merah-brebes-sukabumi', name:'Bawang Merah Pilihan Super', category:'bumbu', category_label:'Bumbu & Rempah Dapur', price:14500, original_price:null, unit:'pack (500g)', weight_grams:500, stock:55, rating:4.8, reviews_count:165, image:'https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?auto=format&fit=crop&w=600&q=80', badge:'Best Seller', origin:'Sentra Bawang Sukabumi', description:'Bawang merah berumbi besar, padat, beraroma tajam harum. Sangat sedap untuk bumbu tumis, sup, maupun bawang goreng renyah.', benefits:JSON.stringify(['Antibakteri & Antivirus Alami','Menjaga Kadar Gula Darah','Menjaga Kesehatan Pencernaan']), storage_tips:'Simpan di tempat terbuka kering dan berangin (jangan di kulkas). Tahan 1 bulan.', is_organic:0, active:1, sort_order:9 },
      { slug:'alpukat-mentega-sukabumi', name:'Alpukat Mentega Sukabumi Grade A', category:'buah', category_label:'Buah Segar Lokal', price:24000, original_price:28000, unit:'kg (3-4 buah)', weight_grams:1000, stock:22, rating:5.0, reviews_count:410, image:'https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?auto=format&fit=crop&w=600&q=80', badge:'Best Seller', origin:'Kebun Buah Cicurug, Sukabumi', description:'Daging buah tebal kuning mentega, lembut gurih tanpa serat, dan tidak pahit. Garansi 100% ganti baru jika buah berulat atau gagal matang.', benefits:JSON.stringify(['Lemak Sehat Tak Jenuh Tunggal','Menurunkan Kolesterol Jahat (LDL)','Membantu Diet Sehat & Kenyang Lebih Lama']), storage_tips:'Jika masih mentah simpan di suhu ruang. Setelah matang empuk bisa disimpan di kulkas hingga 5 hari.', is_organic:1, active:1, sort_order:10 },
      { slug:'buncis-prancis-muda', name:'Buncis Prancis Muda Baby Bean', category:'daun', category_label:'Sayuran Daun Hijau', price:8500, original_price:null, unit:'pack (300g)', weight_grams:300, stock:28, rating:4.8, reviews_count:75, image:'https://images.unsplash.com/photo-1550828520-4cb496926fc9?auto=format&fit=crop&w=600&q=80', badge:'Organik', origin:'Kelompok Tani Cikembar, Sukabumi', description:'Buncis muda tanpa serat kasar di sampingnya, sangat renyah dan berasa manis saat digoreng tepung atau ditumis bawang putih.', benefits:JSON.stringify(['Kaya Protein Nabati & Serat','Mendukung Kesehatan Tulang dengan Vitamin K','Rendah Kalori']), storage_tips:'Simpan dalam kantong plastik berventilasi di laci sayur kulkas. Tahan 7 hari.', is_organic:1, active:1, sort_order:11 },
      { slug:'jamur-tiram-putih', name:'Jamur Tiram Putih Segar', category:'umbi_buah', category_label:'Umbi & Sayur Buah', price:7500, original_price:9000, unit:'pack (250g)', weight_grams:250, stock:32, rating:4.9, reviews_count:112, image:'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=600&q=80', badge:'Panen Hari Ini', origin:'Kumbung Jamur Baros, Sukabumi', description:'Jamur tiram segar dengan tudung kenyal tebal beraroma alami. Pilihan terbaik untuk jamur krispi, tumis jamur tiram pedas, atau suwiran soto.', benefits:JSON.stringify(['Tinggi Beta-Glukan Penurun Kolesterol','Alternatif Daging Tinggi Protein','Bebas Kolesterol']), storage_tips:'Bungkus dengan kertas agar menyerap kelembapan, hindari plastik basah. Tahan 4 hari.', is_organic:1, active:1, sort_order:12 },
      { slug:'jahe-merah-empon', name:'Jahe Merah Segar Pilihan', category:'bumbu', category_label:'Bumbu & Rempah Dapur', price:15000, original_price:null, unit:'pack (300g)', weight_grams:300, stock:20, rating:5.0, reviews_count:68, image:'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?auto=format&fit=crop&w=600&q=80', badge:'Organik', origin:'Lahan Herbal Nyalindung, Sukabumi', description:'Jahe merah beraroma kuat dan hangat dengan kandungan gingerol tinggi. Sangat berkhasiat untuk wedang jahe, imunitas tubuh, dan bumbu gulai.', benefits:JSON.stringify(['Meredakan Masuk Angin & Batuk','Meningkatkan Daya Tahan Tubuh','Melancarkan Peredaran Darah']), storage_tips:'Simpan di tempat sejuk berangin atau potong lalu simpan beku. Tahan berbulan-bulan.', is_organic:1, active:1, sort_order:13 },
      { slug:'pisang-raja-bulu-sukabumi', name:'Pisang Raja Bulu Sukabumi Manis Legit', category:'buah', category_label:'Buah Segar Lokal', price:22000, original_price:26000, unit:'sisir (~1.5kg)', weight_grams:1500, stock:18, rating:4.9, reviews_count:140, image:'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?auto=format&fit=crop&w=600&q=80', badge:'Promo Spesial', origin:'Kebun Pisang Gegerbitung, Sukabumi', description:'Pisang raja khas Sukabumi dengan aroma harum semerbak, daging buah oranye lembut, dan rasa manis legit. Enak dimakan segar atau kolak.', benefits:JSON.stringify(['Sumber Energi Alami Cepat','Tinggi Kalium untuk Fungsi Jantung','Membantu Pencernaan Lambung']), storage_tips:'Gantung di suhu ruang agar tidak cepat lebam. Jangan masukkan ke kulkas saat masih ada hijau.', is_organic:0, active:1, sort_order:14 },
    ];
    for (const s of seeds) {
      productQueries.create.run(s);
    }
  });
  seedTx();
  console.log("[DB] 14 produk berhasil di-seed.");
}

// ---------- Vouchers ----------
export const voucherQueries = {
  findAll: db.prepare(`SELECT * FROM vouchers ORDER BY id ASC`),
  findActive: db.prepare(`SELECT * FROM vouchers WHERE active = 1 ORDER BY id ASC`),
  findById: db.prepare(`SELECT * FROM vouchers WHERE id = ?`),
  findByCode: db.prepare(`SELECT * FROM vouchers WHERE code = ?`),
  create: db.prepare(
    `INSERT INTO vouchers (code, discount_percent, min_spend, description, active, max_uses, expires_at)
     VALUES (@code, @discount_percent, @min_spend, @description, @active, @max_uses, @expires_at)`
  ),
  update: db.prepare(
    `UPDATE vouchers SET code=@code, discount_percent=@discount_percent, min_spend=@min_spend, description=@description, active=@active, max_uses=@max_uses, expires_at=@expires_at, updated_at=datetime('now') WHERE id=@id`
  ),
  delete: db.prepare(`DELETE FROM vouchers WHERE id = ?`),
  count: db.prepare(`SELECT COUNT(*) AS count FROM vouchers`),
  incrementUsed: db.prepare(`UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?`),
};

// Seed vouchers if table is empty
const voucherCount = voucherQueries.count.get().count;
if (voucherCount === 0) {
  console.log("[DB] Seeding 3 voucher default...");
  const voucherSeedTx = db.transaction(() => {
    const voucherSeeds = [
      { code: 'SEGARHEMAT', discount_percent: 15, min_spend: 50000, description: 'Diskon 15% untuk belanja minimal Rp 50.000', active: 1, max_uses: 0, expires_at: null },
      { code: 'SUKABUMIBERKAH', discount_percent: 20, min_spend: 100000, description: 'Diskon 20% untuk belanja minimal Rp 100.000', active: 1, max_uses: 0, expires_at: null },
      { code: 'PETANILOKAL', discount_percent: 10, min_spend: 30000, description: 'Diskon 10% apresiasi petani lokal Sukabumi', active: 1, max_uses: 0, expires_at: null },
    ];
    for (const v of voucherSeeds) {
      voucherQueries.create.run(v);
    }
  });
  voucherSeedTx();
  console.log("[DB] 3 voucher berhasil di-seed.");
}

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
