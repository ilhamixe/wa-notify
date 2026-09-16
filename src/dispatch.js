/**
 * Pemetaan item order → supplier, lalu antre pesan ke outbox.
 *
 * Aturan pencarian supplier per item (berhenti di yang pertama ketemu):
 *   1. mapping 'product'  dengan ref_id = item.productId  (paling spesifik)
 *   2. mapping 'category' dengan ref_id = item.category   (fallback)
 * Item yang tidak ketemu keduanya dilaporkan sebagai `unmapped` — tidak
 * membatalkan order, cuma jadi peringatan di dashboard admin.
 *
 * Satu supplier bisa memasok beberapa item dalam satu order → dikelompokkan
 * jadi SATU pesan. Satu produk bisa punya lebih dari satu supplier aktif →
 * semuanya dikirimi.
 */
import db, { supplierQueries, mappingQueries, outboxQueries, notifyLogQueries, settings } from "./db.js";
import * as tpl from "./templates.js";

/** Haversine distance in km between two lat/lng points. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Kelompokkan item per supplier.
 * @param {{productId: string, category: string, name: string, qty: number, price: number, unit?: string}[]} items
 * @returns {{groups: Map<number, {supplier: object, items: object[]}>, unmapped: object[]}}
 */
export function groupBySupplier(items) {
  const groups = new Map();
  const unmapped = [];

  for (const item of items) {
    let matches = item.productId ? mappingQueries.activeByMap.all("product", item.productId) : [];
    if (!matches.length && item.category) {
      matches = mappingQueries.activeByMap.all("category", item.category);
    }

    if (!matches.length) {
      unmapped.push(item);
      continue;
    }

    for (const row of matches) {
      // Build a consistent supplier-like object from the joined row
      const supplier = {
        id: row.supplier_id,
        name: row.supplier_name,
        phone: row.supplier_phone,
      };
      const entry = groups.get(supplier.id) || { supplier, items: [] };
      entry.items.push(item);
      groups.set(supplier.id, entry);
    }
  }

  return { groups, unmapped };
}

/**
 * Proses satu order: kelompokkan, antre ke outbox, catat log.
 * Idempoten pada orderId — order yang sama tidak diantre dua kali.
 * @param {{orderId, customerName, customerPhone, note, deliverySlot, items}} order
 */
export function dispatchOrder(order) {
  const existing = notifyLogQueries.findByOrder.get(order.orderId);
  if (existing) {
    return {
      duplicate: true,
      orderId: order.orderId,
      queued: outboxQueries.byOrder.all(order.orderId).length,
      suppliers: [],
      unmapped: JSON.parse(existing.unmapped || "[]"),
    };
  }

  const shopName = settings.get("shop_name") || "Sayur Sukabumi";
  const { groups, unmapped } = groupBySupplier(order.items);

  const tx = db.transaction(() => {
    const queued = [];
    for (const { supplier, items } of groups.values()) {
      outboxQueries.create.run({
        order_id: order.orderId,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        to_jid: `${supplier.phone}@s.whatsapp.net`,
        body: tpl.supplierOrder(supplier, order, items, shopName),
      });
      queued.push({
        supplierId: supplier.id,
        name: supplier.name,
        items: items.map((it) => `${it.name} x${it.qty}`),
      });
    }

    // Broadcast ke semua kurir (sistem klaim)
    let couriers = [];
    try { couriers = JSON.parse(settings.get("couriers") || "[]"); } catch {}
    const orderLat = order.lat;
    const orderLng = order.lng;

    for (const courier of couriers) {
      if (!courier.phone) continue;

      // Hitung jarak dari base kurir ke pelanggan
      let distanceKm = null;
      if (courier.lat != null && courier.lng != null && orderLat != null && orderLng != null) {
        distanceKm = haversine(courier.lat, courier.lng, orderLat, orderLng);
      }

      outboxQueries.create.run({
        order_id: order.orderId,
        supplier_id: null,
        supplier_name: `Kurir (${courier.name})`,
        to_jid: `${courier.phone}@s.whatsapp.net`,
        body: tpl.courierBroadcast(order, order.items, shopName, distanceKm),
      });
      queued.push({ supplierId: null, name: `Kurir (${courier.name})`, items: ["Order baru - menunggu klaim"] });
    }

    notifyLogQueries.create.run({
      order_id: order.orderId,
      customer_name: order.customerName || "",
      items_count: order.items.length,
      supplier_hits: queued.length,
      unmapped: JSON.stringify(unmapped.map((it) => it.name)),
    });

    return queued;
  });

  const suppliers = tx();
  return {
    duplicate: false,
    orderId: order.orderId,
    queued: suppliers.length,
    suppliers,
    unmapped: unmapped.map((it) => it.name),
  };
}
