/**
 * Endpoint order: terima order dari checkout sayur-v2, kelompokkan per
 * supplier, antre ke outbox. Simpan ke tabel orders untuk dashboard admin.
 */
import { Router } from "express";
import { parseOrder } from "../validate.js";
import { dispatchOrder } from "../dispatch.js";
import { notifyLogQueries, outboxQueries, orderQueries, orderItemQueries } from "../db.js";

export default function notifyRouter() {
  const router = Router();

  router.post("/", (req, res, next) => {
    try {
      const order = parseOrder(req.body);

      // Simpan order ke tabel orders (untuk dashboard admin)
      try {
        const total = order.items.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
        orderQueries.create.run({
          order_id: order.orderId,
          customer_name: order.customerName || "",
          customer_phone: order.customerPhone || "",
          address: order.address || "",
          note: order.note || "",
          delivery_slot: order.deliverySlot || "",
          payment_method: order.paymentMethod || "",
          lat: order.lat || null,
          lng: order.lng || null,
          total,
          status: "pending",
        });

        // Simpan item detail per order
        for (const item of order.items) {
          orderItemQueries.create.run({
            order_id: order.orderId,
            product_id: item.productId || "",
            category: item.category || "",
            name: item.name || "",
            qty: item.qty || 1,
            price: item.price || 0,
            unit: item.unit || "",
          });
        }
      } catch (e) {
        // Order mungkin sudah ada (duplicate), abaikan
        if (!e.message?.includes("UNIQUE")) {
          console.warn("[NOTIFY] gagal simpan order:", e.message);
        }
      }

      // COD → langsung dispatch. Transfer/QRIS → tahan, dispatch saat admin konfirmasi.
      const isCod = (order.paymentMethod || "").toLowerCase() === "cod";
      if (!isCod) {
        console.log(`[NOTIFY] ${order.orderId}: ${order.paymentMethod} — tahan dispatch, tunggu konfirmasi admin.`);
        return res.status(202).json({
          duplicate: false,
          orderId: order.orderId,
          queued: 0,
          suppliers: [],
          unmapped: [],
          held: true,
        });
      }

      const result = dispatchOrder(order);
      if (result.unmapped.length) {
        console.warn(
          `[NOTIFY] ${order.orderId}: ${result.unmapped.length} item tanpa supplier — ${result.unmapped.join(", ")}`
        );
      }
      console.log(`[NOTIFY] ${order.orderId}: ${result.queued} pesan diantre.`);
      res.status(result.duplicate ? 200 : 202).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Orders list + stats (with items)
  router.get("/orders", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { from, to } = req.query;

    let rows, stats;
    if (from || to) {
      const fromDate = from || '2000-01-01';
      const toDate = to ? new Date(new Date(to).getTime() + 86400000).toISOString().slice(0, 10) : '2100-01-01';
      rows = orderQueries.findByDateRange.all(fromDate, toDate);
      stats = orderQueries.statsByDateRange.get(fromDate, toDate);
    } else {
      rows = orderQueries.findAll.all(limit);
      stats = orderQueries.stats.get();
    }

    const orders = rows.map((o) => ({
      ...o,
      items: orderItemQueries.findByOrder.all(o.order_id),
    }));
    res.json({ orders, stats });
  });

  // Revenue summary by month
  router.get("/orders/revenue", (req, res) => {
    const monthly = orderQueries.revenueByMonth.all();
    const { from, to } = req.query;
    let daily = [];
    if (from || to) {
      const fromDate = from || '2000-01-01';
      const toDate = to ? new Date(new Date(to).getTime() + 86400000).toISOString().slice(0, 10) : '2100-01-01';
      daily = orderQueries.revenueByDay.all(fromDate, toDate);
    }
    res.json({ monthly, daily });
  });

  // Update order status
  router.put("/orders/:orderId/status", (req, res) => {
    try {
      const { orderId } = req.params;
      const { status } = req.body;
      const valid = ["pending", "confirmed", "preparing", "shipping", "delivered", "cancelled"];
      if (!valid.includes(status)) {
        return res.status(400).json({ error: `Status harus salah satu: ${valid.join(", ")}` });
      }
      const order = orderQueries.findById.get(orderId);
      if (!order) return res.status(404).json({ error: "Order tidak ditemukan." });
      orderQueries.updateStatus.run({ order_id: orderId, status });

      // Kalau status = confirmed & order belum dispatch (transfer/QRIS), dispatch sekarang
      if (status === "confirmed") {
        const alreadyDispatched = notifyLogQueries.findByOrder.get(orderId);
        if (!alreadyDispatched) {
          // Reconstruct order object untuk dispatch
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
          console.log(`[NOTIFY] ${orderId}: confirmed → dispatch ${result.queued} pesan.`);
        }
      }

      res.json({ ok: true, order: orderQueries.findById.get(orderId) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Legacy logs (outbox + notify_log)
  router.get("/logs", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({
      orders: notifyLogQueries.recent.all(limit),
      outbox: outboxQueries.recent.all(limit),
      stats: outboxQueries.stats.get(),
    });
  });

  router.get("/logs/:orderId", (req, res) => {
    res.json({
      order: notifyLogQueries.findByOrder.get(req.params.orderId) || null,
      outbox: outboxQueries.byOrder.all(req.params.orderId),
    });
  });

  return router;
}
