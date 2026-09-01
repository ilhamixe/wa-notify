/**
 * wa-notify — microservice notifikasi WhatsApp untuk sayur-v2.
 *
 * Alur: checkout sayur-v2 POST /api/notify → item dipetakan ke supplier
 * (per produk, fallback per kategori) → pesan diantre di tabel outbox →
 * worker mengirim lewat satu koneksi Baileys milik nomor admin.
 *
 * Server sengaja bind ke 127.0.0.1: akses publik lewat reverse proxy.
 */
import express from "express";
import helmet from "helmet";
import cors from "cors";
import http from "node:http";
import { Server as SocketServer } from "socket.io";

import config from "./config.js";
import { settings } from "./db.js";
import WaSession from "./WaSession.js";
import OutboxWorker from "./outbox.js";
import { requireToken, errorHandler } from "./middleware.js";
import { notifyLimiter, adminLimiter, waLimiter } from "./rateLimit.js";
import suppliersRouter from "./routes/suppliers.js";
import notifyRouter from "./routes/notify.js";
import waRouter from "./routes/wa.js";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: config.allowedOrigins, credentials: true },
});

const emit = (event, payload) => io.emit(event, payload);
const wa = new WaSession(emit);
const worker = new OutboxWorker(wa, emit);

// Socket.IO dipakai untuk push QR & status WA ke dashboard admin secara live.
// Token diverifikasi saat handshake supaya QR tidak bisa dicuri orang lain.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token !== config.apiToken) return next(new Error("Token tidak valid."));
  next();
});
io.on("connection", (socket) => {
  socket.emit("wa-status", wa.getStatus());
});

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: config.allowedOrigins, credentials: true }));
app.use(express.json({ limit: "128kb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    shopName: settings.get("shop_name"),
    wa: wa.getStatus().status,
  });
});

app.use("/api/notify", notifyLimiter, requireToken, notifyRouter());
app.use("/api/suppliers", adminLimiter, requireToken, suppliersRouter());
app.get("/api/wa/status", requireToken, (req, res) => res.json(wa.getStatus()));
app.use("/api/wa", waLimiter, requireToken, waRouter(wa));

app.use((req, res) => res.status(404).json({ error: "Endpoint tidak ditemukan." }));
app.use(errorHandler);

server.listen(config.port, "127.0.0.1", async () => {
  console.log(`[WA-NOTIFY] jalan di http://127.0.0.1:${config.port}`);
  console.log(`[WA-NOTIFY] origin diizinkan: ${config.allowedOrigins.join(", ")}`);
  worker.start();

  // Auto-reconnect kalau session sudah pernah dipair — tidak perlu scan ulang
  // setiap kali server restart.
  if (config.waEnabled && wa.hasStoredSession()) {
    console.log("[WA] session tersimpan ditemukan — mencoba reconnect...");
    wa.start().catch((err) => console.error("[WA] gagal auto-start:", err?.message || err));
  } else if (config.waEnabled) {
    console.log("[WA] belum ada session — hubungkan dari dashboard admin.");
  }
});

async function shutdown(signal) {
  console.log(`\n[WA-NOTIFY] ${signal} — menutup...`);
  worker.stop();
  await wa.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
