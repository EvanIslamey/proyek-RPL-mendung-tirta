-- Index kolom panas untuk chatbot (non-destruktif, idempoten).
-- Dicocokkan dengan @@index di prisma/schema.prisma (nama default Prisma).
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");
CREATE INDEX IF NOT EXISTS "Store_isActive_idx" ON "Store"("isActive");
CREATE INDEX IF NOT EXISTS "Product_status_idx" ON "Product"("status");
CREATE INDEX IF NOT EXISTS "Product_price_idx" ON "Product"("price");
