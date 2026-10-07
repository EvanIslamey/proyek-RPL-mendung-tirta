import { describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS } from "@/lib/orders";

const ALL_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SHIPPED",
  "READY_FOR_PICKUP",
  "COMPLETED",
  "CANCELLED",
];

describe("ORDER_TRANSITIONS", () => {
  it("mencakup semua status enum OrderStatus", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("status terminal (COMPLETED/CANCELLED) tidak punya transisi keluar", () => {
    expect(ORDER_TRANSITIONS.COMPLETED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("semua target transisi adalah status yang valid", () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const t of targets) {
        expect(ALL_STATUSES).toContain(t);
      }
    }
  });

  it("tidak ada transisi ke diri sendiri", () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });

  it("alur pembayaran logis: PENDING -> PROCESSING -> ... -> COMPLETED", () => {
    expect(ORDER_TRANSITIONS.PENDING).toContain("PROCESSING");
    expect(ORDER_TRANSITIONS.PROCESSING).toContain("SHIPPED");
    expect(ORDER_TRANSITIONS.SHIPPED).toContain("COMPLETED");
    expect(ORDER_TRANSITIONS.READY_FOR_PICKUP).toContain("COMPLETED");
  });

  it("semua status non-terminal masih bisa dibatalkan", () => {
    for (const s of ["PENDING", "PROCESSING", "SHIPPED", "READY_FOR_PICKUP"]) {
      expect(ORDER_TRANSITIONS[s]).toContain("CANCELLED");
    }
  });
});
