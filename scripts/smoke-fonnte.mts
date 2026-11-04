/**
 * Smoke test END-TO-END Fonnte WhatsApp Gateway via MOCK server lokal.
 * Tidak mengirim WhatsApp nyata, tidak memakai token asli, tidak membuka internet.
 *
 * Prasyarat (dev server hidup):
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/smoke-fonnte.mts
 * Catatan: beri jeda >=60 detik setelah smoke-integrations (rate-limit uji per user).
 *
 * Alur mock: http://127.0.0.1:3999 meniru api.fonnte.com dengan 4 model token:
 *   - mock-ok          : /device connect, /send selalu masuk antrean (status:true)
 *   - mock-bad-token   : /device & /send ditolak provider (status:false "token invalid")
 *   - mock-disconnected: /device status "disconnect", /send ditolak
 *   - mock-send-fail   : /device connect, /send gagal (Status false + alasan)
 *
 * Yang dibuktikan:
 *  A. Simpan token (terenkripsi, tak pernah bocor), Uji Koneksi & kirim pesan uji
 *     memakai endpoint mock — sukses HANYA bila body provider status:true;
 *     token salah / perangkat putus / kuota habis / jaringan mati -> GAGAL JUJUR;
 *     guard Aktifkan hanya lolos setelah uji koneksi sukses; token via header
 *     Authorization TANPA Bearer; countryCode "0".
 *  B. Notifikasi per role lewat pipeline asli (createOrder/payOrder/setOrderStatus):
 *     BUYER & SELLER kirim hanya bila nomor +62 dan ada persetujuan opt-in;
 *     ADMIN memakai penerima operasional global — SATU pesan per kejadian
 *     (anti ganda, klaim atomik), tanpa pesan ganda, riwayat waStatus tercatat.
 *  C. Kegagalan Fonnte (kuota habis / token salah) TIDAK PERNAH menggagalkan
 *     transaksi: order tetap 201 & bisa dibayar/dibatalkan; hanya waStatus=FAILED.
 *  D. Pembersihan penuh: order/notifikasi uji dihapus, phone/notify user & stok
 *     produk dipulihkan, baris config WA dihapus. Config AI NVIDIA TIDAK disentuh.
 */
import http from "node:http";
import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const MOCK_PORT = 3999;
const MOCK_ENDPOINT = `http://127.0.0.1:${MOCK_PORT}`;

const TOKEN_OK = "mock-ok-token-1234567890";
const TOKEN_BAD = "mock-bad-token-1234567890";
const TOKEN_DOWN = "mock-disconnected-token-1234567890";
const TOKEN_SEND_FAIL = "mock-send-fail-token-1234567890";

const OPS_A = "+628555000111";
const OPS_B = "+628555000222";
const OPS_JOINED = "628555000111,628555000222";
const BUYER_PHONE = "+6281234567890";
const SELLER_PHONE = "+628999888777";

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${!pass && detail ? ` (${detail})` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll kondisi sampai terpenuhi (timeout -> false). */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await cond()) return true;
    } catch {
      /* DB mungkin sedang sibuk — coba lagi */
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

async function api(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json: json as Record<string, unknown> | null, text, setCookie };
}

function sessionCookie(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith("mt_session="));
  if (!raw) return null;
  const pair = raw.split(";")[0];
  return pair && !pair.endsWith("=") ? pair : null;
}

async function login(email: string, password: string): Promise<string | null> {
  const r = await api("/api/auth/login", { method: "POST", body: { email, password } });
  return sessionCookie(r.setCookie);
}

// ---------------------------------------------------------------------------
// Mock Fonnte (server HTTP lokal — semua permintaan dicatat untuk asersi)
// ---------------------------------------------------------------------------

type SentLog = {
  path: string;
  token: string;
  noBearer: boolean;
  target: string | null;
  message: string | null;
  countryCode: string | null;
  ok: boolean; // true hanya bila mock MENjawab status:true (benar-benar "terkirim")
};
const sent: SentLog[] = [];
const deviceHits: { token: string; noBearer: boolean }[] = [];

/** Ambil nilai field multipart FormData (mock memakai batas --<boundary>). */
function field(body: string, name: string): string | null {
  const m = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  return m ? (m[1] ?? null) : null;
}

const mockServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const token = (req.headers.authorization ?? "").trim();
    const noBearer = !/^Bearer/i.test(token);
    const path = (req.url ?? "").replace(/\/+$/, "");
    res.setHeader("Content-Type", "application/json");

    if (path === "/device") {
      deviceHits.push({ token, noBearer });
      if (token === TOKEN_OK || token === TOKEN_SEND_FAIL) {
        res.end(
          JSON.stringify({
            device: "628777000111",
            device_status: "connect",
            name: "Mock Fonnte",
            quota: "42",
            package: "Trial",
            expired: "1 Januari 2030",
            status: true,
          }),
        );
        return;
      }
      if (token === TOKEN_DOWN) {
        res.end(JSON.stringify({ device: "628777000111", device_status: "disconnect", status: true }));
        return;
      }
      res.end(JSON.stringify({ status: false, reason: "token invalid" }));
      return;
    }

    if (path === "/send") {
      const target = field(body, "target");
      const message = field(body, "message");
      const countryCode = field(body, "countryCode");
      const ok = token === TOKEN_OK;
      sent.push({ path, token, noBearer, target, message, countryCode, ok });
      if (ok) {
        res.end(JSON.stringify({ detail: "success! message in queue", status: true }));
        return;
      }
      if (token === TOKEN_SEND_FAIL) {
        // Sengaja memakai key "Status" (huruf besar) — casing respons Fonnte tidak konsisten.
        res.end(JSON.stringify({ Status: false, message: "insufficient quota" }));
        return;
      }
      if (token === TOKEN_DOWN) {
        res.end(JSON.stringify({ status: false, reason: "device not connected" }));
        return;
      }
      res.end(JSON.stringify({ status: false, reason: "token invalid" }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ status: false, reason: "not found" }));
  });
});

const successful = () => sent.filter((s) => s.ok);

type ConfigView = {
  meta?: Record<string, string> | null;
  hasCredential?: boolean;
  credentialHint?: string | null;
  isActive?: boolean;
  lastTestOk?: boolean | null;
};

