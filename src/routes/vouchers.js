/**
 * Vouchers CRUD routes — admin management + public listing.
 */
import { Router } from "express";
import { voucherQueries } from "../db.js";

function parseVoucher(body) {
  return {
    id: body.id != null ? Number(body.id) : undefined,
    code: String(body.code || "").trim().toUpperCase(),
    discount_percent: Math.min(100, Math.max(0, Number(body.discount_percent) || 0)),
    min_spend: Number(body.min_spend) || 0,
    description: String(body.description || "").trim(),
    active: body.active !== undefined ? (body.active ? 1 : 0) : 1,
    max_uses: Number(body.max_uses) || 0,
    expires_at: body.expires_at || null,
  };
}

export default function vouchersRouter() {
  const router = Router();

  // Public: list active vouchers
  router.get("/", (req, res) => {
    const admin = req.query.admin === "1";
    const vouchers = admin
      ? voucherQueries.findAll.all()
      : voucherQueries.findActive.all();
    res.json({ vouchers });
  });

  // Get single voucher
  router.get("/:id", (req, res) => {
    const voucher = voucherQueries.findById.get(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher tidak ditemukan." });
    res.json({ voucher });
  });

  // Admin: create voucher
  router.post("/", (req, res) => {
    try {
      const data = parseVoucher(req.body);
      if (!data.code) return res.status(400).json({ error: "Kode voucher wajib diisi." });
      if (!data.discount_percent) return res.status(400).json({ error: "Persentase diskon wajib diisi." });
      const result = voucherQueries.create.run(data);
      const voucher = voucherQueries.findById.get(result.lastInsertRowid);
      res.status(201).json({ ok: true, voucher });
    } catch (err) {
      if (err.message?.includes("UNIQUE")) {
        return res.status(400).json({ error: "Kode voucher sudah ada." });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: update voucher
  router.put("/:id", (req, res) => {
    try {
      const existing = voucherQueries.findById.get(req.params.id);
      if (!existing) return res.status(404).json({ error: "Voucher tidak ditemukan." });
      const data = parseVoucher({ ...existing, ...req.body, id: Number(req.params.id) });
      voucherQueries.update.run(data);
      const voucher = voucherQueries.findById.get(req.params.id);
      res.json({ ok: true, voucher });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: delete voucher
  router.delete("/:id", (req, res) => {
    const existing = voucherQueries.findById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Voucher tidak ditemukan." });
    voucherQueries.delete.run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
