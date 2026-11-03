import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FONNTE_DEFAULT_BASE,
  fonnteDeviceProfile,
  fonnteSendText,
  fonnteTarget,
  readFonnteStatus,
} from "./fonnte";

const TOKEN = "fmk_test_token_rahasia_123";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Response JSON palsu ala Fonnte. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fonnteTarget", () => {
  it("membuang '+' dan pemisah → digit internasional", () => {
    expect(fonnteTarget("+62812 3456-7890")).toBe("6281234567890");
    expect(fonnteTarget("+6281234567890")).toBe("6281234567890");
    expect(fonnteTarget("(+62) 812-3456-7890")).toBe("6281234567890");
  });

  it("menangani input kotor tanpa melempar", () => {
    expect(fonnteTarget("")).toBe("");
    expect(fonnteTarget("+++")).toBe("");
    expect(fonnteTarget("+62 812")).toBe("62812");
  });
});

describe("readFonnteStatus", () => {
  it("membaca 'status' huruf kecil", () => {
    expect(readFonnteStatus({ status: true })).toBe(true);
    expect(readFonnteStatus({ status: false })).toBe(false);
    expect(readFonnteStatus({ status: "true" })).toBe(true);
    expect(readFonnteStatus({ status: "false" })).toBe(false);
  });

  it("membaca 'Status' huruf besar (response gagal Fonnte)", () => {
    expect(readFonnteStatus({ Status: false, message: "token invalid" })).toBe(false);
    expect(readFonnteStatus({ Status: true })).toBe(true);
  });

  it("bila keduanya ada, 'status' menang dan 'false' TIDAK dianggap sukses", () => {
    expect(readFonnteStatus({ status: false, Status: true })).toBe(false);
  });

  it("tanpa field status → null (bukan sukses)", () => {
    expect(readFonnteStatus({ detail: "ok" })).toBeNull();
    expect(readFonnteStatus(null)).toBeNull();
    expect(readFonnteStatus("bukan objek")).toBeNull();
  });
});

describe("fonnteDeviceProfile", () => {
  it("sukses: POST {base}/device dengan Authorization TANPA Bearer", async () => {
    const spy = vi.fn(async () =>
      jsonRes({
        device: "6281234567890",
        device_status: "connect",
        name: "Toko Demo",
        quota: "88",
        package: "Reguler",
        expired: "18 November 2029",
        status: true,
      }),
    );
    vi.stubGlobal("fetch", spy);

    const r = await fonnteDeviceProfile({ baseUrl: "https://api.fonnte.com/", token: TOKEN });
    expect(r.ok).toBe(true);
    expect(r.data?.number).toBe("6281234567890");
    expect(r.data?.status).toBe("connect");
    expect(r.note).toContain("6281234567890");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.fonnte.com/device"); // slash akhir dibersihkan
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN); // token mentah — tanpa prefix
    expect(headers.Authorization).not.toMatch(/^Bearer/i);
  });

  it("token ditolak provider (status:false) → gagal jujur, alasan masuk note", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ status: false, reason: "token invalid" })),
    );
    const r = await fonnteDeviceProfile({ token: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("token invalid");
    expect(r.note).not.toContain(TOKEN);
  });

  it("perangkat terdaftar tapi disconnect → gagal jujur + saran hubungkan QR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ device: "6281234567890", device_status: "disconnect", status: true }),
      ),
    );
    const r = await fonnteDeviceProfile({ token: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("disconnect");
    expect(r.data?.number).toBe("6281234567890"); // info perangkat tetap tersedia
  });

  it("HTTP 200 tapi body bukan JSON → TIDAK dianggap sukses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>maintenance</html>", { status: 200 })),
    );
    const r = await fonnteDeviceProfile({ token: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("HTTP 200");
  });

  it("gagal jaringan → { ok:false }, tidak melempar, token tidak bocor", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`ECONNREFUSED https://api.fonnte.com (${TOKEN})`);
      }),
    );
    const r = await fonnteDeviceProfile({ token: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.note).not.toContain(TOKEN);
    expect(spy).not.toHaveBeenCalled();
  });

  it("token kosong → gagal tanpa memanggil jaringan", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await fonnteDeviceProfile({ token: "  " });
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("alasan provider yang mengecho token panjang → disamarkan, kata aman tetap terbaca", async () => {
    const LONG = "fmk_abc123def456ghi789jkl012mno345pqr";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ status: false, reason: `invalid token ${LONG}` })),
    );
    const r = await fonnteDeviceProfile({ token: LONG });
    expect(r.ok).toBe(false);
    expect(r.note).not.toContain(LONG);
    expect(r.note).toContain("invalid token");
  });
});

describe("fonnteSendText", () => {
  it("sukses: FormData berisi target/message/countryCode=0, header Authorization tanpa Bearer", async () => {
    const spy = vi.fn(async () =>
      jsonRes({ detail: "success! message in queue", status: true }),
    );
    vi.stubGlobal("fetch", spy);

    const r = await fonnteSendText({
      baseUrl: FONNTE_DEFAULT_BASE,
      token: TOKEN,
      targets: ["+6281234567890"],
      message: "Halo, pesanan #INV-1 dibuat.",
    });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("6281234567890");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.fonnte.com/send");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN);
    expect(headers.Authorization).not.toMatch(/^Bearer/i);
    expect(headers["Content-Type"]).toBeUndefined(); // multipart oleh runtime

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("target")).toBe("6281234567890");
    expect(form.get("message")).toBe("Halo, pesanan #INV-1 dibuat.");
    expect(form.get("countryCode")).toBe("0"); // nomor sudah internasional
    expect(form.get("preview")).toBe("false");
  });

  it("beberapa tujuan → SATU request dengan target dipisah koma", async () => {
    const spy = vi.fn(async () => jsonRes({ detail: "ok", status: true }));
    vi.stubGlobal("fetch", spy);
    await fonnteSendText({
      token: TOKEN,
      targets: ["+628111111111", "+628222222222"],
      message: "Info operasional.",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const form = (spy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((form.body as FormData).get("target")).toBe("628111111111,628222222222");
  });

  it("provider membalas status false (casing 'Status') → gagal, pesan TIDAK dianggap terkirim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ Status: false, message: "insufficient quota" })),
    );
    const r = await fonnteSendText({
      token: TOKEN,
      targets: ["+6281234567890"],
      message: "tes",
    });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("insufficient quota");
    expect(r.note).not.toContain(TOKEN);
  });

  it("target tidak valid menurut Fonnte → gagal jujur", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ status: false, reason: "target invalid" })),
    );
    const r = await fonnteSendText({ token: TOKEN, targets: ["+62811"], message: "tes" });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("target invalid");
  });

  it("gagal jaringan → { ok:false } tanpa melempar (notifikasi tidak boleh merusak alur)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    const r = await fonnteSendText({
      token: TOKEN,
      targets: ["+6281234567890"],
      message: "tes",
    });
    expect(r.ok).toBe(false);
    expect(typeof r.note).toBe("string");
  });

  it("tujuan/kosong → gagal tanpa memanggil jaringan", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await fonnteSendText({ token: TOKEN, targets: [], message: "x" })).ok).toBe(false);
    expect(
      (await fonnteSendText({ token: TOKEN, targets: ["+6281234567890"], message: "   " })).ok,
    ).toBe(false);
    expect(
      (await fonnteSendText({ token: "", targets: ["+6281234567890"], message: "x" })).ok,
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
