/**
 * Worker pengirim outbox — mengirim notif WA yang tertunda dengan retry.
 *
 * Kenapa terpisah dari alur order:
 * - Order tidak boleh gagal gara-gara WA down. Order masuk DB dulu, notif
 *   diantre di tabel outbox, worker ini yang mengirim belakangan.
 * - Kalau gagal, jadwal ulang dengan backoff eksponensial (2^attempts menit).
 *   Setelah outboxMaxAttempts, ditandai 'failed' & muncul di dashboard admin.
 */
import { outboxQueries } from "./db.js";
import config from "./config.js";

/** Backoff: 2, 4, 8, 16 ... menit (dibatasi 6 jam). */
export function backoffMinutes(attempts) {
  return Math.min(2 ** attempts, 360);
}

export class OutboxWorker {
  /**
   * @param {import('./WaSession.js').WaSession} wa
   * @param {(event: string, payload?: any) => void} emit
   */
  constructor(wa, emit = () => {}) {
    this.wa = wa;
    this.emit = emit;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), config.outboxTickMs);
    this.timer.unref?.();
    console.log(`[OUTBOX] worker jalan (tiap ${config.outboxTickMs / 1000}s).`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return; // cegah tumpang tindih
    if (!config.waEnabled) return;
    if (!this.wa.isReady()) return; // tunggu WA connect; item tetap pending
    this.running = true;
    try {
      const batch = outboxQueries.due.all(10);
      for (const item of batch) {
        await this.deliver(item);
        await new Promise((r) => setTimeout(r, 1200)); // jeda anti rate-limit
      }
    } catch (err) {
      console.error("[OUTBOX] tick error:", err?.message || err);
    } finally {
      this.running = false;
    }
  }

  async deliver(item) {
    try {
      await this.wa.sendText(item.to_jid, item.body);
      outboxQueries.markSent.run(item.id);
      console.log(`[OUTBOX] terkirim #${item.id} → ${item.supplier_name || item.to_jid}`);
      this.emit("outbox-sent", { id: item.id, orderId: item.order_id });
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 200);
      const attempts = item.attempts + 1;
      if (attempts >= config.outboxMaxAttempts) {
        outboxQueries.markFailed.run(msg, item.id);
        console.error(`[OUTBOX] GAGAL PERMANEN #${item.id} (${attempts}x): ${msg}`);
        this.emit("outbox-failed", {
          id: item.id,
          orderId: item.order_id,
          supplier: item.supplier_name,
          error: msg,
        });
      } else {
        const delay = backoffMinutes(attempts);
        outboxQueries.markRetry.run(msg, delay, item.id);
        console.warn(`[OUTBOX] retry #${item.id} dalam ${delay}m (${attempts}x): ${msg}`);
      }
    }
  }
}

export default OutboxWorker;
