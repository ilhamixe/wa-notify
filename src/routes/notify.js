/**
 * Endpoint order: terima order dari checkout sayur-v2, kelompokkan per
 * supplier, antre ke outbox. Balasan tidak menunggu pengiriman WA —
 * worker outbox yang mengirim, jadi order tetap sukses walau WA sedang mati.
 */
import { Router } from "express";
import { parseOrder } from "../validate.js";
import { dispatchOrder } from "../dispatch.js";
import { notifyLogQueries, outboxQueries } from "../db.js";

export default function notifyRouter() {
  const router = Router();

  router.post("/", (req, res, next) => {
    try {
      const order = parseOrder(req.body);
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
