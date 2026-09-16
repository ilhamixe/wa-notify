/**
 * IncomingChat — parse pesan masuk dari WhatsApp & update status order.
 *
 * Pola yang dikenali (case-insensitive):
 *   #SS-249536 Klaim / Ambil     → kurir klaim order
 *   #SS-249536 Dikonfirmasi      → status update
 *   #SS-249536 Disiapkan         → status update
 *   #SS-249536 Dikirim           → status update
 *   #SS-249536 Selesai           → status update
 *   #SS-249536 Dibatalkan        → status update
 */
import * as tpl from "./templates.js";
import { orderQueries, orderItemQueries, notifyLogQueries, settings, outboxQueries } from "./db.js";
import { dispatchOrder } from "./dispatch.js";

const STATUS_MAP = {
  pending: "pending",
  dikonfirmasi: "confirmed",
  disiapkan: "preparing",
  dikirim: "shipping",
  selesai: "delivered",
  dibatalkan: "cancelled",
};

// Regex: #ORDER-ID Klaim/Ambil atau status update
const CLAIM_REGEX = /^#?([A-Z]{2,}[-_]\d+)\s+(klaim|ambil)\s*$/i;
const STATUS_REGEX = /^#?([A-Z]{2,}[-_]\d+)\s+(pending|dikonfirmasi|disiapkan|dikirim|selesai|dibatalkan)\s*$/i;

/**
 * Handle incoming message. Dipanggil dari WaSession.messages.upsert.
 */
export async function handleIncomingMessage(msg, courierPhone, sendReply, emit) {
  if (!msg?.message || msg.key?.fromMe) return;

  const senderJid = msg.key.remoteJid;
  const pushName = msg.pushName || "";

  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";

  if (!text.trim()) return;

  console.log(`[CHAT] dari ${senderJid} (pushName=${pushName}): "${text}"`);

  // Cek klaim/ambil
  const claimMatch = text.trim().match(CLAIM_REGEX);
  if (claimMatch) {
    await handleClaim(claimMatch[1], senderJid, pushName, sendReply, emit);
    return;
  }

  // Cek status update
  const statusMatch = text.trim().match(STATUS_REGEX);
  if (statusMatch) {
    await handleStatusUpdate(statusMatch[1], statusMatch[2].toLowerCase(), senderJid, sendReply, emit);
    return;
  }

  console.log(`[CHAT] tidak cocok pola order — diabaikan.`);
}

/** Cari nama kurir dari phone number atau pushName. */
function getCourierName(senderJid, pushName) {
  let couriers = [];
  try { couriers = JSON.parse(settings.get("couriers") || "[]"); } catch {}
  const jid = (senderJid || "").replace("@s.whatsapp.net", "").replace("@lid", "");
  const normalizedJid = jid.replace(/\D/g, "");
  const normalizedPush = (pushName || "").trim().toLowerCase();

  for (const c of couriers) {
    const cPhone = (c.phone || "").replace(/\D/g, "");
    // Match by phone (handles LID vs phone via suffix match)
    if (normalizedJid && cPhone && (
      cPhone === normalizedJid ||
      normalizedJid.endsWith(cPhone.slice(-10)) ||
      cPhone.endsWith(normalizedJid.slice(-10))
    )) {
      return c.name;
    }
    // Match by pushName (WhatsApp display name)
    if (normalizedPush && c.name && c.name.trim().toLowerCase() === normalizedPush) {
      return c.name;
    }
  }
  return null;
}

