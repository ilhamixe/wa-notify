/**
 * Kontrol koneksi WhatsApp dari dashboard admin: connect, QR, pairing code,
 * disconnect, reset, daftar grup, kirim pesan uji.
 */
import { Router } from "express";
import { normalizePhone, ValidationError } from "../validate.js";
import { settings } from "../db.js";
import * as tpl from "../templates.js";

/** @param {import('../WaSession.js').WaSession} wa */
export default function waRouter(wa) {
  const router = Router();

  // /status route is now handled in index.js (outside rate limiter)

  router.post("/connect", async (req, res, next) => {
    try {
      res.json(await wa.start());
    } catch (err) {
      next(err);
    }
  });

  router.post("/disconnect", async (req, res, next) => {
    try {
      res.json(await wa.stop());
    } catch (err) {
      next(err);
    }
  });

  router.post("/reset", async (req, res, next) => {
    try {
      res.json(await wa.reset());
    } catch (err) {
      next(err);
    }
  });

  router.post("/pairing-code", async (req, res, next) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) throw new ValidationError("Nomor untuk pairing tidak valid.");
      const code = await wa.requestPairing(phone);
      res.json({ code });
    } catch (err) {
      next(err);
    }
  });

  router.get("/groups", async (req, res, next) => {
    try {
      res.json({ groups: await wa.fetchGroups() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/test", async (req, res, next) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) throw new ValidationError("Nomor tujuan tes tidak valid.");
      const shopName = settings.get("shop_name") || "Sayur Sukabumi";
      await wa.sendText(`${phone}@s.whatsapp.net`, tpl.testMessage(shopName));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
