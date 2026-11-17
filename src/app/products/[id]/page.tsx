import { notFound } from "next/navigation";
import Link from "next/link";
import { SiteNav } from "@/components/layout/SiteNav";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { ProductCard } from "@/components/product/ProductCard";
import { ProductImage } from "@/components/product/ProductImage";
import { PurchasePanel } from "@/components/product/PurchasePanel";
import { formatRupiah } from "@/lib/format";
import { productUnit } from "@/lib/product-format";
import { getProductDetail, getRelatedProducts } from "@/lib/catalog";
import "../products.css";
import "./detail.css";

export const dynamic = "force-dynamic";

function stars(rating: number): string {
  const full = Math.round(rating);
  return "★".repeat(full) + "☆".repeat(5 - full);
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await getProductDetail(id);
  if (!product) notFound();

  const related = await getRelatedProducts(product.id, product.category.id);
  const habis = product.stock <= 0 || product.status === "OUT_OF_STOCK";
  const unit = productUnit(product.name);

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container detail-main">
        <nav className="detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/products">Katalog</Link>
          <span aria-hidden="true"> / </span>
          <Link href={`/products?kategori=${encodeURIComponent(product.category.name)}`}>
            {product.category.name}
          </Link>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">{product.name}</span>
        </nav>

        <div className="detail-grid">
          <div className="detail-gallery">
            <div className="detail-media">
              <ProductImage
                src={product.image}
                alt={`Foto ${product.name}`}
                category={product.category.name}
                priority
                className="detail-media-img"
              />
              {habis && <span className="detail-media-badge">Stok habis</span>}
            </div>
            <div className="detail-media-meta">
              <span>
                <strong>{product.rating.count > 0 ? product.rating.average.toFixed(1) : "Baru"}</strong>
                <small>rating pembeli</small>
              </span>
              <span>
                <strong>{product.reviews.length}</strong>
                <small>ulasan</small>
              </span>
              <span>
                <strong>{product.stock}</strong>
                <small>stok tersedia</small>
              </span>
            </div>
          </div>

          <div className="detail-info">
            <span className="detail-category">{product.category.name}</span>
            <h1>{product.name}</h1>

            <div className="detail-rating">
              <span className="detail-stars" aria-hidden="true">
                {stars(product.rating.average)}
              </span>
              <span>
                {product.rating.average > 0 ? product.rating.average.toFixed(1) : "Belum ada rating"}
                {product.rating.count > 0 && ` • ${product.rating.count} ulasan`}
              </span>
            </div>

            <div className="detail-price-row">
              <p className="detail-price">{formatRupiah(product.price)}</p>
              <span className="detail-unit">{unit}</span>
            </div>

            <dl className="detail-facts">
              <div>
                <dt>Stok</dt>
                <dd>
                  {habis ? (
                    <span className="detail-stock-out">Habis</span>
                  ) : (
                    `${product.stock} tersedia`
                  )}
                </dd>
              </div>
              <div>
                <dt>Satuan</dt>
                <dd>{unit}</dd>
              </div>
              <div>
                <dt>Penjual</dt>
                <dd>{product.store.storeName}</dd>
              </div>
              {product.store.location && (
                <div>
                  <dt>Lokasi</dt>
                  <dd>{product.store.location}</dd>
                </div>
              )}
            </dl>

            <PurchasePanel
              product={{
                id: product.id,
                name: product.name,
                price: product.price,
                storeName: product.store.storeName,
                stock: product.stock,
                image: product.image,
              }}
              disabled={habis}
            />

            {product.description && (
              <section className="detail-description">
                <h2>Deskripsi produk</h2>
                <p>{product.description}</p>
              </section>
            )}

            <aside className="detail-seller" aria-label="Informasi penjual">
              <div className="detail-seller-avatar" aria-hidden="true">
                {product.store.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- aset statis lokal
                  <img src={product.store.image} alt="" loading="lazy" />
                ) : (
                  product.store.storeName.charAt(0)
                )}
              </div>
              <div className="detail-seller-body">
                <span>Toko penjual</span>
                <strong>{product.store.storeName}</strong>
                {product.store.description && <p>{product.store.description}</p>}
                {product.store.location && (
                  <small>
                    <span aria-hidden="true">📍</span> {product.store.location}
                  </small>
                )}
              </div>
            </aside>
          </div>
        </div>

        <section className="detail-reviews" aria-labelledby="reviews-heading">
          <div className="detail-section-head">
            <div>
              <span className="section-eyebrow">Ulasan pembeli</span>
              <h2 id="reviews-heading">Apa kata mereka ({product.reviews.length})</h2>
            </div>
            {product.rating.average > 0 && (
              <span className="detail-rating-badge">
                <span aria-hidden="true">★</span> {product.rating.average.toFixed(1)} / 5
              </span>
            )}
          </div>

          {product.reviews.length === 0 ? (
            <div className="market-empty">
              <div className="market-empty-icon" aria-hidden="true">
                💬
              </div>
              <h3>Belum ada ulasan</h3>
              <p>Jadilah yang pertama memberikan ulasan setelah membeli produk ini.</p>
            </div>
          ) : (
            <ul className="review-list">
              {product.reviews.map((review) => (
                <li key={review.id} className="review-item">
                  <div className="review-head">
                    <strong>{review.buyerName}</strong>
                    <span className="review-stars" aria-label={`Rating ${review.rating} dari 5`}>
                      {"★".repeat(review.rating)}
                      {"☆".repeat(5 - review.rating)}
                    </span>
                    <time dateTime={review.createdAt}>
                      {new Date(review.createdAt).toLocaleDateString("id-ID", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    </time>
                  </div>
                  {review.comment && <p className="review-comment">{review.comment}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {related.length > 0 && (
          <section className="detail-related" aria-labelledby="related-heading">
            <div className="detail-section-head">
              <div>
                <span className="section-eyebrow">Rekomendasi</span>
                <h2 id="related-heading">Produk serupa</h2>
              </div>
              <Link
                href={`/products?kategori=${encodeURIComponent(product.category.name)}`}
                className="section-link"
              >
                Lihat kategori <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className="product-grid">
              {related.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
