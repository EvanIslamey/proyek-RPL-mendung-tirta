import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { ApiError } from "./validate";
import type { Role, User } from "../../prisma/generated/client";

export const SESSION_COOKIE = "mt_session";
const SESSION_DAYS = 30;
const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;

/** Bentuk aman user untuk dikirim ke client — TANPA password. */
export type SafeUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  address: string | null;
  createdAt: Date;
};

export function sanitizeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    address: user.address,
    createdAt: user.createdAt,
  };
}

/** Hash SHA-256 untuk token sesi (diekspor untuk dipakai route ganti password). */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Hash bcrypt dummy untuk menyamakan waktu respons saat email tidak terdaftar
 * (mencegah user enumeration lewat timing).
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash("timing-equalizer", 10);
  return dummyHashPromise;
}

/**
 * Buat sesi login baru. Token asli hanya dikembalikan & dikirim ke cookie
 * (httpOnly); yang tersimpan di database hanyalah hash SHA-256-nya.
 */
export async function startSession(userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS);

  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Ambil user yang sedang login dari cookie sesi (null bila tidak ada). */
export async function getSessionUser(): Promise<SafeUser | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw || raw.length > 128) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: true },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    // Bersihkan sesi kedaluwarsa.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  // Akun yang dinonaktifkan admin kehilangan akses seketika.
  if (!session.user.isActive) return null;

  return sanitizeUser(session.user);
}

/** Hapus sesi aktif (logout) dan hapus cookie-nya. */
export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (raw) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(raw) } });
    cookieStore.delete(SESSION_COOKIE);
  }
}

/**
 * Registrasi pengguna baru dengan role BUYER atau SELLER.
 *
 * KEAMANAN: role harus salah satu dari BUYER/SELLER — ADMIN selalu ditolak
 * sehingga admin tidak bisa dibuat lewat registrasi publik. Untuk SELLER,
 * sebuah Store (toko) dibuat otomatis dengan nama default.
 */
export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  address: string | null;
  role?: string;
  storeName?: string | null;
}): Promise<SafeUser> {
  const passwordHash = await bcrypt.hash(input.password, 10);
  const role = input.role === "SELLER" ? "SELLER" : "BUYER";

  try {
    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        password: passwordHash,
        role, // BUYER atau SELLER saja — ADMIN ditolak oleh caller & guard di bawah
        address: input.address,
        ...(role === "SELLER"
          ? {
              store: {
                create: {
                  storeName: input.storeName?.trim() || `Toko ${input.name.trim()}`,
                  description: null,
                  location: input.address,
                },
              },
            }
          : {}),
      },
    });
    return sanitizeUser(user);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ApiError(409, "Email sudah terdaftar.", { email: "Email sudah terdaftar." });
    }
    throw e;
  }
}

/**
 * Ambil user login atau lempar 401. Untuk dipakai route handler yang wajib login.
 */
export async function requireUser(): Promise<SafeUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new ApiError(401, "Anda harus masuk terlebih dahulu.");
  }
  return user;
}

/**
 * Ambil user login dengan role tertentu atau lempar 401/403.
 * Semua endpoint privat wajib memanggil ini (cek role di backend).
 */
export async function requireRole(...roles: Role[]): Promise<SafeUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    throw new ApiError(403, "Anda tidak memiliki akses ke resource ini.");
  }
  return user;
}

/**
 * Verifikasi kredensial. Pesan error login selalu generik agar tidak membocorkan
 * keberadaan email.
 */
export async function authenticate(email: string, password: string): Promise<SafeUser | null> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Bandingkan dengan hash dummy agar waktu respons seragam.
    await bcrypt.compare(password, await getDummyHash());
    return null;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return null;

  // Pesan tetap generik — akun nonaktif diperlakukan sama seperti password salah
  // agar tidak membocorkan status akun.
  if (!user.isActive) return null;

  return sanitizeUser(user);
}

/** Deteksi pelanggaran unique constraint Prisma (P2002) tanpa mengimpor kelas error. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "P2002"
  );
}
