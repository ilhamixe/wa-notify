/**
 * Endpoint order: terima order dari checkout sayur-v2, kelompokkan per
 * supplier, antre ke outbox. Simpan ke tabel orders untuk dashboard admin.
 */
import { Router } from "express";
import { parseOrder } from "../validate.js";
import { dispatchOrder } from "../dispatch.js";
import { notifyLogQueries, outboxQueries, orderQueries } from "../db.js";

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
          total,
          status: "pending",
        });
      } catch (e) {
        // Order mungkin sudah ada (duplicate), abaikan
        if (!e.message?.includes("UNIQUE")) {
          console.warn("[NOTIFY] gagal simpan order:", e.message);
        }
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

  // Orders list + stats
  router.get("/orders", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({
      orders: orderQueries.findAll.all(limit),
      stats: orderQueries.stats.get(),
    });
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