/** Handle kurir klaim order. */
async function handleClaim(orderId, senderJid, pushName, sendReply, emit) {
  const senderPhone = (senderJid || "").replace("@s.whatsapp.net", "").replace("@lid", "");
  const courierName = getCourierName(senderJid, pushName);

  // Resolve actual phone from courier list (LID format doesn't have the real phone)
  let courierPhone = senderPhone;
  if (courierName) {
    let couriers = [];
    try { couriers = JSON.parse(settings.get("couriers") || "[]"); } catch {}
    const found = couriers.find((c) => c.name === courierName);
    if (found?.phone) courierPhone = found.phone;
  }

  const order = orderQueries.findById.get(orderId);
  if (!order) {
    try { await sendReply(senderJid, `Order *#${orderId}* tidak ditemukan.`); } catch {}
    return;
  }

  // Sudah diklaim?
  if (order.courier_name) {
    try { await sendReply(senderJid, `Order *#${orderId}* sudah diklaim oleh *${order.courier_name}*.`); } catch {}
    return;
  }

  // Assign courier
  orderQueries.assignCourier.run({
    order_id: orderId,
    courier_name: courierName || senderPhone,
    courier_phone: courierPhone,
  });
  console.log(`[CHAT] ✓ ${orderId} diklaim oleh ${courierName || senderPhone} (phone=${courierPhone})`);

  // Update status ke shipping
  orderQueries.updateStatus.run({ order_id: orderId, status: "shipping" });

  // Kirim rute ke kurir yang klaim
  const items = orderItemQueries.findByOrder.all(orderId);
  const shopName = settings.get("shop_name") || "Sayur Sukabumi";
  const routeMsg = tpl.courierClaimConfirm(
    { ...order, orderId: order.order_id },
    items.map((it) => ({ name: it.name, qty: it.qty, unit: it.unit, price: it.price })),
    shopName
  );
  try { await sendReply(senderJid, routeMsg); } catch {}

  // Info ke kurir lain (broadcast ke semua kurir kecuali yang klaim)
  let couriers = [];
  try { couriers = JSON.parse(settings.get("couriers") || "[]"); } catch {}
  const infoMsg = tpl.courierClaimedInfo(orderId, courierName || senderPhone);
  for (const c of couriers) {
    if (!c.phone) continue;
    const cPhone = c.phone.replace(/\D/g, "");
    if (cPhone === courierPhone.replace(/\D/g, "")) continue;
    try { await sendReply(`${c.phone}@s.whatsapp.net`, infoMsg); } catch {}
  }

  emit("order-updated", { orderId, status: "shipping", courierName: courierName || senderPhone });
}

/** Handle status update via chat. */
async function handleStatusUpdate(orderId, statusInput, senderJid, sendReply, emit) {
  const newStatus = STATUS_MAP[statusInput];
  if (!newStatus) return;

  const order = orderQueries.findById.get(orderId);
  if (!order) {
    try { await sendReply(senderJid, `Order *#${orderId}* tidak ditemukan.`); } catch {}
    return;
  }

  orderQueries.updateStatus.run({ order_id: orderId, status: newStatus });
  console.log(`[CHAT] ✓ order ${orderId}: ${order.status} → ${newStatus}`);

  // Kalau confirmed & belum dispatch (transfer/QRIS), dispatch sekarang
  if (newStatus === "confirmed") {
    const alreadyDispatched = notifyLogQueries.findByOrder.get(orderId);
    if (!alreadyDispatched) {
      const items = orderItemQueries.findByOrder.all(orderId);
      const orderObj = {
        orderId: order.order_id,
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        address: order.address,
        note: order.note,
        deliverySlot: order.delivery_slot,
        paymentMethod: order.payment_method,
        lat: order.lat,
        lng: order.lng,
        items: items.map((it) => ({
          productId: it.product_id,
          category: it.category,
          name: it.name,
          qty: it.qty,
          price: it.price,
          unit: it.unit,
        })),
      };
      const result = dispatchOrder(orderObj);
      console.log(`[CHAT] ${orderId}: confirmed → dispatch ${result.queued} pesan.`);
    }
  }

  const STATUS_LABELS = {
    pending: "Pending",
    confirmed: "Dikonfirmasi",
    preparing: "Disiapkan",
    shipping: "Dikirim",
    delivered: "Selesai",
    cancelled: "Dibatalkan",
  };
  const reply = `Order *#${orderId}* berhasil diubah ke *${STATUS_LABELS[newStatus]}* ✓`;
  try { await sendReply(senderJid, reply); } catch {}

  emit("order-updated", { orderId, status: newStatus });
}

export default handleIncomingMessage;
