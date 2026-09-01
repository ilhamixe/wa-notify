/**
 * CRUD supplier — pemetaan produk / kategori → nomor WA tukang sayur.
 */
import { Router } from "express";
import { supplierQueries } from "../db.js";
import { parseSupplier, maskPhone, ValidationError } from "../validate.js";

export default function suppliersRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    res.json({ suppliers: supplierQueries.all.all() });
  });

  router.post("/", (req, res, next) => {
    try {
      const data = parseSupplier(req.body);
      const info = supplierQueries.create.run(data);
      console.log(
        `[SUPPLIER] tambah "${data.name}" ${maskPhone(data.phone)} → ${data.mapping_type}:${data.ref_id}`
      );
      res.status(201).json({ supplier: supplierQueries.findById.get(info.lastInsertRowid) });
    } catch (err) {
      if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return next(new ValidationError("Nomor itu sudah dipetakan ke target yang sama."));
      }
      next(err);
    }
  });

  router.put("/:id", (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!supplierQueries.findById.get(id)) {
        throw new ValidationError("Supplier tidak ditemukan.");
      }
      const data = parseSupplier(req.body);
      supplierQueries.update.run({ ...data, id });
      res.json({ supplier: supplierQueries.findById.get(id) });
    } catch (err) {
      if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return next(new ValidationError("Nomor itu sudah dipetakan ke target yang sama."));
      }
      next(err);
    }
  });

  router.delete("/:id", (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const found = supplierQueries.findById.get(id);
      if (!found) throw new ValidationError("Supplier tidak ditemukan.");
      supplierQueries.delete.run(id);
      console.log(`[SUPPLIER] hapus "${found.name}" (#${id})`);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
