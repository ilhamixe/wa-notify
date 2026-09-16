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

/**
 * Pesan rute pengiriman ke kurir.
 * Berisi link Google Maps + rincian order lengkap.
 */
export function courierRoute(order, items, shopName) {
  const total = items.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
  const routeUrl = (order.lat && order.lng)
    ? `https://www.google.com/maps/dir/?api=1&destination=${order.lat},${order.lng}&travelmode=driving`
    : null;

  const itemLines = items.map((it) => {
    const unit = it.unit ? ` ${it.unit}` : "";
    return `• ${it.name} ${it.qty}x${unit}`;
  });

  return [
    `*RUTE PENGIRIMAN* — ${shopName}`,
    `No. Order: *${order.orderId}*`,
    "",
    routeUrl ? `🗺️ *Lokasi Pelanggan:* ${routeUrl}` : "📍 Pelanggan tidak menandai peta",
    "",
    `👤 *Pelanggan:* ${order.customerName || "-"}`,
    `📱 *WA:* ${order.customerPhone || "-"}`,
    `📍 *Alamat:* ${order.address || "-"}`,
    `🏙️ *Kota:* ${order.city || "-"}`,
    `⏰ *Slot Antar:* ${order.deliverySlot || "-"}`,
    order.note ? `📝 *Catatan:* ${order.note}` : null,
    "",
    `*DAFTAR ITEM:*`,
    ...itemLines,
    "",
    `*Total: ${formatRupiah(total)}*`,
    `💳 Pembayaran: ${(order.paymentMethod || "").toUpperCase()}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Pesan uji koneksi dari dashboard admin. */
export function testMessage(shopName) {
  return `Tes koneksi *${shopName}* — wa-notify siap mengirim notifikasi order.`;
}

/**
 * Broadcast order baru ke kurir — berisi jarak dari base kurir ke pelanggan.
 * @param {{orderId, customerName, address, deliverySlot, paymentMethod, lat, lng}} order
 * @param {{name: string, qty: number, unit?: string, price: number}[]} items
 * @param {string} shopName
 * @param {number|null} distanceKm - jarak dari base kurir ke pelanggan (km)
 */
export function courierBroadcast(order, items, shopName, distanceKm) {
  const total = items.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
  const itemLines = items.map((it) => {
    const unit = it.unit ? ` ${it.unit}` : "";
    return `• ${it.name} ${it.qty}x${unit}`;
  });
  const distLine = distanceKm != null ? `🗺️ *Jarak dari kamu:* ${distanceKm.toFixed(1)} km` : "";

  return [
    `📦 *ORDER BARU* — ${shopName}`,
    `No. Order: *${order.orderId}*`,
    "",
    `👤 *Pelanggan:* ${order.customerName || "-"}`,
    `📍 *Alamat:* ${order.address || "-"}`,
    `⏰ *Slot:* ${order.deliverySlot || "-"}`,
    "",
    `*DAFTAR ITEM:*`,
    ...itemLines,
    "",
    `💰 *Total: ${formatRupiah(total)}*`,
    `💳 ${(order.paymentMethod || "").toUpperCase()}`,
    distLine,
    "",
    `Ketik *#${order.orderId} Klaim* untuk ambil order ini`,
  ]
    .filter((l) => l !== null && l !== "")
    .join("\n");
}

/**
 * Konfirmasi klaim berhasil — dikirim ke kurir yang klaim.
 */
export function courierClaimConfirm(order, items, shopName) {
  // Re-use courierRoute for full route details
  return courierRoute(order, items, shopName);
}

/**
 * Info ke kurir lain bahwa order sudah diklaim.
 */
export function courierClaimedInfo(orderId, courierName) {
  return `ℹ️ Order *#${orderId}* sudah diklaim oleh *${courierName}*`;
}
