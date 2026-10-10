import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPagesClientForTests, getPages, getPagesSync, invalidatePages, seedPages } from "./pagesClient";

function okRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("pagesClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    _resetPagesClientForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("동시 3회 호출은 fetch 1회로 합친다", async () => {
    fetchMock.mockResolvedValue(okRes({ pages: [1] }));
    const rs = await Promise.all([getPages(), getPages(), getPages()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rs.every((r) => r.ok && (r.data as { pages: number[] }).pages[0] === 1)).toBe(true);
  });

  it("TTL 안에서는 fetch 0회, 지나면 다시 가져온다", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(okRes({ pages: [] }));
    await getPages();
    await getPages();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5001);
    await getPages();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidatePages 뒤에는 다시 가져온다", async () => {
    fetchMock.mockResolvedValue(okRes({ pages: [] }));
    await getPages();
    invalidatePages();
    expect(getPagesSync()).toBeNull();
    await getPages();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("500 은 캐시하지 않는다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    fetchMock.mockResolvedValueOnce(okRes({ pages: [] }));
    const a = await getPages();
    expect(a).toEqual({ ok: false, status: 500, data: null });
    const b = await getPages();
    expect(b.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("네트워크 오류는 ok:false 로 돌려주고 캐시하지 않는다", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(okRes({ pages: [] }));
    expect(await getPages()).toEqual({ ok: false, status: 0, data: null });
    expect((await getPages()).ok).toBe(true);
  });

  it("fresh:true 는 캐시를 무시하되 진행 중 요청은 공유한다", async () => {
    fetchMock.mockResolvedValue(okRes({ pages: [] }));
    await getPages();
    const [a, b] = await Promise.all([getPages({ fresh: true }), getPages({ fresh: true })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
  });

  it("fresh:true 는 쓰기 전에 시작된 진행 중 일반 요청을 재사용하지 않고 새로 받는다", async () => {
    let releaseOld!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { releaseOld = res; }));
    fetchMock.mockResolvedValueOnce(okRes({ pages: ["new"] }));
    const old = getPages(); // 쓰기 전 시작
    const fresh = await getPages({ fresh: true }); // 쓰기 후
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fresh.data as { pages: string[] }).pages[0]).toBe("new");
    releaseOld(okRes({ pages: ["old"] }));
    await old;
    // 낡은 응답이 늦게 도착해도 캐시를 덮어쓰지 않는다
    expect((getPagesSync()?.data as { pages: string[] }).pages[0]).toBe("new");
  });

  it("pages:changed 식 invalidate 로 진행 중 요청이 버려지면 낡은 결과는 캐시되지 않는다", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { release = res; }));
    const p = getPages();
    invalidatePages();
    release(okRes({ pages: ["stale"] }));
    await p;
    expect(getPagesSync()).toBeNull();
  });

  it("getPagesSync 는 캐시가 있을 때만 값을 준다", async () => {
    expect(getPagesSync()).toBeNull();
    fetchMock.mockResolvedValue(okRes({ pages: [] }));
    await getPages();
    expect(getPagesSync()?.ok).toBe(true);
  });

  it("seedPages 뒤 getPages({fresh:false}) 는 fetch 없이 시드 값을 준다", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("performance", { timeOrigin: 0 });
    seedPages({ pages: [7] });
    const r = await getPages({ fresh: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, status: 200, data: { pages: [7] } });
  });

  it("seedPages 뒤에도 fresh:true 는 다시 가져온다", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("performance", { timeOrigin: 0 });
    seedPages({ pages: [7] });
    fetchMock.mockResolvedValue(okRes({ pages: [8] }));
    const r = await getPages({ fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((r.data as { pages: number[] }).pages).toEqual([8]);
  });

  it("서버(window 없음)에서 seedPages 는 아무것도 하지 않는다", () => {
    seedPages({ pages: [7] });
    expect(getPagesSync()).toBeNull();
  });

  it("seedPages({at}) 는 서버 시각으로 찍는다 — SSR 이 4초 전이면 1초 뒤 만료된다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:10Z"));
    vi.stubGlobal("window", {});
    vi.stubGlobal("performance", { timeOrigin: 0 });
    seedPages({ pages: [7] }, { at: "2026-10-09T00:00:06Z" });
    expect(getPagesSync()?.data).toEqual({ pages: [7] });
    vi.advanceTimersByTime(1001);
    expect(getPagesSync()).toBeNull();
    fetchMock.mockResolvedValue(okRes({ pages: [8] }));
    await getPages();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("seedPages({at}) 가 미래(서버 시계 앞섬)거나 잘못된 값이면 지금으로 자른다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:10Z"));
    vi.stubGlobal("window", {});
    vi.stubGlobal("performance", { timeOrigin: 0 });
    seedPages({ pages: [1] }, { at: "2026-10-09T01:00:00Z" });
    vi.advanceTimersByTime(5001);
    expect(getPagesSync()).toBeNull();
    seedPages({ pages: [2] }, { at: "not-a-date" });
    expect(getPagesSync()?.data).toEqual({ pages: [2] });
  });

  describe("seedPages TTL 클램프(탐색 시작 기준)", () => {
    const SERVER = "2026-10-09T00:00:00Z";
    const base = new Date(SERVER).getTime();
    function setup(nowOffsetMs: number, originOffsetMs: number) {
      vi.useFakeTimers();
      vi.setSystemTime(base + nowOffsetMs);
      vi.stubGlobal("window", {});
      vi.stubGlobal("performance", { timeOrigin: base + originOffsetMs });
    }

    it("클라이언트 시계가 서버보다 10초 앞서도 시드는 신선하다", () => {
      setup(10_000, 9_000); // 서버 시각이 10초 전, 탐색은 1초 전에 시작
      seedPages({ pages: [1] }, { at: SERVER });
      expect(getPagesSync()?.data).toEqual({ pages: [1] });
    });

    it("하이드레이션이 서버 시각 8초 뒤여도 시드는 신선하다", () => {
      setup(8_000, 7_000);
      seedPages({ pages: [2] }, { at: SERVER });
      expect(getPagesSync()?.data).toEqual({ pages: [2] });
    });

    it("탐색 시작이 TTL 보다 오래 전이면 시드는 낡았다", () => {
      setup(10_000, 4_000); // 탐색 시작 6초 전
      seedPages({ pages: [3] }, { at: SERVER });
      expect(getPagesSync()).toBeNull();
    });

    it("performance 가 없으면 서버 시각을 지금으로 자른 값을 쓴다", () => {
      setup(1_000, 0);
      vi.stubGlobal("performance", undefined);
      seedPages({ pages: [4] }, { at: SERVER });
      expect(getPagesSync()?.data).toEqual({ pages: [4] });
    });
  });

  it("더 새 캐시나 그 뒤의 무효화보다 오래된 시드는 버린다(두 번째 시드가 낡은 목록을 되살리지 않게)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:10Z"));
    vi.stubGlobal("window", {});
    vi.stubGlobal("performance", { timeOrigin: 0 });
    const at = "2026-10-09T00:00:09Z";
    seedPages({ pages: ["ssr"] }, { at });
    // 사이드바가 붙기 전에 쓰기가 일어나 무효화됐다
    invalidatePages();
    seedPages({ pages: ["ssr"] }, { at });
    expect(getPagesSync()).toBeNull();
    // fetch 로 받은 더 새 목록도 같은 시드가 덮지 않는다
    fetchMock.mockResolvedValue(okRes({ pages: ["new"] }));
    await getPages();
    seedPages({ pages: ["ssr"] }, { at });
    expect(getPagesSync()?.data).toEqual({ pages: ["new"] });
  });

  it("window 의 pages:changed 이벤트로 무효화된다", async () => {
    vi.resetModules();
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("window", { addEventListener: (n: string, f: () => void) => (listeners[n] = f) });
    const mod = await import("./pagesClient");
    fetchMock.mockResolvedValue(okRes({ pages: [] }));
    await mod.getPages();
    expect(mod.getPagesSync()).not.toBeNull();
    listeners["pages:changed"]();
    expect(mod.getPagesSync()).toBeNull();
  });
});
