"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type CartItem = {
  productId: string;
  name: string;
  price: number; // snapshot harga saat ditambahkan (server hitung ulang saat checkout)
  storeName: string;
  quantity: number;
  stock: number; // stok saat ditambahkan (validasi ulang server saat checkout)
  image: string | null;
};

type CartContextValue = {
  items: CartItem[];
  totalCount: number;
  total: number;
  loading: boolean;
  addItem: (item: Omit<CartItem, "quantity">, quantity?: number) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
};

const STORAGE_KEY = "mt_cart_v1";
const CartContext = createContext<CartContextValue | null>(null);

function readStorage(): CartItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is CartItem =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as CartItem).productId === "string" &&
        typeof (i as CartItem).name === "string" &&
        typeof (i as CartItem).price === "number" &&
        typeof (i as CartItem).quantity === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Keranjang belanja di localStorage (MVP).
 * Harga/stok di sini hanya snapshot tampilan — checkout selalu divalidasi
 * dan dihitung ulang oleh server.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // localStorage baru boleh dibaca setelah mount, jadi jangan setState secara
    // sinkron dari body effect (render pertama di server harus tetap kosong
    // agar tidak hydration mismatch). Tunda satu microtask + beri flag batal.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setItems(readStorage());
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* storage penuh/di-block — keranjang tetap hidup di memori */
    }
  }, [items, loading]);

  const addItem = useCallback((item: Omit<CartItem, "quantity">, quantity = 1) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.productId === item.productId);
      if (existing) {
        const nextQty = Math.min(existing.quantity + quantity, item.stock || quantity);
        return prev.map((i) =>
          i.productId === item.productId ? { ...i, quantity: Math.max(1, nextQty) } : i,
        );
      }
      return [...prev, { ...item, quantity: Math.max(1, quantity) }];
    });
  }, []);

  const updateQuantity = useCallback((productId: string, quantity: number) => {
    setItems((prev) =>
      prev
        .map((i) =>
          i.productId === productId
            ? { ...i, quantity: Math.min(Math.max(1, quantity), i.stock || 999) }
            : i,
        )
        .filter((i) => i.quantity > 0),
    );
  }, []);

  const removeItem = useCallback((productId: string) => {
    setItems((prev) => prev.filter((i) => i.productId !== productId));
  }, []);

  const clearCart = useCallback(() => setItems([]), []);

  const value = useMemo<CartContextValue>(() => {
    const totalCount = items.reduce((sum, i) => sum + i.quantity, 0);
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return { items, totalCount, total, loading, addItem, updateQuantity, removeItem, clearCart };
  }, [items, loading, addItem, updateQuantity, removeItem, clearCart]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart harus dipakai di dalam CartProvider");
  return ctx;
}
