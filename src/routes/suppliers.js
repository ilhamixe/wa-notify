/**
 * CRUD supplier — pemetaan produk / kategori → nomor WA tukang sayur.
 * Sekarang 1 supplier bisa punya banyak mapping.
 */
import { Router } from "express";
import db, { supplierQueries, mappingQueries, replaceMappings } from "../db.js";
import { parseSupplier, maskPhone, ValidationError } from "../validate.js";

/** Parse mappings_raw dari GROUP_CONCAT → array of {mapping_type, ref_id}. */
function parseMappings(raw) {
  if (!raw) return [];
  return raw.split("|").map((s) => {
    const [mapping_type, ...rest] = s.split(":");
    return { mapping_type, ref_id: rest.join(":") };
  });
}

/** Attach mappings array ke setiap supplier. */
function withMappings(rows) {
  return rows.map((s) => ({
    ...s,
    mappings: parseMappings(s.mappings_raw),
    mappings_raw: undefined,
  }));
}

export default function suppliersRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    const rows = supplierQueries.allWithMappings.all();
    res.json({ suppliers: withMappings(rows) });
  });

  router.post("/", (req, res, next) => {
    try {
      const data = parseSupplier(req.body);
      const info = supplierQueries.create.run(data);
      const supplierId = info.lastInsertRowid;
      replaceMappings(supplierId, data.mappings);
      console.log(
        `[SUPPLIER] tambah "${data.name}" ${maskPhone(data.phone)} → ${data.mappings.length} mapping(s)`
      );
      res.status(201).json({
        supplier: {
          ...supplierQueries.findById.get(supplierId),
          mappings: mappingQueries.findBySupplier.all(supplierId),
        },
      });
    } catch (err) {
      if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" && err.message.includes("suppliers")) {
        return next(new ValidationError("Nomor WhatsApp itu sudah didaftarkan."));
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
      replaceMappings(id, data.mappings);
      console.log(
        `[SUPPLIER] update "${data.name}" ${maskPhone(data.phone)} → ${data.mappings.length} mapping(s)`
      );
      res.json({
        supplier: {
          ...supplierQueries.findById.get(id),
          mappings: mappingQueries.findBySupplier.all(id),
        },
      });
    } catch (err) {
      if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" && err.message.includes("suppliers")) {
        return next(new ValidationError("Nomor WhatsApp itu sudah didaftarkan."));
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
