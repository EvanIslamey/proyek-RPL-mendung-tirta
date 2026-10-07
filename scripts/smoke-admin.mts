/**
 * Smoke test Tahap 9: dashboard admin (otorisasi, CRUD, moderasi).
 * Jalankan terhadap dev server yang hidup:
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/smoke-admin.mts
 *
 * Catatan: pakai user temporer (register) + akun seed admin/nelayan.budi —
 * bucket rate-limit login tiap email dipantau agar tetap <= 5 per 5 menit.
 */
import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];
const skips: { name: string; detail: string }[] = [];

function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${!pass && detail ? ` (${detail})` : ""}`);
}

function skip(name: string, detail: string) {
  skips.push({ name, detail });
  console.log(`SKIP — ${name} (${detail})`);
}

async function api(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
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
  return {
    status: res.status,
    json: json as Record<string, unknown> | null,
    text,
    setCookie,
    headers: res.headers,
  };
}

function sessionCookie(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith("mt_session="));
  if (!raw) return null;
  const pair = raw.split(";")[0];
  return pair && !pair.endsWith("=") ? pair : null;
}

type Item = Record<string, unknown>;

async function main() {
  const stamp = Date.now();

  // ============ 0. Siapkan sesi ============
  const emailTemp = `smoke.admin.${stamp}@mendungtirta.com`;
  let cookieTemp: string | null = null;
  {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Tester Admin", email: emailTemp, password: "rahasia123", role: "BUYER" },
    });
    cookieTemp = sessionCookie(r.setCookie);
    check("Register pembeli uji -> 201 + cookie", r.status === 201 && cookieTemp !== null, `status ${r.status}`);
  }

  const loginAdmin = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin@mendungtirta.com", password: "password123" },
  });
  const cookieAdmin = sessionCookie(loginAdmin.setCookie);
  check("Login admin -> 200 + cookie", loginAdmin.status === 200 && cookieAdmin !== null, `status ${loginAdmin.status}`);
  if (!cookieTemp || !cookieAdmin) throw new Error("Sesi gagal — berhenti.");

  const meAdmin = await api("/api/auth/me", { cookie: cookieAdmin });
  const adminId = (meAdmin.json?.user as { id?: string } | null | undefined)?.id ?? "";

  // ============ 1. Otorisasi backend ============
  {
    const anon = await api("/api/admin/stats");
    check("GET /api/admin/stats tanpa login -> 401", anon.status === 401, `status ${anon.status}`);

    const buyer = await api("/api/admin/stats", { cookie: cookieTemp });
    check("GET stats dengan pembeli -> 403", buyer.status === 403, `status ${buyer.status}`);

    const loginBudi = await api("/api/auth/login", {
      method: "POST",
      body: { email: "nelayan.budi@mendungtirta.com", password: "password123" },
    });
    const cookieBudi = sessionCookie(loginBudi.setCookie);
    if (cookieBudi) {
      const seller = await api("/api/admin/stats", { cookie: cookieBudi });
      check("GET stats dengan penjual -> 403", seller.status === 403, `status ${seller.status}`);

      const sellerMut = await api("/api/admin/categories", {
        method: "POST",
        cookie: cookieBudi,
        body: { name: "Harus Ditolak" },
      });
      check("POST kategori dengan penjual -> 403", sellerMut.status === 403, `status ${sellerMut.status}`);
    } else {
      skip("Stats & mutasi ditolak untuk penjual", `login budi status ${loginBudi.status}`);
    }
  }

  // ============ 2. Guard halaman /admin ============
  {
    const anon = await api("/admin");
    const anonLoc = anon.headers.get("location") ?? "";
    check(
      "/admin tanpa login -> 307 ke /login",
      anon.status === 307 && anonLoc.includes("/login"),
      `status ${anon.status}, loc ${anonLoc}`,
    );

    const buyer = await api("/admin", { cookie: cookieTemp });
    const buyerLoc = buyer.headers.get("location") ?? "";
    check(
      "/admin dengan pembeli -> 307 ke / (bukan admin)",
      buyer.status === 307 && buyerLoc.includes("/"),
      `status ${buyer.status}, loc ${buyerLoc}`,
    );

    const admin = await api("/admin", { cookie: cookieAdmin });
    const adminLoc = admin.headers.get("location") ?? "";
    check(
      "/admin dengan admin -> 307 ke /admin/dashboard",
      admin.status === 307 && adminLoc.includes("/admin/dashboard"),
      `status ${admin.status}, loc ${adminLoc}`,
    );

    const dash = await api("/admin/dashboard", { cookie: cookieAdmin });
    check("/admin/dashboard dengan admin -> 200", dash.status === 200, `status ${dash.status}`);
    check("Shell admin memuat sidebar Panel Admin", dash.text.includes("Panel Admin"));

    const page = await api("/admin/users", { cookie: cookieAdmin });
    check("/admin/users dengan admin -> 200", page.status === 200, `status ${page.status}`);
  }

  // ============ 3. Statistik ============
  {
    const r = await api("/api/admin/stats", { cookie: cookieAdmin });
    const s = r.json as
      | {
          users?: { total?: number; byRole?: Record<string, number> };
          stores?: { total?: number };
          products?: { total?: number };
          orders?: { total?: number };
          revenue?: number;
          reviews?: { total?: number; average?: number };
        }
      | null;
    check(
      "GET stats -> 200 + struktur lengkap",
      r.status === 200 &&
        (s?.users?.total ?? 0) >= 4 &&
        (s?.stores?.total ?? 0) >= 2 &&
        (s?.products?.total ?? 0) >= 4 &&
        typeof s?.orders?.total === "number" &&
        typeof s?.revenue === "number" &&
        typeof s?.reviews?.total === "number",
      `status ${r.status}, ${r.text.slice(0, 200)}`,
    );
    check(
      "Stats memuat jumlah admin >= 1",
      (s?.users?.byRole?.ADMIN ?? 0) >= 1,
      String(s?.users?.byRole?.ADMIN),
    );
  }

  // ============ 4. Pengguna ============
  {
    const list = await api("/api/admin/users?limit=48", { cookie: cookieAdmin });
    check(
      "GET users -> 200 + items array",
      list.status === 200 && Array.isArray(list.json?.items),
      `status ${list.status}`,
    );

    const filtered = await api(`/api/admin/users?q=${encodeURIComponent(emailTemp)}`, {
      cookie: cookieAdmin,
    });
    const fItems = (filtered.json?.items ?? []) as Item[];
    check(
      "Filter q menemukan pengguna uji",
      filtered.status === 200 && fItems.some((u) => u.email === emailTemp),
      `status ${filtered.status}, items ${fItems.length}`,
    );

    const tempId = fItems.find((u) => u.email === emailTemp)?.id as string | undefined;

    // Self-protection
    const self = await api(`/api/admin/users/${adminId}`, {
      method: "PATCH",
      cookie: cookieAdmin,
      body: { role: "BUYER" },
    });
    check(
      "Admin ubah akun sendiri -> 400 (self-protection)",
      self.status === 400,
      `status ${self.status}`,
    );

    if (tempId) {
      const roleUp = await api(`/api/admin/users/${tempId}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { role: "SELLER" },
      });
      check("Ubah role pembeli uji -> SELLER -> 200", roleUp.status === 200, `status ${roleUp.status}`);

      const meTemp = await api("/api/auth/me", { cookie: cookieTemp });
      const tempRole = (meTemp.json?.user as { role?: string } | null | undefined)?.role;
      check("Sesi uji membaca role baru (SELLER)", tempRole === "SELLER", `role ${tempRole}`);

      const badRole = await api(`/api/admin/users/${tempId}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { role: "HACKER" },
      });
      check("Role tidak valid -> 400", badRole.status === 400, `status ${badRole.status}`);

      const off = await api(`/api/admin/users/${tempId}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { isActive: false },
      });
      check("Nonaktifkan akun -> 200", off.status === 200, `status ${off.status}`);

      const meAfter = await api("/api/auth/me", { cookie: cookieTemp });
      check(
        "Akun nonaktif: sesi aktif langsung ditolak",
        meAfter.status === 200 && meAfter.json?.user === null,
        `user=${JSON.stringify(meAfter.json?.user)}`,
      );

      const loginAfter = await api("/api/auth/login", {
        method: "POST",
        body: { email: emailTemp, password: "rahasia123" },
      });
      check("Akun nonaktif: login ditolak 401", loginAfter.status === 401, `status ${loginAfter.status}`);

      const restore = await api(`/api/admin/users/${tempId}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { role: "BUYER", isActive: true },
      });
      check("Pulihkan akun uji (BUYER, aktif) -> 200", restore.status === 200, `status ${restore.status}`);

      const meRestored = await api("/api/auth/me", { cookie: cookieTemp });
      check(
        "Sesi uji aktif kembali setelah dipulihkan",
        (meRestored.json?.user as { role?: string } | null | undefined)?.role === "BUYER",
        `user=${JSON.stringify(meRestored.json?.user)}`,
      );
    } else {
      skip("Manipulasi role/aktif pengguna uji", "id pengguna uji tidak ditemukan");
    }
  }

  // ============ 5. Toko ============
  {
    const list = await api("/api/admin/stores?limit=48", { cookie: cookieAdmin });
    check(
      "GET stores -> 200 + items array",
      list.status === 200 && Array.isArray(list.json?.items),
      `status ${list.status}`,
    );

    // Pilih toko yang punya produk AVAILABLE (via DB, akurat).
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    let targetStoreId: string | null = null;
    let baseTotal = 0;
    try {
      const store = await prisma.store.findFirst({
        where: { isActive: true, products: { some: { status: "AVAILABLE" } } },
        select: { id: true },
      });
      targetStoreId = store?.id ?? null;

      const pub = await api("/api/products?limit=1");
      baseTotal = Number((pub.json?.total as number | undefined) ?? 0);

      if (targetStoreId) {
        const off = await api(`/api/admin/stores/${targetStoreId}`, {
          method: "PATCH",
          cookie: cookieAdmin,
          body: { isActive: false },
        });
        check("Nonaktifkan toko -> 200", off.status === 200, `status ${off.status}`);

        const pubHidden = await api("/api/products?limit=1");
        const hiddenTotal = Number((pubHidden.json?.total as number | undefined) ?? 0);
        check(
          "Produk toko nonaktif hilang dari katalog publik",
          hiddenTotal < baseTotal,
          `total ${baseTotal} -> ${hiddenTotal}`,
        );

        const on = await api(`/api/admin/stores/${targetStoreId}`, {
          method: "PATCH",
          cookie: cookieAdmin,
          body: { isActive: true },
        });
        const pubBack = await api("/api/products?limit=1");
        const backTotal = Number((pubBack.json?.total as number | undefined) ?? 0);
        check(
          "Toko diaktifkan lagi -> produk kembali",
          on.status === 200 && backTotal === baseTotal,
          `status ${on.status}, total ${backTotal} (harus ${baseTotal})`,
        );
      } else {
        skip("Nonaktifkan toko & efek katalog", "tidak ada toko aktif dgn produk AVAILABLE");
      }

      const badStore = await api(`/api/admin/stores/${targetStoreId ?? "x"}`, {
        method: "PATCH",
        cookie: cookieTemp,
        body: { isActive: false },
      });
      check("PATCH toko dengan pembeli -> 403", badStore.status === 403, `status ${badStore.status}`);
    } finally {
      await prisma.$disconnect();
    }
  }

  // ============ 6. Kategori ============
  {
    const list = await api("/api/admin/categories", { cookie: cookieAdmin });
    const items = (list.json?.items ?? []) as Item[];
    check(
      "GET categories -> 200 + jumlah produk per kategori",
      list.status === 200 && items.length >= 3 && items.every((c) => typeof c.productCount === "number"),
      `status ${list.status}, items ${items.length}`,
    );

    const catName = `Uji Kategori ${stamp}`;
    const created = await api("/api/admin/categories", {
      method: "POST",
      cookie: cookieAdmin,
      body: { name: catName, description: "Kategori hasil smoke test" },
    });
    const catId = created.json?.categoryId as string | undefined;
    check("POST kategori valid -> 201 + id", created.status === 201 && Boolean(catId), `status ${created.status}`);

    const dup = await api("/api/admin/categories", {
      method: "POST",
      cookie: cookieAdmin,
      body: { name: catName },
    });
    check("POST nama kategori duplikat -> 400", dup.status === 400, `status ${dup.status}`);

    const invalid = await api("/api/admin/categories", {
      method: "POST",
      cookie: cookieAdmin,
      body: { name: "X" },
    });
    check("POST nama 1 karakter -> 400", invalid.status === 400, `status ${invalid.status}`);

    if (catId) {
      const renamed = await api(`/api/admin/categories/${catId}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { name: `${catName} v2` },
      });
      check("PATCH rename kategori -> 200", renamed.status === 200, `status ${renamed.status}`);

      const withProducts = items.find((c) => Number(c.productCount) > 0);
      if (withProducts) {
        const blocked = await api(`/api/admin/categories/${withProducts.id}`, {
          method: "DELETE",
          cookie: cookieAdmin,
        });
        check(
          "DELETE kategori berisi produk -> 409",
          blocked.status === 409,
          `status ${blocked.status}`,
        );
      } else {
        skip("DELETE kategori berisi produk -> 409", "tidak ada kategori berisi produk");
      }

      const removed = await api(`/api/admin/categories/${catId}`, {
        method: "DELETE",
        cookie: cookieAdmin,
      });
      check("DELETE kategori uji -> 200", removed.status === 200, `status ${removed.status}`);

      const gone = await api("/api/admin/categories", { cookie: cookieAdmin });
      const stillThere = ((gone.json?.items ?? []) as Item[]).some((c) => c.id === catId);
      check("Kategori uji hilang dari daftar", gone.status === 200 && !stillThere, `status ${gone.status}`);
    }
  }

  // ============ 7. Moderasi produk ============
  {
    const list = await api("/api/admin/products?limit=48", { cookie: cookieAdmin });
    check(
      "GET products admin -> 200 + items",
      list.status === 200 && Array.isArray(list.json?.items) && (list.json?.items as Item[]).length >= 4,
      `status ${list.status}`,
    );

    // Pakai produk publik pertama (pasti AVAILABLE).
    const pub = await api("/api/products?limit=1");
    const first = ((pub.json?.items ?? []) as { id?: string; name?: string }[])[0];
    if (first?.id) {
      const hide = await api(`/api/admin/products/${first.id}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { status: "HIDDEN" },
      });
      check("Moderasi: sembunyikan produk -> 200", hide.status === 200, `status ${hide.status}`);

      const detail = await api(`/api/products/${first.id}`);
      check("Produk disembunyikan -> detail publik 404", detail.status === 404, `status ${detail.status}`);

      const show = await api(`/api/admin/products/${first.id}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { status: "AVAILABLE" },
      });
      const detailBack = await api(`/api/products/${first.id}`);
      check(
        "Produk ditampilkan lagi -> 200",
        show.status === 200 && detailBack.status === 200,
        `show ${show.status}, detail ${detailBack.status}`,
      );

      const badStatus = await api(`/api/admin/products/${first.id}`, {
        method: "PATCH",
        cookie: cookieAdmin,
        body: { status: "DIJUAL_BEBAS" },
      });
      check("Status tidak valid -> 400", badStatus.status === 400, `status ${badStatus.status}`);

      const byBuyer = await api(`/api/admin/products/${first.id}`, {
        method: "PATCH",
        cookie: cookieTemp,
        body: { status: "HIDDEN" },
      });
      check("Moderasi produk oleh pembeli -> 403", byBuyer.status === 403, `status ${byBuyer.status}`);
    } else {
      skip("Moderasi produk", "tidak ada produk publik");
    }
  }

  // ============ 8. Pesanan (admin ubah status via /api/orders/[id]) ============
  {
    // Buat pesanan pembeli uji (stok harus pulih setelah dibatalkan).
    const p = await api("/api/products?limit=10");
    const cands = ((p.json?.items ?? []) as { id?: string }[]).map((x) => x.id).filter(Boolean) as string[];
    let buyableId: string | null = null;
    let stockBefore: number | null = null;
    for (const id of cands) {
      const s = await prismaStock(id);
      if (s !== null && s >= 1) {
        buyableId = id;
        stockBefore = s;
        break;
      }
    }

    if (buyableId) {

      const order = await api("/api/orders", {
        method: "POST",
        cookie: cookieTemp,
        body: {
          shippingAddress: "Jl. Uji Coba Admin 7",
          items: [{ productId: buyableId, quantity: 1 }],
        },
      });
      const orderId = order.json?.orderId as string | undefined;
      check("Pembeli uji membuat pesanan -> 201", order.status === 201 && Boolean(orderId), `status ${order.status}`);

      const list = await api("/api/admin/orders?limit=50", { cookie: cookieAdmin });
      const items = (list.json?.items ?? []) as { id?: string; buyer?: { email?: string } }[];
      check(
        "GET orders admin -> 200 memuat pesanan baru",
        list.status === 200 && items.some((o) => o.id === orderId),
        `status ${list.status}`,
      );

      const filtered = await api("/api/admin/orders?status=PENDING&limit=50", { cookie: cookieAdmin });
      const fItems = (filtered.json?.items ?? []) as { id?: string }[];
      check(
        "Filter status PENDING bekerja",
        filtered.status === 200 && fItems.some((o) => o.id === orderId),
        `status ${filtered.status}, items ${fItems.length}`,
      );

      if (orderId) {
        const next = await api(`/api/orders/${orderId}`, {
          method: "PATCH",
          cookie: cookieAdmin,
          body: { status: "PROCESSING" },
        });
        check("Admin ubah status PENDING -> PROCESSING", next.status === 200, `status ${next.status}: ${next.text.slice(0, 120)}`);

        const verify = await api(`/api/orders/${orderId}`, { cookie: cookieAdmin });
        check(
          "Status pesanan terbaca PROCESSING",
          (verify.json?.order as { status?: string } | undefined)?.status === "PROCESSING",
          `status ${verify.status}`,
        );

        const cancel = await api(`/api/orders/${orderId}`, {
          method: "PATCH",
          cookie: cookieAdmin,
          body: { action: "cancel" },
        });
        check("Admin batalkan pesanan (restock)", cancel.status === 200, `status ${cancel.status}: ${cancel.text.slice(0, 120)}`);

        const stockAfter = await prismaStock(buyableId);
        check(
          "Stok kembali setelah pembatalan",
          stockBefore !== null && stockAfter === stockBefore,
          `${stockBefore} -> ${stockAfter}`,
        );

        const illegal = await api(`/api/orders/${orderId}`, {
          method: "PATCH",
          cookie: cookieAdmin,
          body: { status: "PROCESSING" },
        });
        check("Transisi ilegal CANCELLED -> PROCESSING -> 409", illegal.status === 409, `status ${illegal.status}`);
      }
    } else {
      skip("Alur pesanan admin", "tidak ada produk beli");
    }
  }

  // ============ 9. Ulasan ============
  {
    const list = await api("/api/admin/reviews?limit=48", { cookie: cookieAdmin });
    check(
      "GET reviews admin -> 200 + items",
      list.status === 200 && Array.isArray(list.json?.items),
      `status ${list.status}`,
    );
    const items = (list.json?.items ?? []) as { id?: string }[];
    const target = items.find((r) => r.id);

    if (target?.id) {
      const byBuyer = await api(`/api/admin/reviews/${target.id}`, {
        method: "DELETE",
        cookie: cookieTemp,
      });
      check("DELETE review oleh pembeli -> 403", byBuyer.status === 403, `status ${byBuyer.status}`);

      const del = await api(`/api/admin/reviews/${target.id}`, {
        method: "DELETE",
        cookie: cookieAdmin,
      });
      check("DELETE review oleh admin -> 200", del.status === 200, `status ${del.status}`);

      const again = await api(`/api/admin/reviews/${target.id}`, {
        method: "DELETE",
        cookie: cookieAdmin,
      });
      check("DELETE review yang sudah hilang -> 404", again.status === 404, `status ${again.status}`);
    } else {
      skip("DELETE review (belum ada ulasan di DB)", "daftar review kosong");
    }
  }

  // --- Ringkasan ---
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`HASIL: ${checks.length - failed.length}/${checks.length} PASS, ${skips.length} SKIP`);
  if (failed.length > 0) {
    console.log("GAGAL:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

/** Baca stok produk langsung dari DB (untuk verifikasi restock). */
async function prismaStock(productId: string): Promise<number | null> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const p = await prisma.product.findUnique({ where: { id: productId }, select: { stock: true } });
    return p?.stock ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Smoke test error:", e);
  process.exit(1);
});
