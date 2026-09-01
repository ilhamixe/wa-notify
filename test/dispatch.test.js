/**
 * Cek jalan-sendiri untuk logika non-trivial: normalisasi nomor, validasi
 * order, pemetaan item → supplier, dan idempotensi dispatch.
 *
 * DB dipakai file sementara supaya tidak menyentuh data.db asli.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-notify-test-"));
process.env.DB_PATH = path.join(tmp, "test.db");
process.env.SESSION_DIR = path.join(tmp, "sessions");
process.env.API_TOKEN = "token-uji-jangan-dipakai";
process.env.NODE_ENV = "test";

const { normalizePhone, maskPhone, parseOrder, parseSupplier, ValidationError } = await import(
  "../src/validate.js"
);
const { supplierQueries, outboxQueries, notifyLogQueries } = await import("../src/db.js");
const { groupBySupplier, dispatchOrder } = await import("../src/dispatch.js");
const { backoffMinutes } = await import("../src/outbox.js");

test("normalizePhone menerima format lokal & internasional", () => {
  assert.equal(normalizePhone("081234567890"), "6281234567890");
  assert.equal(normalizePhone("+62 812-3456-7890"), "6281234567890");
  assert.equal(normalizePhone("81234567890"), "6281234567890");
  assert.equal(normalizePhone("6208123456789"), "628123456789");
  assert.equal(normalizePhone("123"), "", "terlalu pendek → kosong");
  assert.equal(normalizePhone(""), "");
});

test("maskPhone menyembunyikan bagian tengah", () => {
  assert.equal(maskPhone("6281234567890"), "628****7890");
  assert.equal(maskPhone("123"), "***");
});

test("backoffMinutes eksponensial dan dibatasi 6 jam", () => {
  assert.equal(backoffMinutes(1), 2);
  assert.equal(backoffMinutes(3), 8);
  assert.equal(backoffMinutes(20), 360);
});

test("parseSupplier menolak mapping_type asing", () => {
  assert.throws(
    () => parseSupplier({ name: "Pak Budi", phone: "081234567890", mapping_type: "vendor", ref_id: "x" }),
    ValidationError
  );
});

test("parseOrder menolak keranjang kosong & item tanpa target", () => {
  assert.throws(() => parseOrder({ orderId: "SS-1", items: [] }), ValidationError);
  assert.throws(
    () => parseOrder({ orderId: "SS-1", items: [{ name: "Tomat", qty: 1, price: 1000 }] }),
    ValidationError
  );
});

test("mapping produk menang atas mapping kategori", () => {
  supplierQueries.create.run({
    name: "Tukang Tomat",
    phone: "6281111111111",
    mapping_type: "product",
    ref_id: "tomat-cherry-manis",
    active: 1,
  });
  supplierQueries.create.run({
    name: "Bandar Umbi",
    phone: "6282222222222",
    mapping_type: "category",
    ref_id: "umbi_buah",
    active: 1,
  });

  const { groups, unmapped } = groupBySupplier([
    { productId: "tomat-cherry-manis", category: "umbi_buah", name: "Tomat Cherry", qty: 2, price: 11000 },
  ]);

  assert.equal(unmapped.length, 0);
  assert.equal(groups.size, 1);
  assert.equal([...groups.values()][0].supplier.name, "Tukang Tomat");
});

test("item tanpa mapping produk jatuh ke supplier kategori", () => {
  const { groups, unmapped } = groupBySupplier([
    { productId: "wortel-manis-selabintana", category: "umbi_buah", name: "Wortel", qty: 1, price: 9500 },
  ]);
  assert.equal(unmapped.length, 0);
  assert.equal([...groups.values()][0].supplier.name, "Bandar Umbi");
});

test("item tanpa supplier sama sekali masuk unmapped, bukan error", () => {
  const { groups, unmapped } = groupBySupplier([
    { productId: "jahe-merah-empon", category: "bumbu", name: "Jahe Merah", qty: 1, price: 15000 },
  ]);
  assert.equal(groups.size, 0);
  assert.deepEqual(unmapped.map((i) => i.name), ["Jahe Merah"]);
});

test("satu supplier dengan beberapa item digabung jadi satu pesan", () => {
  const result = dispatchOrder({
    orderId: "SS-GABUNG",
    customerName: "Ibu Ratna",
    customerPhone: "6289999999999",
    note: "",
    deliverySlot: "Pagi (06.00 - 09.00 WIB)",
    items: [
      { productId: "wortel-manis-selabintana", category: "umbi_buah", name: "Wortel", qty: 1, price: 9500 },
      { productId: "jamur-tiram-putih", category: "umbi_buah", name: "Jamur Tiram", qty: 2, price: 7500 },
    ],
  });

  assert.equal(result.queued, 1, "dua item satu kategori → satu pesan");
  const queued = outboxQueries.byOrder.all("SS-GABUNG");
  assert.equal(queued.length, 1);
  assert.match(queued[0].body, /Wortel 1x/);
  assert.match(queued[0].body, /Jamur Tiram 2x/);
  assert.match(queued[0].body, /SS-GABUNG/);
  assert.equal(queued[0].to_jid, "6282222222222@s.whatsapp.net");
});

test("dispatchOrder idempoten — orderId sama tidak diantre dua kali", () => {
  const order = {
    orderId: "SS-DOBEL",
    customerName: "Dimas",
    customerPhone: "",
    note: "",
    deliverySlot: "",
    items: [{ productId: "tomat-cherry-manis", category: "umbi_buah", name: "Tomat", qty: 1, price: 11000 }],
  };
  const first = dispatchOrder(order);
  const second = dispatchOrder(order);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(outboxQueries.byOrder.all("SS-DOBEL").length, 1);
  assert.ok(notifyLogQueries.findByOrder.get("SS-DOBEL"));
});

test("order dengan item campur mengantre ke beberapa supplier sekaligus", () => {
  const result = dispatchOrder({
    orderId: "SS-CAMPUR",
    customerName: "Chef Ani",
    customerPhone: "",
    note: "",
    deliverySlot: "",
    items: [
      { productId: "tomat-cherry-manis", category: "umbi_buah", name: "Tomat Cherry", qty: 3, price: 11000 },
      { productId: "jamur-tiram-putih", category: "umbi_buah", name: "Jamur Tiram", qty: 1, price: 7500 },
      { productId: "jahe-merah-empon", category: "bumbu", name: "Jahe Merah", qty: 1, price: 15000 },
    ],
  });

  assert.equal(result.queued, 2, "tukang tomat + bandar umbi");
  assert.deepEqual(result.unmapped, ["Jahe Merah"]);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
