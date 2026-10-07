/**
 * Utilitas validasi input untuk API routes.
 * Sengaja dibuat kecil dan tanpa dependensi tambahan.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Batas ukuran body request (byte) — tolak payload tidak wajar lebih awal. */
const MAX_BODY_BYTES = 32 * 1024;

/** Parse JSON body dengan aman. Melempar ApiError(400/413) bila tidak valid. */
export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    throw new ApiError(413, "Data terlalu besar.");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, "Body request tidak dapat dibaca.");
  }
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "Data terlalu besar.");
  }

  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "Body request harus berupa JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "JSON tidak valid.");
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** Validasi field registrasi. Mengembalikan map error per field (kosong = valid). */
export function validateRegister(body: Record<string, unknown>): {
  name: string;
  email: string;
  password: string;
  address: string | null;
  role: "BUYER" | "SELLER";
  storeName: string | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  const name = asTrimmedString(body.name);
  if (name.length < 2 || name.length > 100) {
    errors.name = "Nama harus 2–100 karakter.";
  }

  const email = asTrimmedString(body.email).toLowerCase();
  if (!isEmail(email)) {
    errors.email = "Format email tidak valid.";
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) {
    errors.password = "Password minimal 8 karakter.";
  } else if (password.length > 72) {
    // bcrypt hanya membaca 72 byte pertama — tolak agar tidak ada "password tersembunyi".
    errors.password = "Password maksimal 72 karakter.";
  }

  const addressRaw = body.address;
  const address = addressRaw === undefined || addressRaw === null ? null : asTrimmedString(addressRaw);
  if (address !== null && address.length > 255) {
    errors.address = "Alamat maksimal 255 karakter.";
  }

  // Role: hanya BUYER/SELLER. Nilai lain (termasuk ADMIN) jatuh ke BUYER —
  // admin hanya bisa dibuat lewat seed/database.
  const role: "BUYER" | "SELLER" = asTrimmedString(body.role).toUpperCase() === "SELLER" ? "SELLER" : "BUYER";

  const storeNameRaw = body.storeName;
  let storeName =
    storeNameRaw === undefined || storeNameRaw === null ? null : asTrimmedString(storeNameRaw);
  if (role === "SELLER") {
    if (!storeName) {
      storeName = ""; // diisi default oleh registerUser bila kosong
    } else if (storeName.length > 100) {
      errors.storeName = "Nama toko maksimal 100 karakter.";
    }
  } else {
    storeName = null;
  }

  return { name, email, password, address: address || null, role, storeName, errors };
}

/** Validasi field login. */
export function validateLogin(body: Record<string, unknown>): {
  email: string;
  password: string;
  errors: Record<string, string>,
} {
  const errors: Record<string, string> = {};
  const email = asTrimmedString(body.email).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!email) errors.email = "Email wajib diisi.";
  if (!password) errors.password = "Password wajib diisi.";
  return { email, password, errors };
}

export type ProductInput = {
  name?: string;
  description?: string | null;
  price?: number;
  stock?: number;
  image?: string | null;
  categoryId?: string;
  status?: "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN";
  errors: Record<string, string>;
};

/**
 * Validasi input produk (tambah/ubah oleh penjual).
 * `partial: true` → hanya field yang dikirim divalidasi (untuk PATCH).
 * Field yang tidak dikirim (undefined) dilewatkan apa adanya.
 */
