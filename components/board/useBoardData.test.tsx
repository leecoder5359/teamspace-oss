// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useBoardData, type DbPayload } from "./useBoardData";

const payload: DbPayload = {
  page: { id: "db1", title: "보드", kind: "database", project: null },
  properties: [{ id: "p1", name: "이름", type: "text", config: null, position: 0 }],
  views: [{ id: "v1", name: "표", type: "table", config: null, position: 0 }],
  rows: [{ id: "r1", props: { p1: "첫 행" }, position: 0 }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** URL·메서드별 응답. 기본은 보드 로드 성공 + 빈 리마인더·프로젝트. */
function mockFetch(over: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const hit = over(url, init);
    if (hit) return hit;
    if (url === "/api/databases/db1") return json(payload);
    if (url.startsWith("/api/schedules")) return json({ schedules: [] });
    if (url === "/api/projects") return json({ projects: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useBoardData", () => {
  it("refetchKey 가 바뀌면 loading 을 켜지 않고 보드·리마인더를 다시 읽는다(첫 렌더는 한 번만)", async () => {
    const fn = mockFetch();
    const count = (pre: string) => fn.mock.calls.filter(([u]) => String(u).startsWith(pre)).length;
    const { result, rerender } = renderHook(({ k }) => useBoardData("db1", { refetchKey: k }), {
      initialProps: { k: "|" },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(count("/api/databases/db1")).toBe(1);
    expect(count("/api/schedules")).toBe(1);
    rerender({ k: "|" });
    expect(count("/api/databases/db1")).toBe(1);
    rerender({ k: "kanban|" });
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(count("/api/databases/db1")).toBe(2));
    expect(count("/api/schedules")).toBe(2);
  });

  it("load 가 data 와 rows 를 채우고 loading 을 끈다", async () => {
    mockFetch();
    const onLoad = vi.fn();
    const { result } = renderHook(() => useBoardData("db1", { onLoad }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.page.title).toBe("보드");
    expect(result.current.rows.map((r) => r.id)).toEqual(["r1"]);
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ views: payload.views }));
  });

  it("updateCell 은 /api/rows/:id 로 PATCH 를 보내고 화면을 먼저 바꾼다", async () => {
    const fn = mockFetch((url, init) => (url === "/api/rows/r1" && init?.method === "PATCH" ? json({ ok: true }) : undefined));
    const { result } = renderHook(() => useBoardData("db1"));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await act(() => result.current.updateCell("r1", "p1", "바뀐 값"));
    const call = fn.mock.calls.find(([u, i]) => String(u) === "/api/rows/r1" && i?.method === "PATCH");
    expect(call).toBeDefined();
    expect(call![1]?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(call![1]?.body))).toEqual({ props: { p1: "바뀐 값" } });
    expect(result.current.rows[0].props.p1).toBe("바뀐 값");
    expect(result.current.error).toBeNull();
  });

  it("updateCell 이 실패하면 error 를 세팅하고 서버 상태로 다시 읽는다", async () => {
    mockFetch((url, init) =>
      url === "/api/rows/r1" && init?.method === "PATCH" ? json({ error: "권한이 없습니다." }, 403) : undefined,
    );
    const { result } = renderHook(() => useBoardData("db1"));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await act(() => result.current.updateCell("r1", "p1", "바뀐 값"));
    expect(result.current.error).toBe("권한이 없습니다.");
    expect(result.current.rows[0].props.p1).toBe("첫 행");
  });

  describe("saveViewConfig", () => {
    const VIEW_URL = "/api/databases/db1/views/v1";
    /** 뷰 PATCH 응답을 테스트가 직접 풀어 주도록 붙잡아 둔다 — 응답 전 화면 상태를 보기 위해 */
    function holdViewPatch() {
      let release!: (r: Response) => void;
      const pending = new Promise<Response>((r) => (release = r));
      const fn = mockFetch((url, init) => (url === VIEW_URL && init?.method === "PATCH" ? (pending as never) : undefined));
      return { fn, release };
    }
    const sortOf = (r: { current: ReturnType<typeof useBoardData> }) => r.current.data?.views[0].config?.sort;
    const SORT = { propId: "p1", dir: "desc" as const };

    it("낙관적(기본): 응답 전에 화면부터 바꾸고, 바뀐 키만 PATCH 로 보낸다", async () => {
      const { fn, release } = holdViewPatch();
      const { result } = renderHook(() => useBoardData("db1"));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      let done!: Promise<void>;
      act(() => {
        done = result.current.saveViewConfig("v1", { sort: SORT }, (c) => ({ ...c, sort: SORT }), "실패");
      });
      expect(sortOf(result)).toEqual(SORT); // 응답 전
      const call = fn.mock.calls.find(([u, i]) => String(u) === VIEW_URL && i?.method === "PATCH");
      expect(JSON.parse(String(call![1]?.body))).toEqual({ config: { sort: SORT } });
      await act(async () => {
        release(json({ ok: true }));
        await done;
      });
      expect(sortOf(result)).toEqual(SORT);
      expect(result.current.error).toBeNull();
    });

    it("낙관적: 실패해도 되돌리지 않고 서버 에러(없으면 fallback)만 알린다", async () => {
      const { release } = holdViewPatch();
      const { result } = renderHook(() => useBoardData("db1"));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      let done!: Promise<void>;
      act(() => {
        done = result.current.saveViewConfig("v1", { sort: SORT }, (c) => ({ ...c, sort: SORT }), "정렬 저장 실패");
      });
      await act(async () => {
        release(json({}, 500));
        await done;
      });
      expect(sortOf(result)).toEqual(SORT);
      expect(result.current.error).toBe("정렬 저장 실패");
    });

    it("비낙관적: 응답 전에는 화면을 안 바꾸고 성공해야 반영한다", async () => {
      const { release } = holdViewPatch();
      const { result } = renderHook(() => useBoardData("db1"));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      let done!: Promise<void>;
      act(() => {
        done = result.current.saveViewConfig("v1", { sort: SORT }, (c) => ({ ...c, sort: SORT }), "실패", false);
      });
      expect(sortOf(result)).toBeUndefined();
      await act(async () => {
        release(json({ ok: true }));
        await done;
      });
      expect(sortOf(result)).toEqual(SORT);
    });

    it("비낙관적: 실패하면 화면은 그대로고 서버 에러 문구를 쓴다", async () => {
      const { release } = holdViewPatch();
      const { result } = renderHook(() => useBoardData("db1"));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      let done!: Promise<void>;
      act(() => {
        done = result.current.saveViewConfig("v1", { sort: SORT }, (c) => ({ ...c, sort: SORT }), "실패", false);
      });
      await act(async () => {
        release(json({ error: "권한이 없습니다." }, 403));
        await done;
      });
      expect(sortOf(result)).toBeUndefined();
      expect(result.current.error).toBe("권한이 없습니다.");
    });

    it("fetch 자체가 거부돼도 던지지 않고 fallback 에러만 알린다(낙관/비낙관 모두)", async () => {
      for (const optimistic of [true, false]) {
        mockFetch((url, init) => (url === VIEW_URL && init?.method === "PATCH" ? (Promise.reject(new TypeError("network")) as never) : undefined));
        const { result, unmount } = renderHook(() => useBoardData("db1"));
        await waitFor(() => expect(result.current.data).not.toBeNull());
        await act(async () => {
          await expect(
            result.current.saveViewConfig("v1", { sort: SORT }, (c) => ({ ...c, sort: SORT }), "정렬 저장 실패", optimistic),
          ).resolves.toBeUndefined();
        });
        expect(result.current.error).toBe("정렬 저장 실패");
        expect(sortOf(result)).toEqual(optimistic ? SORT : undefined);
        unmount();
      }
    });

    it("apply 는 다른 뷰를 건드리지 않고 기존 config 위에 병합한다", async () => {
      const two: DbPayload = {
        ...payload,
        views: [
          { id: "v1", name: "표", type: "table", config: { meta: ["createdAt"] }, position: 0 },
          { id: "v2", name: "칸반", type: "kanban", config: { groupBy: "s" }, position: 1 },
        ],
      };
      mockFetch((url, init) => {
        if (url === "/api/databases/db1") return json(two);
        return url === VIEW_URL && init?.method === "PATCH" ? json({ ok: true }) : undefined;
      });
      const { result } = renderHook(() => useBoardData("db1"));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      await act(() => result.current.saveViewConfig("v1", { sort: SORT }, (c) => ({ ...c, sort: SORT }), "실패"));
      expect(result.current.data?.views[0].config).toEqual({ meta: ["createdAt"], sort: SORT });
      expect(result.current.data?.views[1].config).toEqual({ groupBy: "s" });
    });
  });
});
