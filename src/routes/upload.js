/**
 * Upload routes — upload product images to local storage.
 */
import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(process.cwd(), "../sayur-v2/public/uploads/products")
);

// Ensure upload directory exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Tipe file tidak diizinkan. Gunakan JPG, PNG, atau WebP."));
    }
  },
});

export default function uploadRouter() {
  const router = Router();

  router.post("/", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Tidak ada file yang diupload." });
    }
    const url = `/uploads/products/${req.file.filename}`;
    res.json({ ok: true, url, filename: req.file.filename });
  });

  // Delete uploaded image
  router.delete("/:filename", (req, res) => {
    const filepath = path.join(UPLOAD_DIR, req.params.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    res.json({ ok: true });
  });

  return router;
}
