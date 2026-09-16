/**
 * Products CRUD routes — admin management + public listing.
 */
import { Router } from "express";
import { productQueries } from "../db.js";

function parseProduct(body) {
  return {
    id: body.id != null ? Number(body.id) : undefined,
    slug: String(body.slug || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    name: String(body.name || "").trim(),
    category: String(body.category || ""),
    category_label: String(body.category_label || ""),
    price: Number(body.price) || 0,
    original_price: body.original_price ? Number(body.original_price) : null,
    unit: String(body.unit || ""),
    weight_grams: Number(body.weight_grams) || 0,
    stock: Number(body.stock) ?? 0,
    rating: Number(body.rating) || 0,
    reviews_count: Number(body.reviews_count) || 0,
    image: String(body.image || ""),
    badge: String(body.badge || ""),
    origin: String(body.origin || ""),
    description: String(body.description || ""),
    benefits: typeof body.benefits === "string" ? body.benefits : JSON.stringify(body.benefits || []),
    storage_tips: String(body.storage_tips || ""),
    is_organic: body.is_organic ? 1 : 0,
    active: body.active !== undefined ? (body.active ? 1 : 0) : 1,
    sort_order: Number(body.sort_order) || 0,
  };
}

export default function productsRouter() {
  const router = Router();

  // Public: list active products
  router.get("/", (req, res) => {
    const admin = req.query.admin === "1";
    const products = admin
      ? productQueries.findAll.all()
      : productQueries.findActive.all();
    res.json({ products });
  });

  // Get single product
  router.get("/:id", (req, res) => {
    const product = productQueries.findById.get(req.params.id);
    if (!product) return res.status(404).json({ error: "Produk tidak ditemukan." });
    res.json({ product });
  });

  // Admin: create product
  router.post("/", (req, res) => {
    try {
      const data = parseProduct(req.body);
      if (!data.name) return res.status(400).json({ error: "Nama produk wajib diisi." });
      if (!data.slug) data.slug = data.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const result = productQueries.create.run(data);
      const product = productQueries.findById.get(result.lastInsertRowid);
      res.status(201).json({ ok: true, product });
    } catch (err) {
      if (err.message?.includes("UNIQUE")) {
        return res.status(400).json({ error: "Slug produk sudah ada." });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: update product
  router.put("/:id", (req, res) => {
    try {
      const existing = productQueries.findById.get(req.params.id);
      if (!existing) return res.status(404).json({ error: "Produk tidak ditemukan." });
      const data = parseProduct({ ...existing, ...req.body, id: Number(req.params.id) });
      productQueries.update.run(data);
      const product = productQueries.findById.get(req.params.id);
      res.json({ ok: true, product });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: delete product (hard delete)
  router.delete("/:id", (req, res) => {
    const existing = productQueries.findById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Produk tidak ditemukan." });
    productQueries.delete.run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
