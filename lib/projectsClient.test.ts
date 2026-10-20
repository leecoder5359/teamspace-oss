// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetProjectsClientForTests, getProjects, seedProjects } from "./projectsClient";

const okRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const wire = { projects: [{ id: "p1", name: "One", archivedAt: null }, { id: "p2", name: "Old", archivedAt: "2026-01-01T00:00:00Z" }] };

describe("projectsClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    _resetProjectsClientForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("보관 포함 목록을 받아 archived 로 바꾸고, 동시 호출은 fetch 1회로 합친다", async () => {
    fetchMock.mockResolvedValue(okRes(wire));
    const [a, b] = await Promise.all([getProjects(), getProjects()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects?archived=all&fields=sidebar"); // 지표 없는 가벼운 경로(감사 P-11)
    expect(a).toEqual([{ id: "p1", name: "One", archived: false }, { id: "p2", name: "Old", archived: true }]);
    expect(b).toBe(a);
  });

  it("시드가 있으면 TTL 동안 네트워크 0회, fresh 는 다시 받는다", async () => {
    fetchMock.mockResolvedValue(okRes(wire));
    seedProjects([{ id: "p1", name: "One" }]);
    expect(await getProjects()).toEqual([{ id: "p1", name: "One", archived: false }]);
    expect(fetchMock).not.toHaveBeenCalled();
    await getProjects({ fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pages:changed 뒤에는 캐시를 버리고, 그 전 시각의 시드는 받지 않는다", async () => {
    fetchMock.mockResolvedValue(okRes(wire));
    seedProjects([{ id: "p1", name: "One" }]);
    // performance.timeOrigin 아래로는 시드 시각을 내리지 않으므로, 무효화를 시드보다 확실히 뒤에 둔다
    await new Promise((r) => setTimeout(r, 5));
    window.dispatchEvent(new Event("pages:changed"));
    seedProjects([{ id: "x", name: "stale" }], { at: new Date(Date.now() - 1000).toISOString() });
    await getProjects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("실패는 null 이고 캐시하지 않는다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    fetchMock.mockResolvedValueOnce(okRes(wire));
    expect(await getProjects()).toBeNull();
    expect(await getProjects()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
