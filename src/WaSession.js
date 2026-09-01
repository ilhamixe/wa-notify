/**
 * WaSession — SATU koneksi WhatsApp milik toko (nomor admin), khusus KIRIM.
 *
 * Pola diambil dari sayur-shop/server/notify/WaSession.js: tidak menerima /
 * meneruskan pesan, hanya mengirim notif ke supplier + ambil daftar grup.
 *
 * PENTING: nomor WA di sini harus BERBEDA dari nomor yang dipakai aplikasi lain
 * (mis. wa-forward-saas / sayur-shop). Dua session dengan nomor sama = konflik
 * 440 terus-menerus.
 */
import {
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import path from "node:path";
import fs from "node:fs";
import config from "./config.js";

const logger = pino({ level: "silent" });

export class WaSession {
  /** @param {(event: string, payload?: any) => void} emit ke Socket.IO admin */
  constructor(emit = () => {}) {
    this.emit = emit;
    this.sock = null;
    this.state = "idle"; // idle|qr|connecting|connected|disconnected|error
    this.phoneNumber = "";
    this.lastQr = null;
    this.lastQrDataUrl = null;
    this.loggedIn = false;
    this.retryCount = 0;
    this.consecutive440 = 0;
    this.stopRequested = false;
    this.socketActive = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.sessionPath = path.join(config.sessionDir, "shop");
  }

  getStatus() {
    return {
      status: this.state,
      phoneNumber: this.phoneNumber,
      qr: this.state === "qr" ? this.lastQrDataUrl : null,
      hasSession: this.hasStoredSession(),
      ready: this.isReady(),
    };
  }

  /** Siap mengirim pesan? Dipakai worker outbox sebelum mencoba kirim. */
  isReady() {
    return this.loggedIn && this.state === "connected" && !!this.sock;
  }

  setState(status, extra = {}) {
    this.state = status;
    if (extra.phoneNumber !== undefined) this.phoneNumber = extra.phoneNumber;
    this.emit("wa-status", this.getStatus());
    console.log(`[WA] status: ${status}${extra.phoneNumber ? ` (${extra.phoneNumber})` : ""}`);
  }

  /** Ada session tersimpan di disk? (bisa reconnect tanpa scan QR) */
  hasStoredSession() {
    return fs.existsSync(path.join(this.sessionPath, "creds.json"));
  }

  async start() {
    this.stopRequested = false;
    this.consecutive440 = 0;
    if (this.sock && ["connecting", "qr", "connected"].includes(this.state)) {
      console.log(`[WA] sudah ${this.state} — abaikan start ganda.`);
      return this.getStatus();
    }
    await this.connect();
    return this.getStatus();
  }

  async stop() {
    this.stopRequested = true;
    this.loggedIn = false;
    await this.teardownSocket();
    this.setState("disconnected");
    return this.getStatus();
  }

  /** Hapus session (wajib scan QR ulang). */
  async reset() {
    this.stopRequested = true;
    this.loggedIn = false;
    await this.teardownSocket();
    if (fs.existsSync(this.sessionPath)) {
      fs.rmSync(this.sessionPath, { recursive: true, force: true });
      console.log("[WA] folder session dihapus.");
    }
    this.retryCount = 0;
    this.lastQr = null;
    this.lastQrDataUrl = null;
    this.setState("idle", { phoneNumber: "" });
    return this.getStatus();
  }

  /**
   * Matikan socket lama secara total & tunggu tertutup, lalu buang listener.
   * Dua socket hidup dengan creds sama memicu 401/440 dari WhatsApp.
   */
  async teardownSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    this.socketActive = false;
    if (!sock) return;

    if (sock.ws && sock.ws.readyState === 3) {
      try { sock.ev.removeAllListeners(); } catch {}
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 5000);
      try {
        sock.ev.on("connection.update", (u) => {
          if (u?.connection === "close") done();
        });
        sock.end(undefined);
      } catch {
        done();
      }
    });

    try { sock.ev.removeAllListeners(); } catch {}
    console.log("[WA] socket lama dimatikan.");
  }

  async connect() {
    if (this.stopRequested) return;
    if (this.socketActive) {
      console.log("[WA] socket masih aktif — abaikan connect() ganda.");
      return;
    }
    if (this.connecting) {
      console.log("[WA] connect() sedang berjalan — abaikan panggilan ganda.");
      return;
    }
    this.connecting = true;
    this.retryCount++;

    try {
      const { version } = await fetchLatestBaileysVersion();
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ["Samsung Galaxy S23", "Chrome (Android)", "122.0"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;
      this.socketActive = true;
      this.connecting = false;
      if (this.state !== "qr") this.setState("connecting");

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !this.loggedIn) {
          this.retryCount = 0;
          this.lastQr = qr;
          // Render ke data URL supaya dashboard tinggal pakai <img src>.
          QRCode.toDataURL(qr, { margin: 1, width: 320 })
            .then((dataUrl) => {
              this.lastQrDataUrl = dataUrl;
              this.setState("qr");
              this.emit("wa-qr", { qr: dataUrl });
            })
            .catch((err) => console.error("[WA] gagal render QR:", err?.message || err));
        }

        if (connection === "open") {
          this.loggedIn = true;
          this.retryCount = 0;
          this.consecutive440 = 0;
          this.lastQr = null;
          this.lastQrDataUrl = null;
          const phone = sock.user?.id?.split(":")[0] || "";
          this.setState("connected", { phoneNumber: phone });
        }

        if (connection === "close") {
          // Socket lama yang sudah diganti — jangan reset state / reconnect,
          // itu bikin socket ganda.
          if (this.sock !== sock) return;
          this.socketActive = false;

          const code = lastDisconnect?.error?.output?.statusCode;
          const msg = lastDisconnect?.error?.message || "";
          console.log(`[WA] koneksi tertutup (${code}) — ${msg}`);

          if (this.stopRequested) return;

          if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
            this.loggedIn = false;
            this.setState("error", { phoneNumber: "" });
            console.log("[WA] session logout — perlu scan QR ulang dari dashboard admin.");
            return;
          }

          if (code === DisconnectReason.restartRequired) {
            // 515 setelah pairing berhasil — reconnect cepat untuk selesaikan login.
            this.setState("connecting");
            this.reconnectTimer = setTimeout(() => this.connect(), 2000);
            return;
          }

          if (this.loggedIn) {
            this.setState("disconnected");
            if (code === 440) {
              // Konflik: reconnect cepat memperparah. Jeda bertahap max 45s.
              this.consecutive440++;
              const delay = Math.min(5000 * this.consecutive440, 45_000);
              console.log(`[WA] 440 conflict (${this.consecutive440}x) — reconnect ${delay / 1000}s`);
              this.reconnectTimer = setTimeout(() => this.connect(), delay);
              return;
            }
            this.consecutive440 = 0;
            const delay = Math.min(1000 * 2 ** Math.min(this.retryCount, 5), 30_000);
            console.log(`[WA] reconnect dalam ${delay / 1000}s (${this.retryCount})`);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
            return;
          }

          // Belum login — QR kadaluarsa. Jeda dulu, jangan spam QR baru.
          if (this.retryCount < 10) {
            this.setState("disconnected");
            const dwell = this.retryCount > 3 ? 180_000 : config.qrReconnectDelayMs;
            console.log(`[WA] belum login, QR baru dalam ${dwell / 1000}s...`);
            this.reconnectTimer = setTimeout(() => this.connect(), dwell);
          } else {
            this.setState("error");
            console.log("[WA] terlalu banyak percobaan — scan ulang dari dashboard.");
          }
        }
      });

      sock.ev.on("error", (err) => {
        console.error("[WA] error:", err?.message || err);
      });
    } catch (err) {
      this.connecting = false;
      console.error("[WA] fatal saat connect:", err?.message || err);
      if (this.retryCount < 5) {
        this.reconnectTimer = setTimeout(() => this.connect(), 10_000);
      } else {
        this.setState("error");
      }
    }
  }

  /** Minta pairing code 8 digit (alternatif QR, tanpa kamera). */
  async requestPairing(phone) {
    if (!this.sock) throw new Error("Mulai koneksi dulu sebelum minta pairing code.");
    if (this.loggedIn) throw new Error("WhatsApp sudah terhubung.");
    const code = await this.sock.requestPairingCode(phone);
    this.emit("wa-pairing-code", { code });
    return code;
  }

  /**
   * Kirim teks ke JID. Melempar error kalau belum siap / gagal —
   * worker outbox yang menangani retry.
   */
  async sendText(jid, body) {
    if (!this.isReady()) throw new Error("WhatsApp belum terhubung.");
    await this.sock.sendMessage(jid, { text: body });
  }

  /** Daftar grup yang diikuti — kalau mau kirim notif ke grup, bukan personal. */
  async fetchGroups() {
    if (!this.isReady()) throw new Error("WhatsApp belum terhubung.");
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      jid: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
    }));
  }

  /** Nomor ini terdaftar di WhatsApp? Dipakai sebelum simpan supplier. */
  async numberExists(phone) {
    if (!this.isReady()) throw new Error("WhatsApp belum terhubung.");
    const res = await this.sock.onWhatsApp(phone);
    return Array.isArray(res) && res.length > 0 && res[0].exists !== false;
  }
}

export default WaSession;
