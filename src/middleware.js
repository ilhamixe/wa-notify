/**
 * Auth sederhana: bearer token statis (API_TOKEN).
 *
 * Layanan ini hanya dipakai oleh satu frontend (dashboard admin sayur-v2) dan
 * dijalankan di belakang reverse proxy, jadi token statis cukup — tidak ada
 * multi-user. Perbandingan timing-safe supaya token tidak bisa ditebak
 * karakter demi karakter.
 */
import crypto from "node:crypto";
import config from "./config.js";

const expected = Buffer.from(config.apiToken);

export function requireToken(req, res, next) {
  const header = String(req.get("authorization") || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : String(req.get("x-api-token") || "");
  const given = Buffer.from(token);

  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: "Token tidak valid." });
  }
  next();
}

/** Handler error terakhir — ValidationError → 400, sisanya 500. */
export function errorHandler(err, req, res, _next) {
  const status = err?.status || 500;
  if (status >= 500) console.error("[ERR]", err?.message || err);
  res.status(status).json({ error: err?.message || "Terjadi kesalahan." });
}
