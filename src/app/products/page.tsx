"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SiteNav } from "@/components/layout/SiteNav";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { ProductCard } from "@/components/product/ProductCard";
import type { CategoryListItem, ProductListItem } from "@/lib/catalog";
import "./products.css";

type ListState = {
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type SortOption = "terbaru" | "harga-asc" | "harga-desc" | "rating" | "nama";

const SORT_LABELS: Record<SortOption, string> = {
  terbaru: "Terbaru",
  "harga-asc": "Harga terendah",
  "harga-desc": "Harga tertinggi",
  rating: "Rating tertinggi",
  nama: "Nama A–Z",
};

function ProductsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Form state (dikontrol user, disinkronkan ke URL saat diterapkan).
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [kategori, setKategori] = useState(searchParams.get("kategori") ?? "");
  const [minHarga, setMinHarga] = useState(searchParams.get("minHarga") ?? "");
  const [maxHarga, setMaxHarga] = useState(searchParams.get("maxHarga") ?? "");
  const [tersedia, setTersedia] = useState(searchParams.get("tersedia") === "1");
  const [sort, setSort] = useState<SortOption>((searchParams.get("sort") as SortOption) || "terbaru");

  const [data, setData] = useState<ListState | null>(null);
  const [categories, setCategories] = useState<CategoryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Ambil daftar kategori sekali (untuk dropdown filter).
  useEffect(() => {
    let alive = true;
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("categories failed"))))
      .then((d: { categories?: CategoryListItem[] }) => {
        if (alive) setCategories(d.categories ?? []);
      })
      .catch(() => {
        /* filter kategori opsional — biarkan kosong */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Sinkronkan form dengan URL (mis. tombol back/forward atau pill kategori).
  // Dijadwalkan sebagai microtask agar tidak memicu cascading render sinkron
  // di dalam effect (aturan react-hooks/set-state-in-effect).
  useEffect(() => {
    const q = searchParams.get("q") ?? "";
    const kat = searchParams.get("kategori") ?? "";
    const min = searchParams.get("minHarga") ?? "";
    const max = searchParams.get("maxHarga") ?? "";
    const avail = searchParams.get("tersedia") === "1";
    const s = searchParams.get("sort");
    const sortValue = (s && s in SORT_LABELS ? s : "terbaru") as SortOption;
    Promise.resolve().then(() => {
      setSearch(q);
      setKategori(kat);
      setMinHarga(min);
      setMaxHarga(max);
      setTersedia(avail);
      setSort(sortValue);
    });
  }, [searchParams]);

  // Ambil produk setiap kali query string / retry berubah.
  const query = searchParams.toString();
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch(`/api/products?${query}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ListState) => setData(d))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError("Gagal memuat produk. Periksa koneksi Anda lalu coba lagi.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [query, retryToken]);

  // Bangun query string dari form dan navigasikan (state jadi sumber URL).
  const applyFilters = useCallback(
    (overrides: Partial<Record<string, string | boolean>> = {}, page = 1) => {
      const get = (key: string): string | undefined => {
        if (key in overrides) {
          const v = overrides[key];
          return typeof v === "string" ? v : undefined;
        }
        switch (key) {
          case "q":
            return search;
          case "kategori":
            return kategori;
          case "minHarga":
            return minHarga;
          case "maxHarga":
            return maxHarga;
          case "tersedia":
            return tersedia ? "1" : "";
          case "sort":
            return sort === "terbaru" ? "" : sort;
          default:
            return undefined;
        }
      };

      const params = new URLSearchParams();
      const q = (get("q") ?? "").trim();
      const kat = get("kategori") ?? "";
      const min = (get("minHarga") ?? "").trim();
      const max = (get("maxHarga") ?? "").trim();
      const avail = get("tersedia");
      const s = get("sort") ?? "";

      if (q) params.set("q", q);
      if (kat) params.set("kategori", kat);
      if (min) params.set("minHarga", min);
      if (max) params.set("maxHarga", max);
      if (avail === "1") params.set("tersedia", "1");
      if (s) params.set("sort", s);
      if (page > 1) params.set("page", String(page));

      const qs = params.toString();
      // Hanya tampilkan state "memuat" bila URL benar-benar berubah — kalau
      // query sama, effect fetch tidak jalan lagi dan loading akan nyangkut.
      if (qs !== query) {
        setLoading(true);
        setError(null);
      }
      router.push(qs ? `/products?${qs}` : "/products");
    },
    [search, kategori, minHarga, maxHarga, tersedia, sort, router, query],
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    applyFilters();
  }

  function resetFilters() {
    setSearch("");
    setKategori("");
    setMinHarga("");
    setMaxHarga("");
    setTersedia(false);
    setSort("terbaru");
    if (query) {
      setLoading(true);
      setError(null);
    }
    router.push("/products");
  }

  const page = data?.page ?? 1;
  const totalPages = data?.totalPages ?? 1;
  const hasActiveFilter =
    Boolean(search || kategori || minHarga || maxHarga || tersedia) || sort !== "terbaru";

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container market-main">
        <div className="market-hero">
          <div className="market-hero-copy">
            <span className="section-eyebrow">Katalog Mendung Tirta</span>
            <h1>Hasil laut segar &amp; perlengkapan pancing pilihan</h1>
            <p className="market-subtitle">
              Belanja langsung dari nelayan dan toko lokal terpercaya. Foto asli, stok
              diperbarui real-time, harga transparan.
            </p>
          </div>
          <div className="market-hero-stats" aria-hidden="true">
            <div>
              <strong>{data ? data.total : "—"}</strong>
              <span>produk aktif</span>
            </div>
            <div>
              <strong>{categories.length || "—"}</strong>
              <span>kategori</span>
            </div>
            <div>
              <strong>100%</strong>
              <span>penjual lokal</span>
            </div>
          </div>
        </div>

        <div className="category-pills" role="group" aria-label="Filter kategori cepat">
          <button
            type="button"
            className={`category-pill${kategori === "" ? " is-active" : ""}`}
            onClick={() => applyFilters({ kategori: "" })}
          >
            Semua
            <span>{data?.total ?? "—"}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`category-pill${kategori.toLowerCase() === c.name.toLowerCase() ? " is-active" : ""}`}
              onClick={() => applyFilters({ kategori: c.name })}
            >
              {c.name}
              <span>{c.productCount}</span>
            </button>
          ))}
        </div>

        <form className="market-filters" onSubmit={onSubmit} role="search">
          <div className="filter-search">
            <span className="filter-search-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.9" />
                <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </span>
            <input
              type="search"
              placeholder="Cari produk… (mis. joran, kerapu)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Cari produk"
            />
            <button type="submit" className="btn btn-primary">
              Cari
            </button>
          </div>

          <div className="filter-row">
            <label className="filter-field">
              <span>Kategori</span>
              <select value={kategori} onChange={(e) => applyFilters({ kategori: e.target.value })}>
                <option value="">Semua kategori</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name} ({c.productCount})
                  </option>
                ))}
              </select>
            </label>

            <label className="filter-field">
              <span>Harga min</span>
              <input
                type="number"
                min={0}
                placeholder="0"
                value={minHarga}
                onChange={(e) => setMinHarga(e.target.value)}
                onBlur={() => applyFilters()}
              />
            </label>

            <label className="filter-field">
              <span>Harga max</span>
              <input
                type="number"
                min={0}
                placeholder="∞"
                value={maxHarga}
                onChange={(e) => setMaxHarga(e.target.value)}
                onBlur={() => applyFilters()}
              />
            </label>

            <label className="filter-field">
              <span>Urutkan</span>
              <select value={sort} onChange={(e) => applyFilters({ sort: e.target.value })}>
                {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={tersedia}
                onChange={(e) => applyFilters({ tersedia: e.target.checked })}
              />
              Stok tersedia saja
            </label>

            {hasActiveFilter && (
              <button type="button" className="filter-reset" onClick={resetFilters}>
                Reset filter
              </button>
            )}
          </div>
        </form>

        {/* Loading state */}
        {loading && !data && (
          <div className="product-grid" aria-busy="true" aria-label="Memuat produk">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="product-skeleton" />
            ))}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="market-alert" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setLoading(true);
                setError(null);
                setRetryToken((t) => t + 1);
              }}
            >
              Coba lagi
            </button>
          </div>
        )}

        {/* Hasil */}
        {!error && data && data.items.length === 0 && (
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">
              🔍
            </div>
            <h2>Produk tidak ditemukan</h2>
            <p>Coba ubah kata kunci atau hapus filter yang aktif.</p>
            <button type="button" className="btn btn-primary" onClick={resetFilters}>
              Lihat semua produk
            </button>
          </div>
        )}

        {!error && data && data.items.length > 0 && (
          <>
            <p className="market-result-count" aria-live="polite">
              {loading ? "Memperbarui…" : `${data.total} produk ditemukan`}
            </p>
            <div className="product-grid">
              {data.items.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>

            {totalPages > 1 && (
              <nav className="pagination" aria-label="Navigasi halaman">
                <button
                  type="button"
                  className="btn pagination-btn"
                  disabled={page <= 1 || loading}
                  onClick={() => applyFilters({}, page - 1)}
                >
                  ← Sebelumnya
                </button>
                <span className="pagination-info">
                  Halaman {page} dari {totalPages}
                </span>
                <button
                  type="button"
                  className="btn pagination-btn"
                  disabled={page >= totalPages || loading}
                  onClick={() => applyFilters({}, page + 1)}
                >
                  Berikutnya →
                </button>
              </nav>
            )}
          </>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsContent />
    </Suspense>
  );
}
