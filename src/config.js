/**
 * Konfigurasi wa-notify — dibaca dari .env
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const isProd = (process.env.NODE_ENV || "development") === "production";

// API_TOKEN melindungi endpoint tulis (notify + CRUD supplier). Tanpa ini
// siapa pun yang bisa menjangkau port bisa memakai WhatsApp toko untuk spam.
let apiToken = process.env.API_TOKEN;
if (!apiToken) {
  if (isProd) {
    throw new Error("API_TOKEN wajib diisi di produksi. Generate: openssl rand -hex 32");
  }
  apiToken = crypto.randomBytes(16).toString("hex");
  console.warn(`[CONFIG] API_TOKEN kosong — pakai token sesi dev: ${apiToken}`);
}

export default {
  isProd,
  port: Number(process.env.PORT) || 3201,
  apiToken,
  dbPath: process.env.DB_PATH || path.join(root, "data.db"),
  sessionDir: process.env.SESSION_DIR || path.join(root, "sessions"),
  // Origin yang boleh memanggil API (frontend sayur-v2). Pisahkan dengan koma.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  waEnabled: (process.env.WA_ENABLED || "1") === "1",
  qrReconnectDelayMs: 90_000,
  outboxTickMs: 5_000,
  outboxMaxAttempts: 8,
};
