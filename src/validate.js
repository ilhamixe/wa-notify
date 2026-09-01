/**
 * Validasi & normalisasi input — batas kepercayaan.
 * Semua data dari browser lewat sini sebelum menyentuh DB / WhatsApp.
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

/** "08123456789" | "+628123456789" | "62 812-3456-789" → "628123456789" */
export function normalizePhone(raw) {
  let n = String(raw ?? "").replace(/\D/g, "");
  if (!n) return "";
  if (n.startsWith("620")) n = "62" + n.slice(3);
  else if (n.startsWith("0")) n = "62" + n.slice(1);
  else if (n.startsWith("8")) n = "62" + n;
  if (!/^62[0-9]{8,13}$/.test(n)) return "";
  return n;
}

/** Samarkan nomor untuk log: "628982022069" → "628****2069" */
export function maskPhone(phone) {
  const p = String(phone ?? "");
  if (p.length < 8) return "***";
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

export function formatRupiah(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

function str(value, field, { max, required = true, min = 1 }) {
  const s = String(value ?? "").trim();
  if (!s) {
    if (required) throw new ValidationError(`${field} wajib diisi.`);
    return "";
  }
  if (s.length < min) throw new ValidationError(`${field} minimal ${min} karakter.`);
  if (s.length > max) throw new ValidationError(`${field} maksimal ${max} karakter.`);
  return s;
}

function int(value, field, { min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError(`${field} harus angka bulat.`);
  if (n < min || n > max) throw new ValidationError(`${field} harus antara ${min} dan ${max}.`);
  return n;
}

/** Id produk/kategori: huruf kecil, angka, tanda hubung / garis bawah. */
export function normalizeRefId(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return s.slice(0, 60);
}

/** Validasi payload supplier dari dashboard admin. */
export function parseSupplier(body) {
  const name = str(body?.name, "Nama supplier", { max: 60, min: 2 });
  const phone = normalizePhone(body?.phone);
  if (!phone) throw new ValidationError("Nomor WhatsApp supplier tidak valid. Contoh: 081234567890");

  const mapping_type = String(body?.mapping_type ?? "").trim();
  if (mapping_type !== "product" && mapping_type !== "category") {
    throw new ValidationError('mapping_type harus "product" atau "category".');
  }

  const ref_id = normalizeRefId(body?.ref_id);
  if (!ref_id) throw new ValidationError("Produk / kategori target wajib dipilih.");

  return { name, phone, mapping_type, ref_id, active: body?.active === false ? 0 : 1 };
}

/**
 * Validasi payload order dari checkout sayur-v2.
 * Harga dipakai apa adanya untuk isi pesan (kalkulasi total tetap di sisi toko),
 * tapi tetap dibatasi rentangnya supaya tidak ada nilai aneh masuk pesan WA.
 */
export function parseOrder(body) {
  if (!body || typeof body !== "object") throw new ValidationError("Data order tidak valid.");

  const orderId = str(body.orderId, "orderId", { max: 40, min: 3 });
  const customerName = str(body.customerName, "Nama pelanggan", { max: 60, required: false });
  const customerPhoneRaw = String(body.customerPhone ?? "").trim();
  const customerPhone = customerPhoneRaw ? normalizePhone(customerPhoneRaw) : "";
  const note = str(body.note, "Catatan", { max: 500, required: false });
  const deliverySlot = str(body.deliverySlot, "Slot antar", { max: 40, required: false });

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ValidationError("Item order kosong.");
  }
  if (body.items.length > 50) throw new ValidationError("Maksimal 50 jenis item per order.");

  const items = body.items.map((raw, i) => ({
    productId: normalizeRefId(raw?.productId),
    category: normalizeRefId(raw?.category),
    name: str(raw?.name, `Nama item #${i + 1}`, { max: 100 }),
    qty: int(raw?.qty, `Jumlah item #${i + 1}`, { min: 1, max: 999 }),
    price: int(raw?.price ?? 0, `Harga item #${i + 1}`, { min: 0, max: 100_000_000 }),
    unit: str(raw?.unit, `Satuan item #${i + 1}`, { max: 40, required: false }),
  }));

  for (const it of items) {
    if (!it.productId && !it.category) {
      throw new ValidationError(`Item "${it.name}" tidak punya productId maupun category.`);
    }
  }

  return { orderId, customerName, customerPhone, note, deliverySlot, items };
}

export const validate = { str, int };
