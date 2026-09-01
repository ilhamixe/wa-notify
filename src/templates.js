/**
 * Template pesan WhatsApp ke supplier. Teks murni — dipisah dari logika
 * pemetaan supaya gampang diubah tanpa menyentuh alur order.
 */
import { formatRupiah } from "./validate.js";

/**
 * Pesan ke satu supplier: hanya item yang dia pasok + jumlah + nomor order.
 * @param {{name: string}} supplier
 * @param {{orderId: string, deliverySlot?: string, note?: string}} order
 * @param {{name: string, qty: number, unit?: string, price: number}[]} items
 * @param {string} shopName
 */
export function supplierOrder(supplier, order, items, shopName) {
  const lines = items.map((it) => {
    const unit = it.unit ? ` ${it.unit}` : "";
    const harga = it.price ? ` — ${formatRupiah(it.price * it.qty)}` : "";
    return `• ${it.name} ${it.qty}x${unit}${harga}`;
  });
  const total = items.reduce((s, it) => s + it.price * it.qty, 0);

  return [
    `*ORDER MASUK* — ${shopName}`,
    `No. Order: *${order.orderId}*`,
    "",
    `Halo ${supplier.name}, mohon siapkan:`,
    ...lines,
    "",
    total ? `Nilai item Anda: *${formatRupiah(total)}*` : null,
    order.deliverySlot ? `Slot antar: ${order.deliverySlot}` : null,
    order.note ? `Catatan: ${order.note}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Pesan uji koneksi dari dashboard admin. */
export function testMessage(shopName) {
  return `Tes koneksi *${shopName}* — wa-notify siap mengirim notifikasi order.`;
}
