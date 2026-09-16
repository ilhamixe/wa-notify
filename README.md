# wa-notify

Microservice notifikasi WhatsApp untuk e-commerce sayur-v2. Mengirim notifikasi order ke supplier dan kurir otomatis via WhatsApp.

## Fitur

- **Notifikasi Otomatis** — Order masuk → pesan WhatsApp ke supplier (per item) + kurir (rute pengiriman)
- **Multi-Supplier** — Mapping produk ke supplier, fallback ke kategori
- **Multi-Kurir** — Broadcast order ke semua kurir dengan info jarak
- **Klaim via Chat** — Kurir kirim `#ORDER-ID Klaim` → otomatis assign
- **Status via Chat** — Update status order dari WhatsApp (`#ORDER-ID Dikonfirmasi`)
- **Payment-Based Dispatch** — COD langsung dispatch, Transfer/QRIS tunggu konfirmasi admin
- **Outbox System** — Pesan diantre, retry otomatis jika gagal
- **CRUD Lengkap** — Produk, Supplier, Voucher, Settings
- **Image Upload** — Upload gambar produk & QRIS QR code
- **Delivery Zone** — Polygon (admin gambar di peta) + circle fallback (center + radius)
- **Realtime** — Socket.IO untuk push status WA ke dashboard admin

## Tech Stack

- Node.js + Express
- SQLite (better-sqlite3)
- Baileys (WhatsApp Web API)
- Socket.IO
- Multer (file upload)

## Setup

### Install

```bash
git clone https://github.com/ilhamixe/wa-notify.git
cd wa-notify
npm install
```

### Konfigurasi

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Port
PORT=3201

# API Token (generate: openssl rand -hex 32)
API_TOKEN=your_token_here

# Origin frontend yang diizinkan (pisah koma)
ALLOWED_ORIGINS=http://localhost:3000

# Database & session
DB_PATH=./data.db
SESSION_DIR=./sessions

# Aktifkan WhatsApp (1=aktif, 0=mati)
WA_ENABLED=1

# Environment
NODE_ENV=development
```

### Jalankan

```bash
node src/index.js
```

Server jalan di `http://127.0.0.1:3201`

### Database

Database SQLite dibuat otomatis. Tabel yang dibuat:

- `products` — 14 produk default di-seed otomatis
- `suppliers` — Data supplier
- `supplier_mappings` — Mapping produk kategori ke supplier
- `orders` — Data order
- `order_items` — Item per order
- `outbox` — Antrean pesan WhatsApp
- `notify_log` — Log notifikasi
- `vouchers` — 3 voucher default di-seed otomatis
- `settings` — Pengaturan toko (JSON)

## API Reference

### Public

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/api/products` | List produk aktif (`active=1`) |
| `GET` | `/api/vouchers` | List voucher aktif |
| `GET` | `/api/health` | Health check |

### Admin (perlu `Authorization: Bearer <TOKEN>`)

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `POST` | `/api/notify` | Checkout → kirim notifikasi |
| `GET` | `/api/orders` | List semua order + stats |
| `PUT` | `/api/orders` | Update status order |
| `GET` | `/api/orders/revenue` | Statistik pendapatan |
| `GET` | `/api/products?admin=1` | List semua produk |
| `POST` | `/api/products` | Buat produk |
| `PUT` | `/api/products/:id` | Update produk |
| `DELETE` | `/api/products/:id` | Hapus produk |
| `GET` | `/api/vouchers?admin=1` | List semua voucher |
| `POST` | `/api/vouchers` | Buat voucher |
| `PUT` | `/api/vouchers/:id` | Update voucher |
| `DELETE` | `/api/vouchers/:id` | Hapus voucher |
| `GET` | `/api/suppliers` | List semua supplier |
| `POST` | `/api/suppliers` | Buat supplier |
| `PUT` | `/api/suppliers/:id` | Update supplier |
| `DELETE` | `/api/suppliers/:id` | Hapus supplier |
| `GET` | `/api/settings` | Baca semua settings |
| `PUT` | `/api/settings` | Update settings |
| `POST` | `/api/upload` | Upload gambar |
| `GET` | `/api/wa/status` | Status koneksi WA |

### Chat Commands (dari WhatsApp)

| Command | Deskripsi |
|---------|-----------|
| `#ORDER-ID Klaim` / `#ORDER-ID Ambil` | Kurir klaim order |
| `#ORDER-ID Dikonfirmasi` | Update status ke confirmed |
| `#ORDER-ID Disiapkan` | Update status ke preparing |
| `#ORDER-ID Dikirim` | Update status ke shipping |
| `#ORDER-ID Selesai` | Update status ke delivered |
| `#ORDER-ID Dibatalkan` | Update status ke cancelled |

## Alur Kerja

### Checkout

```
Customer POST /api/notify
    ↓
parseOrder() → validasi data
    ↓
dispatchOrder():
  1. Cari supplier per item (product mapping → category mapping)
  2. Buat pesan per supplier → masuk outbox
  3. Broadcast ke semua kurir (dengan info jarak)
    ↓
OutboxWorker kirim pesan via Baileys
    ↓
Customer dapat struk (items, total, metode bayar)
```

### Klaim Kurir

```
Order di-broadcast ke semua kurir
    ↓
Kurir kirim "#ORDER-ID Klaim"
    ↓
handleClaim():
  1. Cari order di DB
  2. Cek belum diklaim
  3. Assign courier_name & courier_phone
  4. Status otomatis → shipping
  5. Kirim rute Google Maps ke kurir yang klaim
  6. Kirim info "sudah diklaim" ke kurir lain
```

### Payment-Based Dispatch

```
COD:
  Order langsung dispatch ke supplier + kurir
  Status: shipping

Transfer / QRIS:
  Order ditahan (belum dispatch)
  Admin konfirmasi di dashboard
  Status: confirmed → dispatch otomatis
```

## Settings (via API atau Dashboard)

| Key | Default | Deskripsi |
|-----|---------|-----------|
| `shop_name` | Sayur Sukabumi | Nama toko di pesan WA |
| `courier_phone` | - | Nomor HP kurir (legacy, gunakan `couriers`) |
| `couriers` | `[]` | JSON array kurir `[{name, phone, lat, lng}]` |
| `delivery_center_lat` | -6.9175 | Latitude pusat area |
| `delivery_center_lng` | 106.9230 | Longitude pusat area |
| `delivery_max_km` | 10 | Radius maksimum (km) |
| `delivery_polygon` | `[]` | JSON array titik polygon |
| `payment_qris` | 1 | Aktifkan QRIS (0/1) |
| `payment_transfer` | 1 | Aktifkan Transfer (0/1) |
| `payment_cod` | 1 | Aktifkan COD (0/1) |
| `payment_qris_image` | - | URL gambar QRIS |

## License

MIT
