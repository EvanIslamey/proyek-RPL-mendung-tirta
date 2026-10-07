import type { Metadata } from "next";
import { CartProvider } from "@/components/cart/CartContext";
import { ToastProvider } from "@/components/ui/Toast";
import { AIWidget } from "@/components/ai/AIWidget";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mendung Tirta | Marketplace Nelayan & Pemancing",
  description: "Platform jual beli hasil panen ikan dan perlengkapan memancing lokal yang terpercaya.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>
        <ToastProvider>
          <CartProvider>{children}</CartProvider>
        </ToastProvider>
        <AIWidget />
      </body>
    </html>
  );
}
