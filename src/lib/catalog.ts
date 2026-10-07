import { Prisma } from "../../prisma/generated/client";
import { prisma } from "./prisma";

/**
 * Lib katalog produk: list (search/filter/sort/pagination) + detail.
 *
 * List memakai query SQL terparameterisasi (Prisma.sql) karena Prisma query
 * builder tidak mendukung ORDER BY rata-rata rating relasi. Semua nilai dari
 * user di-bind sebagai parameter — tidak ada interpolasi string mentah.
 */

export type ProductListParams = {
  q?: string;
  kategori?: string;
  minHarga?: number;
  maxHarga?: number;
  tersedia?: boolean;
  sort?: string;
  page?: number;
  limit?: number;
};

export type ProductListItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  image: string | null;
  status: string;
  createdAt: string;
  category: { id: string; name: string };
  store: { id: string; storeName: string; location: string | null };
  rating: { average: number; count: number };
};

export type ProductListResult = {
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type CategoryListItem = {
  id: string;
  name: string;
  description: string | null;
  productCount: number;
};

export type ProductDetail = Omit<ProductListItem, "category" | "store"> & {
  category: { id: string; name: string; description: string | null };
  store: { id: string; storeName: string; description: string | null; location: string | null; image: string | null };
  reviews: {
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    buyerName: string;
  }[];
};

/** Whitelist ORDER BY — hanya nilai statis dari peta ini yang masuk ke SQL. */
const SORT_MAP: Record<string, string> = {
  terbaru: `p."createdAt" DESC`,
  "harga-asc": `p.price ASC`,
  "harga-desc": `p.price DESC`,
  rating: `rating_average DESC, rating_count DESC, p."createdAt" DESC`,
  nama: `p.name ASC`,
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function parseNonNegativeNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseBoundedInt(value: string | null, def: number, min: number, max: number): number {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Parse query string katalog dengan validasi/batasan yang aman. */
export function parseProductListParams(sp: URLSearchParams): ProductListParams {
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  const kategori = (sp.get("kategori") ?? "").trim().slice(0, 100);
  let minHarga = parseNonNegativeNumber(sp.get("minHarga"));
  let maxHarga = parseNonNegativeNumber(sp.get("maxHarga"));
  if (minHarga !== undefined && maxHarga !== undefined && minHarga > maxHarga) {
    [minHarga, maxHarga] = [maxHarga, minHarga];
  }
  return {
    q: q || undefined,
    kategori: kategori || undefined,
    minHarga,
    maxHarga,
    tersedia: sp.get("tersedia") === "1",
    sort: sp.get("sort") ?? undefined,
    page: parseBoundedInt(sp.get("page"), 1, 1, 10_000),
    limit: parseBoundedInt(sp.get("limit"), 12, 1, 48),
  };
}

type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  price: string | number;
  stock: number;
  image: string | null;
  status: string;
  createdAt: Date;
  category_id: string;
  category_name: string;
  store_id: string;
  store_name: string;
  store_location: string | null;
  rating_average: string | number;
  rating_count: number;
};

export async function listProducts(params: ProductListParams): Promise<ProductListResult> {
  const page = params.page ?? 1;
  const limit = params.limit ?? 12;
  const offset = (page - 1) * limit;
  const orderBy = SORT_MAP[params.sort ?? "terbaru"] ?? SORT_MAP.terbaru;

  // Produk publik: tidak disembunyikan dan tokonya aktif.
  let where = Prisma.sql`WHERE p.status <> 'HIDDEN' AND s."isActive" = true`;

  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    where = Prisma.sql`${where} AND (p.name ILIKE ${pattern} OR p.description ILIKE ${pattern})`;
  }
  if (params.kategori) {
    // Cocokkan berdasarkan id kategori ATAU nama (case-insensitive).
    where = Prisma.sql`${where} AND (c.id = ${params.kategori} OR c.name ILIKE ${params.kategori})`;
  }
  if (params.minHarga !== undefined) {
    where = Prisma.sql`${where} AND p.price >= ${params.minHarga}`;
  }
  if (params.maxHarga !== undefined) {
    where = Prisma.sql`${where} AND p.price <= ${params.maxHarga}`;
  }
  if (params.tersedia) {
    where = Prisma.sql`${where} AND p.stock > 0`;
  }

  const joins = Prisma.sql`
    FROM "Product" p
    JOIN "Category" c ON c.id = p."categoryId"
    JOIN "Store" s ON s.id = p."storeId"
  `;

  const countRows = await prisma.$queryRaw<{ total: number }[]>(
    Prisma.sql`SELECT COUNT(*)::int AS total ${joins} ${where}`,
  );
  const total = countRows[0]?.total ?? 0;

  const rows =
    total === 0
      ? []
      : await prisma.$queryRaw<ProductRow[]>(Prisma.sql`
          SELECT
            p.id, p.name, p.description, p.price, p.stock, p.image, p.status, p."createdAt",
            c.id AS category_id, c.name AS category_name,
            s.id AS store_id, s."storeName" AS store_name, s.location AS store_location,
            COALESCE(r.rating_avg, 0)::float AS rating_average,
            COALESCE(r.rating_cnt, 0)::int AS rating_count
          ${joins}
          LEFT JOIN (
            SELECT "productId", AVG(rating) AS rating_avg, COUNT(*) AS rating_cnt
            FROM "Review"
            GROUP BY "productId"
          ) r ON r."productId" = p.id
          ${where}
          ORDER BY ${Prisma.raw(orderBy)}, p.id ASC
          LIMIT ${limit} OFFSET ${offset}
        `);

  return {
    items: rows.map(serializeListItem),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

function serializeListItem(row: ProductRow): ProductListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    stock: row.stock,
    image: row.image,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    category: { id: row.category_id, name: row.category_name },
    store: { id: row.store_id, storeName: row.store_name, location: row.store_location },
    rating: { average: Math.round(Number(row.rating_average) * 10) / 10, count: row.rating_count },
  };
}

/**
 * Produk serupa untuk rekomendasi di halaman detail: satu kategori dengan
 * produk saat ini (kecuali dirinya sendiri), yang sedang dinilai tinggi/
 * tersedia lebih dulu. Membatasi 4 item.
 */
export async function getRelatedProducts(
  productId: string,
  categoryId: string,
): Promise<ProductListItem[]> {
  const rows = await prisma.$queryRaw<ProductRow[]>(Prisma.sql`
    SELECT
      p.id, p.name, p.description, p.price, p.stock, p.image, p.status, p."createdAt",
      c.id AS category_id, c.name AS category_name,
      s.id AS store_id, s."storeName" AS store_name, s.location AS store_location,
      COALESCE(r.rating_avg, 0)::float AS rating_average,
      COALESCE(r.rating_cnt, 0)::int AS rating_count
    FROM "Product" p
    JOIN "Category" c ON c.id = p."categoryId"
    JOIN "Store" s ON s.id = p."storeId"
    LEFT JOIN (
      SELECT "productId", AVG(rating) AS rating_avg, COUNT(*) AS rating_cnt
      FROM "Review"
      GROUP BY "productId"
    ) r ON r."productId" = p.id
    WHERE p.status <> 'HIDDEN'
      AND s."isActive" = true
      AND p."categoryId" = ${categoryId}
      AND p.id <> ${productId}
    ORDER BY (p.stock = 0), COALESCE(r.rating_avg, 0) DESC, p."createdAt" DESC
    LIMIT 4
  `);
  return rows.map(serializeListItem);
}

/**
 * Detail produk untuk publik. Mengembalikan null bila tidak ada,
 * statusnya HIDDEN, atau tokonya dinonaktifkan.
 */
export async function getProductDetail(id: string): Promise<ProductDetail | null> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      category: true,
      store: true,
      reviews: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          buyer: { select: { name: true } },
        },
      },
    },
  });

  if (!product || product.status === "HIDDEN" || !product.store.isActive) return null;

  const aggregate = await prisma.review.aggregate({
    where: { productId: id },
    _avg: { rating: true },
    _count: true,
  });

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: Number(product.price),
    stock: product.stock,
    image: product.image,
    status: product.status,
    createdAt: product.createdAt.toISOString(),
    category: {
      id: product.category.id,
      name: product.category.name,
      description: product.category.description,
    },
    store: {
      id: product.store.id,
      storeName: product.store.storeName,
      description: product.store.description,
      location: product.store.location,
      image: product.store.image,
    },
    rating: {
      average: Math.round((aggregate._avg.rating ?? 0) * 10) / 10,
      count: aggregate._count,
    },
    reviews: product.reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
      buyerName: r.buyer.name,
    })),
  };
}

/** Daftar kategori + jumlah produk aktif (untuk filter & navigasi). */
export async function listCategories(): Promise<CategoryListItem[]> {
  const categories = await prisma.category.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: {
        select: {
          products: {
            where: { status: { not: "HIDDEN" }, store: { isActive: true } },
          },
        },
      },
    },
  });
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    productCount: c._count.products,
  }));
}