export function validateProductInput(
  body: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): ProductInput {
  const partial = opts.partial === true;
  const errors: Record<string, string> = {};
  const out: ProductInput = { errors };

  if (!partial || body.name !== undefined) {
    const name = asTrimmedString(body.name);
    if (name.length < 3 || name.length > 150) {
      errors.name = "Nama produk harus 3–150 karakter.";
    } else {
      out.name = name;
    }
  }

  if (!partial || body.description !== undefined) {
    const raw = body.description;
    const desc = raw === null || raw === undefined || raw === "" ? null : asTrimmedString(raw);
    if (desc !== null && desc.length > 2000) {
      errors.description = "Deskripsi maksimal 2000 karakter.";
    } else {
      out.description = desc;
    }
  }

  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000_000) {
      errors.price = "Harga harus angka 0–1.000.000.000.";
    } else if (!Number.isInteger(Math.round(price * 100))) {
      errors.price = "Harga tidak valid.";
    } else {
      out.price = Math.round(price); // rupiah tanpa desimal
    }
  }

  if (!partial || body.stock !== undefined) {
    const stock = Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
      errors.stock = "Stok harus bilangan bulat 0–1.000.000.";
    } else {
      out.stock = stock;
    }
  }

  if (!partial || body.image !== undefined) {
    const raw = body.image;
    const image = raw === null || raw === undefined || raw === "" ? null : asTrimmedString(raw);
    if (image !== null) {
      if (image.length > 500) {
        errors.image = "URL gambar maksimal 500 karakter.";
      } else if (!/^https?:\/\//i.test(image)) {
        errors.image = "URL gambar harus diawali http:// atau https://.";
      } else {
        out.image = image;
      }
    } else {
      out.image = null;
    }
  }

  if (!partial || body.categoryId !== undefined) {
    const categoryId = asTrimmedString(body.categoryId);
    if (!categoryId) {
      errors.categoryId = "Kategori wajib dipilih.";
    } else {
      out.categoryId = categoryId;
    }
  }

  if (body.status !== undefined) {
    const status = asTrimmedString(body.status).toUpperCase();
    if (status === "AVAILABLE" || status === "OUT_OF_STOCK" || status === "HIDDEN") {
      out.status = status;
    } else {
      errors.status = "Status tidak valid.";
    }
  }

  return out;
}

/** Validasi nama/alamat toko (dipakai endpoint kelola toko penjual). */
export function validateStoreInput(body: Record<string, unknown>): {
  storeName?: string;
  description?: string | null;
  location?: string | null;
  image?: string | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const out: { storeName?: string; description?: string | null; location?: string | null; image?: string | null; errors: Record<string, string> } = { errors };

  if (body.storeName !== undefined) {
    const storeName = asTrimmedString(body.storeName);
    if (storeName.length < 2 || storeName.length > 100) {
      errors.storeName = "Nama toko harus 2–100 karakter.";
    } else {
      out.storeName = storeName;
    }
  }

  if (body.description !== undefined) {
    const raw = body.description;
    const desc = raw === null || raw === "" ? null : asTrimmedString(raw);
    if (desc !== null && desc.length > 1000) {
      errors.description = "Deskripsi maksimal 1000 karakter.";
    } else {
      out.description = desc;
    }
  }

  if (body.location !== undefined) {
    const raw = body.location;
    const loc = raw === null || raw === "" ? null : asTrimmedString(raw);
    if (loc !== null && loc.length > 255) {
      errors.location = "Lokasi maksimal 255 karakter.";
    } else {
      out.location = loc;
    }
  }

  if (body.image !== undefined) {
    const raw = body.image;
    const image = raw === null || raw === "" ? null : asTrimmedString(raw);
    if (image !== null) {
      if (image.length > 500) {
        errors.image = "URL gambar maksimal 500 karakter.";
      } else if (!/^https?:\/\//i.test(image)) {
        errors.image = "URL gambar harus diawali http:// atau https://.";
      } else {
        out.image = image;
      }
    } else {
      out.image = null;
    }
  }

  return out;
}

/**
 * Tolak permintaan mutasi lintas-origin (pertahanan tambahan selain SameSite=Lax).
 * Origin dikirim browser untuk POST lintas situs; request tanpa Origin
 * (curl, Same-Origin GET) diperbolehkan.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) {
    throw new ApiError(403, "Origin tidak dikenal.");
  }

  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      throw new ApiError(403, "Permintaan lintas origin ditolak.");
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(403, "Origin tidak valid.");
  }
}
