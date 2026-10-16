// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetVisitsClientForTests, getRecentVisits, recordVisit } from "./visitsClient";

const okRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const label = (c: unknown[]) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`;

describe("visitsClient", () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? okRes({ ok: true }) : okRes({ visits: [{ pageId: url.endsWith("limit=9") ? "a" : "?" }] })));
  beforeEach(() => {
    _resetVisitsClientForTests();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("목록 요청은 같은 틱에 시작된 방문 기록이 끝난 뒤에 나가고, visits:changed 재요청과 합쳐진다", async () => {
    const onChanged = vi.fn(() => void getRecentVisits());
    window.addEventListener("visits:changed", onChanged);
    const list = getRecentVisits(); // 사이드바가 먼저
    const rec = recordVisit("a"); // 같은 커밋의 브레드크럼
    expect(await rec).toBe(true);
    expect(await list).toEqual([{ pageId: "a" }]);
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener("visits:changed", onChanged);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(label)).toEqual(["POST /api/visits", "GET /api/visits?limit=9"]);
  });

  it("기록은 열 때마다 한 번씩, 기록 뒤 목록은 새로 받는다", async () => {
    await recordVisit("a");
    await getRecentVisits();
    await recordVisit("b");
    await getRecentVisits();
    expect(fetchMock.mock.calls.map(label)).toEqual(["POST /api/visits", "GET /api/visits?limit=9", "POST /api/visits", "GET /api/visits?limit=9"]);
  });

  it("기록 실패면 visits:changed 를 쏘지 않고 false", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response);
    const onChanged = vi.fn();
    window.addEventListener("visits:changed", onChanged);
    expect(await recordVisit("zz")).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener("visits:changed", onChanged);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
