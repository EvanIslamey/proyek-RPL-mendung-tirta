import { notFound } from "next/navigation";
import Link from "next/link";
import { SiteNav } from "@/components/layout/SiteNav";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductCard } from "@/components/product/ProductCard";
import { formatRupiah } from "@/lib/format";
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

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container detail-main">
        <nav className="detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/products">Katalog</Link>
          <span aria-hidden="true"> / </span>
          <span>{product.category.name}</span>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">{product.name}</span>
        </nav>

        <div className="detail-grid">
          <div className="detail-media" aria-hidden="true">
            <span className="detail-emoji">
              {product.category.name.toLowerCase().includes("laut") ? "🐟" : "🎣"}
            </span>
          </div>

          <div className="detail-info">
            <span className="detail-category">{product.category.name}</span>
            <h1>{product.name}</h1>

            <div className="detail-rating">
              <span className="detail-stars" aria-hidden="true">
                {stars(product.rating.average)}
              </span>
              <span>
                {product.rating.average > 0 ? product.rating.average : "Belum ada rating"}
                {product.rating.count > 0 && ` • ${product.rating.count} ulasan`}
              </span>
            </div>

            <p className="detail-price">{formatRupiah(product.price)}</p>

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
                <dt>Penjual</dt>
                <dd>{product.store.storeName}</dd>
              </div>
              {product.store.location && (
                <div>
                  <dt>Lokasi</dt>
                  <dd>📍 {product.store.location}</dd>
                </div>
              )}
            </dl>

            <div className="detail-actions">
              <AddToCartButton
                product={{
                  productId: product.id,
                  name: product.name,
                  price: product.price,
                  storeName: product.store.storeName,
                  stock: product.stock,
                  image: product.image,
                }}
                disabled={habis}
              />
            </div>

            {product.description && (
              <section className="detail-description">
                <h2>Deskripsi</h2>
                <p>{product.description}</p>
              </section>
            )}
          </div>
        </div>

        <section className="detail-reviews" aria-labelledby="reviews-heading">
          <h2 id="reviews-heading">Ulasan Pembeli ({product.reviews.length})</h2>

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
            <h2 id="related-heading">Produk Serupa</h2>
            <div className="product-grid">
              {related.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="container">
          <p>&copy; {new Date().getFullYear()} Mendung Tirta. Hak cipta dilindungi.</p>
        </div>
      </footer>
    </div>
  );
}
