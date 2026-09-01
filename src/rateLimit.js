/**
 * Rate limit — batas per IP. Endpoint notify paling ketat karena tiap
 * panggilan bisa memicu pengiriman WhatsApp.
 */
import rateLimit from "express-rate-limit";

const base = { standardHeaders: true, legacyHeaders: false };

export const notifyLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 60,
  message: { error: "Terlalu banyak order dalam waktu singkat. Coba lagi nanti." },
});

export const adminLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: { error: "Terlalu banyak permintaan. Coba lagi nanti." },
});

export const waLimiter = rateLimit({
  ...base,
  windowMs: 5 * 60 * 1000,
  limit: 30,
  message: { error: "Terlalu banyak aksi WhatsApp. Tunggu sebentar." },
});
