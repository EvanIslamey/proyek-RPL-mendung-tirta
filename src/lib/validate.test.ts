import { describe, expect, it } from "vitest";
import {
  ApiError,
  asTrimmedString,
  assertSameOrigin,
  validateProductInput,
  validateStoreInput,
} from "@/lib/validate";

describe("ApiError", () => {
  it("menyimpan status, pesan, dan field errors", () => {
    const e = new ApiError(400, "Salah", { name: "wajib" });
    expect(e.status).toBe(400);
    expect(e.message).toBe("Salah");
    expect(e.fields).toEqual({ name: "wajib" });
    expect(e).toBeInstanceOf(Error);
  });
});

describe("asTrimmedString", () => {
  it("trim string; non-string (number/dst) ditolak jadi string kosong", () => {
    expect(asTrimmedString("  halo  ")).toBe("halo");
    expect(asTrimmedString(null)).toBe("");
    expect(asTrimmedString(123)).toBe("");
    expect(asTrimmedString(undefined)).toBe("");
    expect(asTrimmedString({ a: 1 })).toBe("");
  });
});

describe("validateProductInput (full)", () => {
  const valid = {
    name: "Ikan Segar",
    price: 10000,
    stock: 3,
    categoryId: "cat-1",
    description: null,
    image: null,
  };

  it("input valid tidak menghasilkan error", () => {
    const out = validateProductInput(valid);
    expect(out.errors).toEqual({});
    expect(out.name).toBe("Ikan Segar");
    expect(out.price).toBe(10000);
    expect(out.stock).toBe(3);
    expect(out.categoryId).toBe("cat-1");
  });

  it("menolak nama terlalu pendek, harga negatif, stok non-bulat", () => {
    const out = validateProductInput({
      ...valid,
      name: "X",
      price: -5,
      stock: 1.5,
    });
    expect(out.errors.name).toBeTruthy();
    expect(out.errors.price).toBeTruthy();
    expect(out.errors.stock).toBeTruthy();
  });

  it("menolak kategori kosong & status tak dikenal", () => {
    const out = validateProductInput({ ...valid, categoryId: "", status: "DIJUAL" });
    expect(out.errors.categoryId).toBeTruthy();
    expect(out.errors.status).toBeTruthy();
  });

  it("hanya memvalidasi field yang dikirim saat partial (PATCH)", () => {
    const out = validateProductInput({ price: 20000 }, { partial: true });
    expect(out.errors).toEqual({});
    expect(out.price).toBe(20000);
    expect(out.name).toBeUndefined();
  });
});

describe("validateStoreInput", () => {
  it("menerima input valid", () => {
    const out = validateStoreInput({ storeName: "Toko Baru", location: "Cilacap" });
    expect(out.errors).toEqual({});
    expect(out.storeName).toBe("Toko Baru");
  });

  it("menolak nama toko < 2 karakter", () => {
    const out = validateStoreInput({ storeName: "T" });
    expect(out.errors.storeName).toBeTruthy();
  });

  it("field tak dikirim tidak divalidasi (partial alami)", () => {
    const out = validateStoreInput({});
    expect(out.errors).toEqual({});
  });
});

describe("assertSameOrigin", () => {
  function req(origin?: string): Request {
    return new Request("http://localhost:3000/api/x", {
      method: "POST",
      headers: origin ? { origin, host: "localhost:3000" } : { host: "localhost:3000" },
    });
  }

  it("request tanpa Origin diizinkan (curl / same-origin GET)", () => {
    expect(() => assertSameOrigin(req(undefined))).not.toThrow();
  });

  it("Origin yang sama diizinkan", () => {
    expect(() => assertSameOrigin(req("http://localhost:3000"))).not.toThrow();
  });

  it("Origin asing ditolak 403", () => {
    try {
      assertSameOrigin(req("http://evil.example"));
      expect.unreachable("seharusnya melempar");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
    }
  });
});
