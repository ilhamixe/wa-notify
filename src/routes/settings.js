/**
 * Settings routes — get/update shop settings (shop_name, courier_phone, etc.)
 */
import { Router } from "express";
import { settings } from "../db.js";

export default function settingsRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    res.json({ settings: settings.all() });
  });

  router.put("/", (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "Data tidak valid." });
      }
      for (const [key, value] of Object.entries(updates)) {
        if (typeof key === "string" && key.length <= 50) {
          settings.set(key, String(value));
        }
      }
      res.json({ ok: true, settings: settings.all() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
