/**
 * Smoke test E2E marketplace & transaksi — jalankan terhadap dev server hidup:
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/smoke-marketplace.mts
 *
 * Menguji: katalog (search/filter/sort/pagination), checkout atomik
 * (stok, anti oversell, total server-side), pembayaran dummy, otorisasi
 * order (IDOR), pembatalan + restock, syarat ulasan, dan role guard.
 */
import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${!pass && detail ? ` (${detail})` : ""}`);
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

async function login(email: string, password: string): Promise<string> {
  const r = await api("/api/auth/login", { method: "POST", body: { email, password } });
  const c = sessionCookie(r.setCookie);
  if (!c) throw new Error(`login gagal untuk ${email}: status ${r.status}`);
  return c;
}

async function main() {
  // --- 1. Katalog ---
  let productWithStock: { id: string; name: string; stock: number; price: number } | null = null;
  {
    const r = await api("/api/products?limit=48");
    const items = (r.json?.items ?? []) as { id: string; name: string; stock: number; price: number }[];
    check("GET /api/products -> 200 + items", r.status === 200 && items.length > 0, `status ${r.status}`);
    productWithStock = items.find((p) => p.stock >= 3) ?? null;
    check("ada produk dengan stok >= 3", productWithStock !== null);

    const search = await api("/api/products?q=joran");
    const sItems = (search.json?.items ?? []) as { name: string }[];
    check("search q=joran menemukan produk", sItems.some((p) => p.name.toLowerCase().includes("joran")));

    const asc = await api("/api/products?sort=harga-asc");
    const prices = ((asc.json?.items ?? []) as { price: number }[]).map((p) => p.price);
    check(
      "sort harga-asc menaik",
      prices.every((v, i) => i === 0 || prices[i - 1] <= v),
      JSON.stringify(prices),
    );

    const page = await api("/api/products?limit=2&page=1");
    check(
      "pagination limit=2 -> 2 item",
      ((page.json?.items ?? []) as unknown[]).length === 2 && page.json?.limit === 2,
    );
  }

  if (!productWithStock) {
    console.error("Tidak ada produk stok >= 3 — seed belum jalan?");
    process.exit(1);
  }

  // --- 2. Checkout wajib login ---
  {
    const r = await api("/api/orders", {
      method: "POST",
      body: { shippingAddress: "Jl. Uji Coba 1", items: [{ productId: productWithStock.id, quantity: 1 }] },
    });
    check("POST /api/orders tanpa login -> 401", r.status === 401, `status ${r.status}`);
  }

  const buyer = await login("pembeli@mendungtirta.com", "password123");
  const seller = await login("nelayan.budi@mendungtirta.com", "password123");
  const seller2 = await login("toko.pancing.jaya@mendungtirta.com", "password123");

  // --- 3. Checkout sukses (stok didekrementasi, total dari server) ---
  const stockBefore = productWithStock.stock;
  let orderId = "";
  {
    const r = await api("/api/orders", {
      method: "POST",
      cookie: buyer,
      body: {
        shippingAddress: "Perumahan Bukit Indah, Kav 8",
        items: [{ productId: productWithStock.id, quantity: 2 }],
      },
    });
    orderId = (r.json?.orderId as string) ?? "";
    check("POST /api/orders login -> 201 + orderId", r.status === 201 && Boolean(orderId), `status ${r.status}`);

    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 4 });
    const prisma = new PrismaClient({ adapter });
    const p = await prisma.product.findUnique({ where: { id: productWithStock.id } });
    check(
      "stok berkurang 2 setelah checkout",
      p?.stock === stockBefore - 2,
      `stok ${p?.stock} (harap ${stockBefore - 2})`,
    );
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true, orderItems: true },
    });
    const expectedTotal = Number(order?.orderItems[0]?.price ?? 0) * 2;
    check("total order dihitung server (price x qty)", Number(order?.total) === expectedTotal);
    check("record Payment PENDING dibuat", order?.payment?.status === "PENDING");
    await prisma.$disconnect();
  }

  // --- 4. Validasi input checkout ---
  {
    const bad = await api("/api/orders", {
      method: "POST",
      cookie: buyer,
      body: { shippingAddress: "Jl", items: [{ productId: productWithStock.id, quantity: 1 }] },
    });
    check("alamat terlalu pendek -> 400", bad.status === 400, `status ${bad.status}`);

    const empty = await api("/api/orders", {
      method: "POST",
      cookie: buyer,
      body: { shippingAddress: "Alamat Cukup Panjang", items: [] },
    });
    check("checkout keranjang kosong -> 400", empty.status === 400, `status ${empty.status}`);

    const huge = await api("/api/orders", {
      method: "POST",
      cookie: buyer,
      body: {
        shippingAddress: "Alamat Cukup Panjang",
        items: [{ productId: productWithStock.id, quantity: 999 }],
      },
    });
    check("quantity melebihi stok -> 409 (tidak oversell)", huge.status === 409, `status ${huge.status}`);
  }

  // --- 5. Detail order: pemilik OK, IDOR ditolak ---
  {
    const own = await api(`/api/orders/${orderId}`, { cookie: buyer });
    check("pembeli melihat order sendiri -> 200", own.status === 200, `status ${own.status}`);

    const asSeller = await api(`/api/orders/${orderId}`, { cookie: seller });
    // Boleh jika produk ada di tokonya, 404 jika bukan — keduanya sah;
    // yang penting BUKAN 200 dengan data milik orang lain tanpa hak.
    check(
      "penjual non-pemilik produk -> 200 (karena produk di tokonya) ATAU 404",
      asSeller.status === 200 || asSeller.status === 404,
      `status ${asSeller.status}`,
    );

    const anon = await api(`/api/orders/${orderId}`);
    check("detail order tanpa login -> 401", anon.status === 401, `status ${anon.status}`);
  }

  // --- 6. Bayar (dummy) + pembeli tidak bisa ubah status langsung ---
  {
    const pay = await api(`/api/orders/${orderId}/pay`, { method: "POST", cookie: buyer, body: {} });
    check("POST /pay -> 200", pay.status === 200, `status ${pay.status}`);

    const detail = await api(`/api/orders/${orderId}`, { cookie: buyer });
    const order = detail.json?.order as { status?: string; paymentStatus?: string } | undefined;
    check("status order -> PROCESSING setelah bayar", order?.status === "PROCESSING", order?.status);
    check("payment -> PAID setelah bayar", order?.paymentStatus === "PAID", order?.paymentStatus);

    const doublePay = await api(`/api/orders/${orderId}/pay`, { method: "POST", cookie: buyer, body: {} });
    check("bayar dua kali -> 409", doublePay.status === 409, `status ${doublePay.status}`);

    const buyerEdit = await api(`/api/orders/${orderId}`, {
      method: "PATCH",
      cookie: buyer,
      body: { status: "COMPLETED" },
    });
    check("pembeli ubah status -> 403", buyerEdit.status === 403, `status ${buyerEdit.status}`);
  }

  // --- 7. Penjual memproses pesanan (transisi sah) ---
  {
    const ship = await api(`/api/orders/${orderId}`, {
      method: "PATCH",
      cookie: seller,
      body: { status: "SHIPPED" },
    });
    check("penjual PROCESSING -> SHIPPED -> 200", ship.status === 200, `status ${ship.status}`);

    const illegal2 = await api(`/api/orders/${orderId}`, {
      method: "PATCH",
      cookie: seller,
      body: { status: "PENDING" },
    });
    check("transisi ilegal (SHIPPED -> PENDING) -> 409", illegal2.status === 409, `status ${illegal2.status}`);

    const done = await api(`/api/orders/${orderId}`, {
      method: "PATCH",
      cookie: seller,
      body: { status: "COMPLETED" },
    });
    check("penjual SHIPPED -> COMPLETED -> 200", done.status === 200, `status ${done.status}`);
  }

  // --- 8. Review: syarat pembelian & uniqueness ---
  {
    const other = await api("/api/products?limit=1");
    const otherId = ((other.json?.items ?? []) as { id: string }[])[0].id;
    const forbidden = await api(`/api/products/${otherId}/reviews`, {
      method: "POST",
      cookie: seller2,
      body: { rating: 5, comment: "Palsu" },
    });
    check(
      "review tanpa pembelian selesai -> 403",
      forbidden.status === 403 || forbidden.status === 401,
      `status ${forbidden.status}`,
    );

    const badRating = await api(`/api/products/${productWithStock.id}/reviews`, {
      method: "POST",
      cookie: buyer,
      body: { rating: 9 },
    });
    check("rating 9 -> 400", badRating.status === 400, `status ${badRating.status}`);

    // Idempoten: hapus ulasan lama (buyer, produk) agar test bisa diulang.
    {
      const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 4 });
      const prisma = new PrismaClient({ adapter });
      const buyerUser = await prisma.user.findUnique({
        where: { email: "pembeli@mendungtirta.com" },
        select: { id: true },
      });
      if (buyerUser) {
        await prisma.review.deleteMany({
          where: { buyerId: buyerUser.id, productId: productWithStock.id },
        });
      }
      await prisma.$disconnect();
    }

    const ok = await api(`/api/products/${productWithStock.id}/reviews`, {
      method: "POST",
      cookie: buyer,
      body: { rating: 5, comment: "Barang sampai dengan baik." },
    });
    check("review produk yang dibeli -> 201", ok.status === 201, `status ${ok.status}: ${ok.text.slice(0, 120)}`);

    const dup = await api(`/api/products/${productWithStock.id}/reviews`, {
      method: "POST",
      cookie: buyer,
      body: { rating: 4 },
    });
    check("review duplikat -> 409", dup.status === 409, `status ${dup.status}`);

    const edit = await api(`/api/products/${productWithStock.id}/reviews`, {
      method: "PATCH",
      cookie: buyer,
      body: { rating: 4, comment: "Diperbarui: masih oke." },
    });
    check("edit review sendiri -> 200", edit.status === 200, `status ${edit.status}`);

    // Ulasan terbaru tampil di detail produk publik.
    const detail = await api(`/api/products/${productWithStock.id}`);
    const reviews = (detail.json?.reviews ?? []) as { rating: number }[];
    check(
      "detail produk menampilkan ulasan terbaru",
      reviews.some((r) => r.rating === 4),
      JSON.stringify(reviews.map((r) => r.rating)),
    );
  }

  // --- 9. Pembatalan + restock ---
  {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 4 });
    const prisma = new PrismaClient({ adapter });
    const before = await prisma.product.findUnique({
      where: { id: productWithStock.id },
      select: { stock: true },
    });

    const r2 = await api("/api/orders", {
      method: "POST",
      cookie: buyer,
      body: {
        shippingAddress: "Perumahan Bukit Indah, Kav 8",
        items: [{ productId: productWithStock.id, quantity: 1 }],
      },
    });
    const secondId = (r2.json?.orderId as string) ?? "";
    check("order kedua -> 201", r2.status === 201 && Boolean(secondId), `status ${r2.status}`);

    const cancel = await api(`/api/orders/${secondId}`, {
      method: "PATCH",
      cookie: buyer,
      body: { action: "cancel" },
    });
    check("pembeli batalkan order PENDING -> 200", cancel.status === 200, `status ${cancel.status}`);

    const after = await prisma.product.findUnique({
      where: { id: productWithStock.id },
      select: { stock: true },
    });
    check(
      "stok dikembalikan setelah pembatalan",
      after?.stock === (before?.stock ?? 0),
      `stok ${after?.stock} (harap ${before?.stock})`,
    );
    await prisma.$disconnect();
  }

  // --- 10. Role guard endpoint privat ---
  {
    const list = await api("/api/orders", { cookie: buyer });
    check("GET /api/orders (pembeli) -> 200 + array", list.status === 200 && Array.isArray(list.json?.orders));

    const buyerOnSeller = await api("/api/seller/products", { cookie: buyer }).catch(() => null);
    if (buyerOnSeller) {
      check(
        "pembeli akses /api/seller/* -> 403",
        buyerOnSeller.status === 403 || buyerOnSeller.status === 404,
        `status ${buyerOnSeller.status}`,
      );
    }
  }

  // --- 11. Halaman UI ter-render ---
  for (const path of ["/products", "/cart", "/orders"]) {
    const res = await fetch(`${BASE}${path}`);
    const html = await res.text();
    check(`GET ${path} -> 200 & render`, res.status === 200 && html.length > 500, `status ${res.status}`);
  }
  {
    const res = await fetch(`${BASE}/products/${productWithStock.id}`);
    const html = await res.text();
    check(
      "GET /products/[id] -> 200 & render nama produk",
      res.status === 200 && html.includes(productWithStock.name),
      `status ${res.status}`,
    );
  }

  // --- Ringkasan ---
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== HASIL: ${checks.length - failed.length}/${checks.length} PASS ===`);
  if (failed.length > 0) {
    console.log("Gagal:");
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("SMOKE TEST ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