async function saveWa(
  cookie: string,
  credential: string | undefined,
  extra: Record<string, string>,
  endpoint: string,
) {
  return api("/api/settings/whatsapp", {
    method: "PUT",
    cookie,
    body: {
      provider: "fonnte",
      endpoint,
      ...(credential ? { credential } : {}),
      meta: {
        testTarget: "+628111111111",
        senderNumber: "+628777000111",
        opsTargets: `${OPS_A}, ${OPS_B}`,
        ...extra,
      },
    },
  });
}

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  // --- SNAPSHOT proteksi (dipulihkan di finally) ---
  const userSnapshot = await prisma.user.findMany({
    select: { id: true, phone: true, whatsappNotify: true },
  });
  const productSnapshot = await prisma.product.findMany({ select: { id: true, stock: true } });
  const orderSnapshot = await prisma.order.findMany({ select: { id: true } });
  const orderIds = new Set(orderSnapshot.map((o) => o.id));
  const notifSnapshot = await prisma.notification.findMany({ select: { id: true } });
  const notifIds = new Set(notifSnapshot.map((n) => n.id));
  // Baris WA (konfigurasi ASLI) disnapshot dulu sebelum dibersihkan untuk uji,
  // lalu DIPULIHKAN di finally — jangan pernah menghapus konfigurasi asli permanen.
  const waSnapshot = await prisma.integrationConfig.findMany({ where: { service: "WHATSAPP" } });
  await prisma.integrationConfig.deleteMany({ where: { service: "WHATSAPP" } });
  console.log(
    `[snapshot] users=${userSnapshot.length} products=${productSnapshot.length} orders=${orderSnapshot.length} notif=${notifSnapshot.length}; baris WA uji dibersihkan (${waSnapshot.length} baris asli disnapshot).`,
  );

  await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, "127.0.0.1", resolve));
  console.log(`[mock] Fonnte mock aktif di ${MOCK_ENDPOINT}`);

  try {
    const admin = await login("admin@mendungtirta.com", "password123");
    const buyer = await login("pembeli@mendungtirta.com", "password123");
    const seller = await login("nelayan.budi@mendungtirta.com", "password123");
    if (!admin || !buyer || !seller) throw new Error("Gagal login seed — server & seed harus hidup.");

    const sellerUser = await prisma.user.findUnique({
      where: { email: "nelayan.budi@mendungtirta.com" },
      select: { id: true },
    });
    const buyerUser = await prisma.user.findUnique({
      where: { email: "pembeli@mendungtirta.com" },
      select: { id: true },
    });
    if (!sellerUser || !buyerUser) throw new Error("User seed tidak ditemukan.");

    // Produk milik seller dengan stok aman (hindari gangguan stok-menipis saat uji).
    const product = await prisma.product.findFirst({
      where: { store: { userId: sellerUser.id }, stock: { gte: 10 } },
      orderBy: { id: "asc" },
      select: { id: true, name: true, stock: true },
    });
    if (!product) {
      throw new Error("Tidak ada produk seller (nelayan.budi) dengan stok >= 10 untuk uji.");
    }

    // =========================================================================
    // A. Konfigurasi, uji koneksi, kirim pesan uji, guard aktivasi
    // =========================================================================
    {
      const save = await saveWa(admin, TOKEN_OK, {}, MOCK_ENDPOINT);
      check("A. Simpan konfigurasi WA (endpoint mock) -> 200", save.status === 200, `status ${save.status}: ${save.text.slice(0, 140)}`);
      check("A. Response simpan TIDAK memuat token mentah", !save.text.includes(TOKEN_OK));
      check("A. Response simpan menampilkan hint tersamarkan", /mock-ok.{0,16}1234|•{3,}/.test(save.text), save.text.slice(0, 240));

      const test1 = await api("/api/settings/whatsapp/test", { method: "POST", cookie: admin });
      const r1 = test1.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "A. Uji koneksi (mock ok) -> sukses + info perangkat (nomor, connect, kuota)",
        test1.status === 200 && r1?.ok === true && /628777000111/.test(r1?.note ?? "") && /kuota|quota|42/i.test(r1?.note ?? ""),
        `ok=${r1?.ok} note=${r1?.note}`,
      );
      check(
        "A. /device dipanggil dengan Authorization TANPA Bearer",
        deviceHits.length > 0 && deviceHits[0]?.token === TOKEN_OK && deviceHits[0]?.noBearer === true,
        JSON.stringify(deviceHits[0]),
      );
      const get1 = await api("/api/settings/whatsapp", { cookie: admin });
      const cfg1 = get1.json?.config as ConfigView | null | undefined;
      check(
        "A. Snapshot status perangkat tersimpan di meta (deviceStatus=connect)",
        cfg1?.meta?.deviceStatus === "connect" && cfg1?.meta?.deviceNumber === "628777000111",
        JSON.stringify(cfg1?.meta),
      );
      check(
        "A. opsTargets admin ternormalisasi & tersimpan",
        cfg1?.meta?.opsTargets === `${OPS_A},${OPS_B}`,
        JSON.stringify(cfg1?.meta),
      );

      const on1 = await api("/api/settings/whatsapp/toggle", { method: "POST", cookie: admin, body: { isActive: true } });
      check("A. Aktifkan setelah lolos uji koneksi -> 200", on1.status === 200, `status ${on1.status}: ${on1.text.slice(0, 140)}`);

      const msg1 = await api("/api/settings/whatsapp/test", {
        method: "PUT",
        cookie: admin,
        body: { to: "+628111111111" },
      });
      const mr1 = msg1.json?.result as { ok?: boolean; note?: string } | undefined;
      const gotSend1 = await waitFor(async () => successful().length >= 1);
      check(
        "A. Kirim pesan uji -> ok & mock mencatat pengiriman ke nomor tujuan",
        msg1.status === 200 && mr1?.ok === true && gotSend1 && sent.some((s) => s.ok && s.target === "628111111111"),
        `ok=${mr1?.ok} note=${mr1?.note} sent=${JSON.stringify(sent.map((s) => s.target))}`,
      );
      const s0 = sent[0];
      check(
        "A. Body kirim memakai FormData (target digit, countryCode=0, tanpa Bearer)",
        !!s0 && s0.target === "628111111111" && s0.countryCode === "0" && s0.noBearer === true,
        JSON.stringify(s0),
      );

      const badTo = await api("/api/settings/whatsapp/test", {
        method: "PUT",
        cookie: admin,
        body: { to: "081234567890" },
      });
      check("A. Nomor tujuan non-E.164 -> 400, TANPA permintaan keluar", badTo.status === 400 && successful().length === 1, `status ${badTo.status} sent=${successful().length}`);

      // Token salah -> uji koneksi GAGAL jujur dengan alasan provider.
      await saveWa(admin, TOKEN_BAD, {}, MOCK_ENDPOINT);
      const testBad = await api("/api/settings/whatsapp/test", { method: "POST", cookie: admin });
      const rBad = testBad.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "A. Token salah -> uji koneksi ok=false + alasan provider 'token invalid'",
        testBad.status === 200 && rBad?.ok === false && /token invalid/i.test(rBad?.note ?? ""),
        `ok=${rBad?.ok} note=${rBad?.note}`,
      );
      check("A. Catatan gagal TIDAK memuat token mentah", !testBad.text.includes(TOKEN_BAD));

      // Perangkat terputus -> gagal jujur + snapshot status diperbarui.
      await saveWa(admin, TOKEN_DOWN, {}, MOCK_ENDPOINT);
      const testDown = await api("/api/settings/whatsapp/test", { method: "POST", cookie: admin });
      const rDown = testDown.json?.result as { ok?: boolean; note?: string } | undefined;
      const getDown = await api("/api/settings/whatsapp", { cookie: admin });
      const cfgDown = (getDown.json?.config as ConfigView | null | undefined)?.meta ?? null;
      check(
        "A. Perangkat disconnect -> ok=false + meta deviceStatus=disconnect",
        testDown.status === 200 && rDown?.ok === false && /disconnect/i.test(rDown?.note ?? "") && cfgDown?.deviceStatus === "disconnect",
        `ok=${rDown?.ok} note=${rDown?.note} meta=${JSON.stringify(cfgDown)}`,
      );

      // Perangkat connect tapi kirim gagal (kuota) -> respons Status false terbaca.
      // CATATAN: simpan token/endpoint baru SELALU menonaktifkan konfigurasi
      // (reset uji) — setelah uji device lolos, aktifkan ulang via toggle.
      await saveWa(admin, TOKEN_SEND_FAIL, {}, MOCK_ENDPOINT);
      const testSf = await api("/api/settings/whatsapp/test", { method: "POST", cookie: admin });
      const rSf = testSf.json?.result as { ok?: boolean; note?: string } | undefined;
      const onSf = await api("/api/settings/whatsapp/toggle", { method: "POST", cookie: admin, body: { isActive: true } });
      const msgSf = await api("/api/settings/whatsapp/test", {
        method: "PUT",
        cookie: admin,
        body: { to: "+628111111111" },
      });
      const mrSf = msgSf.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "A. Kuota habis (Status false, huruf besar) -> kirim uji GAGAL jujur",
        testSf.status === 200 && rSf?.ok === true && onSf.status === 200 && msgSf.status === 200 && mrSf?.ok === false && /insufficient quota/i.test(mrSf?.note ?? "") && successful().length === 1,
        `deviceOk=${rSf?.ok} toggle=${onSf.status} sendOk=${mrSf?.ok} note=${mrSf?.note} sent=${successful().length}`,
      );

      // Endpoint mati -> gagal jaringan, bukan sukses.
      await saveWa(admin, undefined, {}, "http://127.0.0.1:1");
      const testDead = await api("/api/settings/whatsapp/test", { method: "POST", cookie: admin });
      const rDead = testDead.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "A. Endpoint tak terjangkau -> ok=false 'Gagal menghubungi Fonnte'",
        testDead.status === 200 && rDead?.ok === false && /gagal menghubungi/i.test(rDead?.note ?? ""),
        `ok=${rDead?.ok} note=${rDead?.note}`,
      );

      // Pulihkan endpoint mock + token mock-ok; aktifkan kembali.
      await saveWa(admin, TOKEN_OK, {}, MOCK_ENDPOINT);
      const testOk2 = await api("/api/settings/whatsapp/test", { method: "POST", cookie: admin });
      const rOk2 = testOk2.json?.result as { ok?: boolean; note?: string } | undefined;
      const off = await api("/api/settings/whatsapp/toggle", { method: "POST", cookie: admin, body: { isActive: false } });
      const on2 = await api("/api/settings/whatsapp/toggle", { method: "POST", cookie: admin, body: { isActive: true } });
      const getFinal = await api("/api/settings/whatsapp", { cookie: admin });
      const cfgFinal = getFinal.json?.config as ConfigView | null | undefined;
      check(
        "A. Setelah uji sukses: Nonaktifkan & Aktifkan -> 200, status akhir aktif",
        rOk2?.ok === true && off.status === 200 && on2.status === 200 && cfgFinal?.isActive === true,
        `ok=${rOk2?.ok} off=${off.status} on=${on2.status} active=${cfgFinal?.isActive}`,
      );
    }

    // =========================================================================
    // B. Notifikasi per role via pipeline transaksi ASLI
    // =========================================================================
    {
      // Titik-awal deterministik: buyer & seller tanpa nomor/persetujuan.
      await api("/api/profile", { method: "PATCH", cookie: buyer, body: { phone: null, whatsappNotify: false } });
      await api("/api/profile", { method: "PATCH", cookie: seller, body: { phone: null, whatsappNotify: false } });

      // --- B1. Pesanan baru (buyer & seller BELUM setuju) ---
      const o1res = await api("/api/orders", {
        method: "POST",
        cookie: buyer,
        body: { items: [{ productId: product.id, quantity: 1 }], shippingAddress: "Jl. Uji Fonnte No. 1" },
      });
      const o1 = (o1res.json?.orderId as string | undefined) ?? "";
      check("B. Pesanan baru -> 201 (order tercipta walau tanpa WA)", o1res.status === 201 && o1.length > 0, `status ${o1res.status}: ${o1res.text.slice(0, 140)}`);

      const rows1 = await prisma.notification.findMany({
        where: { dedupeKey: { contains: o1 } },
        include: { user: { select: { id: true, role: true } } },
      });
      const buyerO1 = rows1.find((r) => r.user.id === buyerUser.id && r.kind === "ORDER_CREATED");
      const sellerO1 = rows1.find((r) => r.user.id === sellerUser.id && r.kind === "ORDER_CREATED");
      const adminO1 = rows1.filter((r) => r.user.role === "ADMIN" && r.kind === "ORDER_CREATED");
      check(
        "B. Pesanan baru: baris BUYER tanpa persetujuan -> SKIPPED (riwayat beralasan)",
        buyerO1?.waStatus === "SKIPPED" && /belum diisi|Persetujuan/i.test(buyerO1?.waError ?? ""),
        `status=${buyerO1?.waStatus} err=${buyerO1?.waError}`,
      );
      check(
        "B. Pesanan baru: baris SELLER tanpa persetujuan -> SKIPPED",
        sellerO1?.waStatus === "SKIPPED",
        `status=${sellerO1?.waStatus}`,
      );
      const adminO1Sent = await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { dedupeKey: { contains: o1 }, waStatus: { in: ["PENDING", "SENDING", "SENT"] } },
          include: { user: { select: { role: true } } },
        });
        return rows.some((r) => r.user.role === "ADMIN" && r.waStatus === "SENT");
      });
      const adminO1Final = await prisma.notification.findMany({
        where: { dedupeKey: { contains: o1 } },
        include: { user: { select: { role: true } } },
      });
      const adminO1Rows = adminO1Final.filter((r) => r.user.role === "ADMIN" && r.kind === "ORDER_CREATED");
      const adminO1WaSent = adminO1Rows.filter((r) => r.waStatus === "SENT");
      check(
        "B. Pesanan baru: ADMIN -> TEPAT SATU baris WA terkirim (anti ganda)",
        adminO1Sent && adminO1.length > 0 && adminO1WaSent.length === 1,
        `admins=${adminO1Rows.length} sent=${adminO1WaSent.length} statuses=${adminO1Rows.map((r) => r.waStatus).join(",")}`,
      );
      const opsO1 = await waitFor(async () => successful().some((s) => s.target === OPS_JOINED));
      check(
        "B. Pesanan baru: SATU request WA ke penerima operasional (kedua nomor, satu pesan)",
        opsO1 && successful().filter((s) => s.target === OPS_JOINED).length === 1,
        `sent=${JSON.stringify(successful().map((s) => s.target))}`,
      );

      // --- B2. Pembayaran dikonfirmasi ---
      const pay = await api(`/api/orders/${o1}/pay`, { method: "POST", cookie: buyer });
      check("B. Bayar pesanan -> 200 (transaksi jalan)", pay.status === 200, `status ${pay.status}: ${pay.text.slice(0, 120)}`);
      const getO1 = await api(`/api/orders/${o1}`, { cookie: buyer });
      const o1Status = (getO1.json?.order as { status?: string } | undefined)?.status;
      check("B. Status pesanan menjadi PROCESSING", o1Status === "PROCESSING", `status=${o1Status}`);

      const rows2 = await prisma.notification.findMany({
        where: { dedupeKey: { contains: o1 } },
        include: { user: { select: { id: true, role: true } } },
      });
      const buyerPay = rows2.find((r) => r.user.id === buyerUser.id && r.kind === "PAYMENT_CONFIRMED");
      // CATATAN: penjual menerima kabar pembayaran sebagai ORDER_STATUS_CHANGED
      // ("sudah dibayar — menunggu diproses"), bukan kind PAYMENT_CONFIRMED.
      const sellerPay = rows2.find(
        (r) => r.dedupeKey === `order:${o1}:status:PROCESSING:seller:${sellerUser.id}`,
      );
      check(
        "B. Pembayaran: BUYER belum setuju -> SKIPPED",
        buyerPay?.waStatus === "SKIPPED",
        `status=${buyerPay?.waStatus}`,
      );
      check("B. Pembayaran: SELLER belum setuju -> SKIPPED", sellerPay?.waStatus === "SKIPPED", `status=${sellerPay?.waStatus}`);
      const paySentOk = await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { dedupeKey: { contains: o1 }, kind: "PAYMENT_CONFIRMED", waStatus: { in: ["PENDING", "SENDING", "SENT"] } },
          include: { user: { select: { role: true } } },
        });
        return rows.some((r) => r.user.role === "ADMIN" && r.waStatus === "SENT");
      });
      check(
        "B. Pembayaran: ADMIN -> tepat satu WA operasional terkirim",
        paySentOk && successful().filter((s) => s.target === OPS_JOINED).length === 2,
        `opsSent=${successful().filter((s) => s.target === OPS_JOINED).length}`,
      );

      // --- B3. Persetujuan diberikan (opt-in via API profil) ---
      const buyerConsent = await api("/api/profile", {
        method: "PATCH",
        cookie: buyer,
        body: { phone: BUYER_PHONE, whatsappNotify: true },
      });
      const sellerConsent = await api("/api/profile", {
        method: "PATCH",
        cookie: seller,
        body: { phone: SELLER_PHONE, whatsappNotify: true },
      });
      check(
        "B. Opt-in WA buyer & seller tersimpan (validasi +62 lulus)",
        buyerConsent.status === 200 && sellerConsent.status === 200,
        `buyer=${buyerConsent.status} seller=${sellerConsent.status}`,
      );

      // --- B4. Perubahan status (SHIPPED) oleh admin ---
      const ship = await api(`/api/orders/${o1}`, {
        method: "PATCH",
        cookie: admin,
        body: { status: "SHIPPED" },
      });
      check("B. Ubah status pesanan -> 200", ship.status === 200, `status ${ship.status}: ${ship.text.slice(0, 140)}`);

      const shipOk = await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { dedupeKey: { contains: o1 }, kind: "ORDER_STATUS_CHANGED" },
        });
        const buyerRow = rows.find((r) => r.dedupeKey === `order:${o1}:status:SHIPPED`);
        const sellerRow = rows.find(
          (r) => r.dedupeKey === `order:${o1}:status:SHIPPED:seller:${sellerUser.id}`,
        );
        const adminRows = rows.filter((r) => r.dedupeKey === `order:${o1}:admin:status:SHIPPED`);
        return (
          buyerRow?.waStatus === "SENT" &&
          sellerRow?.waStatus === "SENT" &&
          adminRows.some((r) => r.waStatus === "SENT")
        );
      });
      const rows3 = await prisma.notification.findMany({
        where: { dedupeKey: { contains: o1 } },
        include: { user: { select: { id: true, role: true } } },
      });
      const adminShip = rows3.filter((r) => r.user.role === "ADMIN" && r.dedupeKey.includes(":admin:status:SHIPPED"));
      check(
        "B. SHIPPED: BUYER & SELLER (sudah setuju) -> SENT; ADMIN -> tepat satu SENT",
        shipOk && adminShip.filter((r) => r.waStatus === "SENT").length === 1,
        `adminShip=${adminShip.map((r) => r.waStatus).join(",")}`,
      );
      const expectedTargets = ["628111111111", OPS_JOINED, OPS_JOINED, "6281234567890", "628999888777", OPS_JOINED]
        .sort()
        .join("|");
      const actualTargets = successful()
        .map((s) => s.target ?? "")
        .sort()
        .join("|");
      check(
        "B. Total pengiriman persis sesuai kejadian (TANPA pesan ganda/massal)",
        actualTargets === expectedTargets,
        `actual=[${actualTargets}] expected=[${expectedTargets}]`,
      );

      const shipMsg = successful().find((s) => s.target === "6281234567890");
      check(
        "B. Pesan WA memuat tautan identitas pesanan (short id)",
        !!shipMsg && !!shipMsg.message && shipMsg.message.includes(o1.slice(0, 8)),
        shipMsg?.message?.slice(0, 120) ?? "pesan tidak ditemukan",
      );

      // Riwayat notifikasi tercatat (status + alasan + percobaan).
      const histBuyer = await prisma.notification.findMany({
        where: { userId: buyerUser.id, waStatus: { not: "SKIPPED" }, waAttempts: { gt: 0 } },
        select: { waStatus: true, waAttempts: true, waError: true },
      });
      check(
        "B. Riwayat: baris terkirim mencatat waStatus SENT + percobaan",
        histBuyer.some((r) => r.waStatus === "SENT" && r.waAttempts >= 1),
        JSON.stringify(histBuyer),
      );
      const histApi = await api("/api/notifications", { cookie: buyer });
      check("B. API riwayat notifikasi buyer -> 200", histApi.status === 200, `status ${histApi.status}`);
    }

    // =========================================================================
    // C. Kegagalan Fonnte TIDAK menggagalkan transaksi marketplace
    // =========================================================================
    {
      // Kuota habis pada konfigurasi yang SUDAH aktif (skenario nyata: kuota
      // habis SETELAH aktivasi). Simpan token menonaktifkan konfigurasi (desain
      // reset-uji), jadi status aktif disimulasikan persis seperti keadaan
      // produksi yang sedang berjalan.
      await saveWa(admin, TOKEN_SEND_FAIL, {}, MOCK_ENDPOINT);
      await prisma.integrationConfig.update({
        where: { service_scope: { service: "WHATSAPP", scope: "" } },
        data: { isActive: true },
      });
      const o2res = await api("/api/orders", {
        method: "POST",
        cookie: buyer,
        body: { items: [{ productId: product.id, quantity: 1 }], shippingAddress: "Jl. Gagal Kirim No. 2" },
      });
      const o2 = (o2res.json?.orderId as string | undefined) ?? "";
      check(
        "C. Pesanan baru saat kirim WA GAGAL (kuota) -> tetap 201 SUKSES",
        o2res.status === 201 && o2.length > 0,
        `status ${o2res.status}: ${o2res.text.slice(0, 140)}`,
      );
      const o2Failed = await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { dedupeKey: { contains: o2 }, waStatus: { in: ["FAILED", "PENDING", "SENDING"] } },
        });
        const buyerRow = rows.find((r) => r.userId === buyerUser.id);
        const adminRow = rows.find((r) => r.dedupeKey.includes(":admin:"));
        return buyerRow?.waStatus === "FAILED" && adminRow?.waStatus === "FAILED";
      });
      const o2Rows = await prisma.notification.findMany({ where: { dedupeKey: { contains: o2 } } });
      const o2Buyer = o2Rows.find((r) => r.userId === buyerUser.id);
      check(
        "C. WA gagal (kuota) -> dicatat FAILED + alasan provider, transaksi TIDAK rusak",
        o2Failed && (o2Buyer?.waError ?? "").includes("insufficient quota") && (o2Buyer?.waAttempts ?? 0) >= 1,
        `status=${o2Buyer?.waStatus} err=${o2Buyer?.waError} attempts=${o2Buyer?.waAttempts}`,
      );
      const getO2 = await api(`/api/orders/${o2}`, { cookie: buyer });
      const o2Status = (getO2.json?.order as { status?: string } | undefined)?.status;
      check("C. Pesanan O2 tetap berstatus PENDING (utuh)", o2Status === "PENDING", `status=${o2Status}`);

      // Pembatalan oleh pembeli tetap sukses saat WA gagal.
      const cancel = await api(`/api/orders/${o2}`, { method: "PATCH", cookie: buyer, body: { action: "cancel" } });
      const getO2b = await api(`/api/orders/${o2}`, { cookie: buyer });
      const o2Status2 = (getO2b.json?.order as { status?: string } | undefined)?.status;
      check(
        "C. Pembatalan O2 -> 200 & CANCELLED (kegagalan WA tidak menghalangi)",
        cancel.status === 200 && o2Status2 === "CANCELLED",
        `cancel=${cancel.status} status=${o2Status2}`,
      );

      // Token salah: guard API menolak aktivasi tanpa uji lolos (uji akan gagal),
      // lalu status aktif disimulasikan — skenario produksi "token dicabut/dirotasi
      // SETELAH konfigurasi aktif".
      await saveWa(admin, TOKEN_BAD, {}, MOCK_ENDPOINT);
      const guardBad = await api("/api/settings/whatsapp/toggle", {
        method: "POST",
        cookie: admin,
        body: { isActive: true },
      });
      check(
        "C. Guard: token salah -> Aktifkan via API DITOLAK (belum lolos uji)",
        guardBad.status >= 400,
        `status ${guardBad.status}: ${guardBad.text.slice(0, 120)}`,
      );
      await prisma.integrationConfig.update({
        where: { service_scope: { service: "WHATSAPP", scope: "" } },
        data: { isActive: true },
      });
      const o3res = await api("/api/orders", {
        method: "POST",
        cookie: buyer,
        body: { items: [{ productId: product.id, quantity: 1 }], shippingAddress: "Jl. Token Salah No. 3" },
      });
      const o3 = (o3res.json?.orderId as string | undefined) ?? "";
      check(
        "C. Pesanan baru saat token SALAH -> tetap 201 SUKSES",
        o3res.status === 201 && o3.length > 0,
        `status ${o3res.status}`,
      );
      const o3Failed = await waitFor(async () => {
        const rows = await prisma.notification.findMany({ where: { dedupeKey: { contains: o3 } } });
        const buyerRow = rows.find((r) => r.userId === buyerUser.id);
        return buyerRow?.waStatus === "FAILED";
      });
      const o3Rows = await prisma.notification.findMany({ where: { dedupeKey: { contains: o3 } } });
      const o3Buyer = o3Rows.find((r) => r.userId === buyerUser.id);
      check(
        "C. Token salah -> waStatus FAILED + alasan 'token invalid' (bukan sukses palsu)",
        o3Failed && /token invalid/i.test(o3Buyer?.waError ?? ""),
        `err=${o3Buyer?.waError}`,
      );
      check(
        "C. Gagal total Fonnte: jumlah pengiriman 'sukses' TIDAK bertambah (tetap 6)",
        successful().length === 6,
        `sent=${successful().length}`,
      );

      // Tidak ada baris yang nyangkut di SENDING + config AI masih utuh.
      // Tunggu dulu baris o2/o3 keluar dari SENDING (baris admin/ops atau
      // retry kadang masih diproses saat baris buyer sudah FAILED) — jika
      // benar-benar nyangkut, waitFor akan timeout dan hitungan tetap > 0.
      const stuckWhere = {
        waStatus: "SENDING" as const,
        OR: [o2, o3].map((id) => ({ dedupeKey: { contains: id } })),
      };
      await waitFor(async () => (await prisma.notification.count({ where: stuckWhere })) === 0, 15_000);
      const stuckRows = await prisma.notification.findMany({
        where: stuckWhere,
        select: { id: true, kind: true, userId: true, waAttempts: true, waError: true, dedupeKey: true },
      });
      const stuckAny = stuckRows.length;
      check(
        "C. Tidak ada notifikasi uji nyangkut di SENDING",
        stuckAny === 0,
        stuckAny === 0
          ? "stuck=0"
          : `stuck=${stuckAny} ` +
            JSON.stringify(
              stuckRows.map((r) => ({
                kind: r.kind,
                att: r.waAttempts,
                err: (r.waError ?? "").slice(0, 40),
                key: (r.dedupeKey ?? "").slice(0, 60),
              })),
            ),
      );
      const aiOk = await prisma.integrationConfig.findFirst({
        where: { service: "AI_PROVIDER", isActive: true },
      });
      check(
        "C. Config AI AKTIF tetap utuh selama smoke berjalan",
        aiOk !== null && aiOk.isActive === true,
        aiOk ? `provider=${aiOk.provider} model=${aiOk.model ?? "-"}` : "config AI tidak ditemukan!",
      );

      // Token tidak pernah masuk ke konten pesan yang dikirim.
      const allTokens = [TOKEN_OK, TOKEN_BAD, TOKEN_DOWN, TOKEN_SEND_FAIL];
      check(
        "C. Token tak pernah bocor ke isi pesan yang dikirim",
        sent.every((s) => !allTokens.some((t) => (s.message ?? "").includes(t))),
        sent.map((s) => (s.message ?? "").slice(0, 40)).join(" | ").slice(0, 200),
      );
      check(
        "C. Semua request memakai header Authorization TANPA Bearer",
        sent.every((s) => s.noBearer) && deviceHits.every((d) => d.noBearer),
        JSON.stringify(sent.map((s) => s.noBearer)),
      );
      check(
        "C. Hanya token mock-ok yang menghasilkan pengiriman sukses",
        successful().every((s) => s.token === TOKEN_OK),
        JSON.stringify(successful().map((s) => s.token)),
      );
    }
  } finally {
    // --- RESTORE penuh (jalan juga saat gagal) ---
    try {
      mockServer.close();
      await prisma.order.deleteMany({ where: { id: { notIn: [...orderIds] } } });
      await prisma.notification.deleteMany({ where: { id: { notIn: [...notifIds] } } });
      await prisma.integrationConfig.deleteMany({ where: { service: "WHATSAPP" } });
      // Kembalikan baris WA ASLI hasil snapshot (id/meta/credential utuh).
      let waRestored = 0;
      if (waSnapshot.length > 0) {
        await prisma.integrationConfig.createMany({ data: waSnapshot });
        waRestored = await prisma.integrationConfig.count({ where: { service: "WHATSAPP" } });
      }
      for (const u of userSnapshot) {
        await prisma.user.updateMany({
          where: { id: u.id },
          data: { phone: u.phone, whatsappNotify: u.whatsappNotify },
        });
      }
      for (const p of productSnapshot) {
        await prisma.product.update({ where: { id: p.id }, data: { stock: p.stock } });
      }
      const aiStill = await prisma.integrationConfig.findFirst({
        where: { service: "AI_PROVIDER", isActive: true },
      });
      console.log(
        `[restore] order uji dihapus, notifikasi uji dihapus, profil user & stok dipulihkan, baris WA asli dipulihkan (${waRestored}/${waSnapshot.length}). AI aktif: ${aiStill ? aiStill.provider : "TIDAK ADA!"}`,
      );
    } catch (e) {
      console.error("[restore] GAGAL memulihkan:", e);
    } finally {
      await prisma.$disconnect();
    }
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== Ringkasan Fonnte: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} FAIL ===`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Smoke Fonnte gagal berjalan:", e);
  try {
    mockServer.close();
  } catch {
    /* sudah tertutup */
  }
  process.exit(1);
});
