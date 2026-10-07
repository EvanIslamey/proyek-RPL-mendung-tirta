/**
 * Smoke test E2E autentikasi — jalankan terhadap dev server yang hidup:
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/smoke-auth.mts
 *
 * Menguji: validasi input, registrasi (anti privilege escalation), login,
 * sesi cookie, logout, rate limiting, proteksi lintas origin, penyimpanan
 * password ter-hash, dan login untuk akun seed tiap role.
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
  return { status: res.status, json: json as Record<string, unknown> | null, text, setCookie };
}

function sessionCookie(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith("mt_session="));
  if (!raw) return null;
  const pair = raw.split(";")[0];
  return pair && !pair.endsWith("=") ? pair : null;
}

async function main() {
  const stamp = Date.now();

  // --- 1. Cek sesi tanpa cookie ---
  {
    const r = await api("/api/auth/me");
    check("GET /me tanpa cookie -> user null", r.status === 200 && r.json?.user === null, `status ${r.status}`);
  }

  // --- 2. Validasi input registrasi ---
  {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: { name: "X", email: "bukan-email", password: "pendek" },
    });
    check(
      "Register invalid -> 400 + field errors",
      r.status === 400 && Boolean((r.json?.fields as Record<string, string>)?.email),
      `status ${r.status}`,
    );
  }

  // --- 3. Body JSON rusak -> 400 ---
  {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{tidak-valid",
    });
    check("Register body rusak -> 400", res.status === 400, `status ${res.status}`);
  }

  // --- 4. Anti privilege escalation: kirim role ADMIN, tetap jadi BUYER ---
  const email = `smoke.${stamp}@mendungtirta.com`;
  {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Smoke Tester", email, password: "rahasia123", address: "Jl. Uji Coba 1", role: "ADMIN" },
    });
    const user = r.json?.user as { role?: string; email?: string } | undefined;
    check(
      "Register sukses -> 201 & role selalu BUYER (upaya kirim ADMIN diabaikan)",
      r.status === 201 && user?.role === "BUYER",
      `status ${r.status}, role ${user?.role}`,
    );
    check("Response register tidak memuat password", !r.text.includes("rahasia123"));
    check("Register men-set cookie HttpOnly", (r.setCookie.join(" ") ?? "").includes("HttpOnly"));
    check("Register men-set cookie SameSite=Lax", /SameSite=Lax/i.test(r.setCookie.join(" ")));
  }

  // --- 5. Email duplikat -> 409 ---
  {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Duplikat", email, password: "rahasia123" },
    });
    check("Register email duplikat -> 409", r.status === 409, `status ${r.status}`);
  }

  // --- 6. Login password salah -> 401 generik ---
  {
    const r = await api("/api/auth/login", { method: "POST", body: { email, password: "salah-banget" } });
    check(
      "Login password salah -> 401 generik",
      r.status === 401 && String(r.json?.message ?? "").includes("salah"),
      `status ${r.status}`,
    );
  }

  // --- 7. Login lintas origin -> 403 ---
  {
    const r = await api("/api/auth/login", {
      method: "POST",
      body: { email, password: "rahasia123" },
      headers: { Origin: "http://evil.example" },
    });
    check("Login lintas origin (Origin beda) -> 403", r.status === 403, `status ${r.status}`);
  }

  // --- 8. Login sukses ---
  let buyerCookie = "";
  {
    const r = await api("/api/auth/login", { method: "POST", body: { email, password: "rahasia123" } });
    const c = sessionCookie(r.setCookie);
    buyerCookie = c ?? "";
    check("Login sukses -> 200 + cookie sesi", r.status === 200 && Boolean(c), `status ${r.status}`);
    check("Response login tidak memuat password", !r.text.includes("rahasia123"));
  }

  // --- 9. /me dengan sesi ---
  {
    const r = await api("/api/auth/me", { cookie: buyerCookie });
    const user = r.json?.user as { email?: string; role?: string } | undefined;
    check(
      "GET /me dengan cookie -> user benar",
      r.status === 200 && user?.email === email && user?.role === "BUYER",
      `email ${user?.email}`,
    );
  }

  // --- 10. Password tersimpan ter-hash di database ---
  {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    const row = await prisma.user.findUnique({ where: { email } });
    check(
      "Password di DB ter-hash bcrypt (bukan plaintext)",
      Boolean(row && /^\$2[aby]\$/.test(row.password) && row.password !== "rahasia123"),
    );
    await prisma.$disconnect();
  }

  // --- 11. Logout menghapus sesi di sisi server ---
  {
    const r = await api("/api/auth/logout", { method: "POST", cookie: buyerCookie });
    check("POST /logout -> 200", r.status === 200, `status ${r.status}`);
    const after = await api("/api/auth/me", { cookie: buyerCookie });
    check("Cookie lama setelah logout -> user null (sesi dihapus server)", after.json?.user === null);
  }

  // --- 12. Rate limit login per target ---
  {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await api("/api/auth/login", {
        method: "POST",
        body: { email: `korban.${stamp}@example.com`, password: "tebakan-salah" },
      });
      last = r.status;
    }
    check("Login gagal beruntun -> 429 (rate limit)", last === 429, `status terakhir ${last}`);
  }

  // --- 13. Rate limit per akun tidak mengunci IP lain (login seed tetap jalan) ---
  const seedAccounts = [
    { email: "pembeli@mendungtirta.com", role: "BUYER" },
    { email: "nelayan.budi@mendungtirta.com", role: "SELLER" },
    { email: "admin@mendungtirta.com", role: "ADMIN" },
  ];
  for (const acc of seedAccounts) {
    const r = await api("/api/auth/login", {
      method: "POST",
      body: { email: acc.email, password: "password123" },
    });
    const user = r.json?.user as { role?: string } | undefined;
    check(
      `Login seed ${acc.role} (${acc.email}) -> 200 & role cocok`,
      r.status === 200 && user?.role === acc.role,
      `status ${r.status}, role ${user?.role}`,
    );
  }

  // --- 14. Halaman UI ter-render ---
  for (const path of ["/login", "/register"]) {
    const res = await fetch(`${BASE}${path}`);
    const html = await res.text();
    check(`GET ${path} -> 200 & render form`, res.status === 200 && html.includes("<form"), `status ${res.status}`);
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
