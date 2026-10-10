// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { _resetPagesClientForTests, getPagesSync } from "@/lib/pagesClient";
import { useSidebarData, type SidebarInitial } from "./useSidebarData";
import { SidebarTree } from "./SidebarTree";
import type { FlatPage } from "./treeModel";

const page = (id: string, projectId: string | null, parentId: string | null = null): FlatPage => ({
  id, title: id, icon: null, parentId, position: 0, kind: "doc", projectId,
});
const initial: SidebarInitial = {
  pages: [page("a", "pr1"), page("b", "pr1", "a"), page("c", null)],
  projects: [{ id: "pr1", name: "One" }],
};

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith("/api/pages")) return json({ pages: [page("x", null)] });
  if (url.startsWith("/api/projects")) return json({ projects: [{ id: "pr1", name: "One" }] });
  if (url.startsWith("/api/favorites")) return json({ favorites: [] });
  if (url.startsWith("/api/visits")) return json({ visits: [] });
  return json({});
});
const calledWith = (prefix: string) => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(prefix)).length;

type Snap = { loaded: boolean; groups: string[]; flat: number };
function Probe({ init, log }: { init?: SidebarInitial; log: Snap[] }) {
  const d = useSidebarData(null, init);
  const snap = { loaded: d.loaded, groups: d.groups.map((g) => `${g.key}:${g.roots.length}`), flat: d.flat.length };
  log.push(snap);
  return <div data-snap={JSON.stringify(snap)} />;
}

beforeEach(() => {
  _resetPagesClientForTests();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSidebarData — 서버 주입(U7)", () => {
  it("initial 이 있으면 첫 렌더부터 loaded·그룹이 채워진다(서버 렌더도 같다)", () => {
    const serverLog: Snap[] = [];
    const html = renderToString(<Probe init={initial} log={serverLog} />);
    expect(serverLog[0]).toEqual({ loaded: true, groups: ["pr1:1", "__none__:1"], flat: 3 });

    const clientLog: Snap[] = [];
    render(<Probe init={initial} log={clientLog} />);
    expect(clientLog[0]).toEqual(serverLog[0]);
    expect(html).toContain(JSON.stringify(serverLog[0]).replace(/"/g, "&quot;"));
  });

  it("initial 이 있으면 마운트 때 /api/pages 를 부르지 않는다(나머지는 그대로)", async () => {
    const log: Snap[] = [];
    render(<Probe init={initial} log={log} />);
    await waitFor(() => expect(calledWith("/api/visits")).toBe(1));
    await waitFor(() => expect(log.at(-1)).toMatchObject({ flat: 3 }));
    expect(calledWith("/api/pages")).toBe(0);
    expect(calledWith("/api/projects")).toBe(1);
    expect(calledWith("/api/favorites")).toBe(1);
  });

  it("initial 이 없으면 기존대로 — 빈 첫 렌더, /api/pages 1회", async () => {
    const log: Snap[] = [];
    render(<Probe log={log} />);
    expect(log[0]).toEqual({ loaded: false, groups: [], flat: 0 });
    await waitFor(() => expect(log.at(-1)).toMatchObject({ loaded: true, flat: 1 }));
    expect(calledWith("/api/pages")).toBe(1);
  });

  it("initial 이 null(서버 조회 실패)이면 클라 fetch 경로로 떨어진다", async () => {
    const log: Snap[] = [];
    render(<Probe init={null} log={log} />);
    expect(log[0].loaded).toBe(false);
    await waitFor(() => expect(log.at(-1)).toMatchObject({ loaded: true }));
    expect(calledWith("/api/pages")).toBe(1);
  });
});

describe("useSidebarData — refresh", () => {
  it("refresh 는 /api/pages 를 한 번만 받는다(pages:changed 리스너의 reload 와 합쳐진다)", async () => {
    function R() {
      const d = useSidebarData(null, initial);
      return <button onClick={() => void d.refresh()}>go</button>;
    }
    const { getByText } = render(<R />);
    await waitFor(() => expect(calledWith("/api/projects")).toBe(1));
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(getByText("go"));
    });
    await waitFor(() => expect(calledWith("/api/pages")).toBe(1));
    expect(calledWith("/api/pages")).toBe(1);
    expect(calledWith("/api/projects")).toBe(1);
  });
});

describe("useSidebarData — serverTime 시드", () => {
  // seedPages 는 시드 시각을 performance.timeOrigin 아래로 내리지 않는다. 워커가 4초 안에 떴다면
  // 4초 전 serverTime 이 timeOrigin 으로 끌어올려져 TTL 이 늘어나므로(플레이크), timeOrigin 을 그보다 과거로 고정한다.
  const ownOrigin = Object.getOwnPropertyDescriptor(performance, "timeOrigin");
  beforeEach(() => {
    const origin = Date.now() - 60_000;
    Object.defineProperty(performance, "timeOrigin", { configurable: true, get: () => origin });
  });
  afterEach(() => {
    if (ownOrigin) Object.defineProperty(performance, "timeOrigin", ownOrigin);
    else delete (performance as unknown as Record<string, unknown>).timeOrigin;
  });

  it("initial.serverTime 으로 캐시를 찍는다(마운트 시각이 아니라)", async () => {
    const at = new Date(Date.now() - 4000).toISOString();
    render(<Probe init={{ ...initial, serverTime: at }} log={[]} />);
    expect(getPagesSync()?.data).toEqual({ pages: initial!.pages });
    // 서버 시각 기준 TTL(5초) — 1초 남짓 뒤 만료되므로 클라 시각으로 찍었다면 남아 있을 시점에 비어 있다
    await new Promise((r) => setTimeout(r, 1100));
    expect(getPagesSync()).toBeNull();
  });
});

/* ---------- 서버가 정한 기본 접힘(U7 후속) ---------- */
const two: SidebarInitial = {
  pages: [page("a", "pr1"), page("b", "pr2"), page("c", null)],
  projects: [{ id: "pr1", name: "One" }, { id: "pr2", name: "Two" }],
};
const LS_COLLAPSED = "ws-sidebar-collapsed:v2";
// 같은 목록을 돌려주는 fetch — reload 가 트리를 바꾸지 않게 해 접힘 변화만 본다
const sameData = async (url: string) => {
  if (url.startsWith("/api/pages")) return json({ pages: two!.pages });
  if (url.startsWith("/api/projects")) return json({ projects: two!.projects });
  if (url.startsWith("/api/favorites")) return json({ favorites: [] });
  if (url.startsWith("/api/visits")) return json({ visits: [] });
  return json({});
};

type CSnap = { ready: boolean; collapsed: string[] };
function CProbe({ log, activeId = "a", init = two }: { log: CSnap[]; activeId?: string | null; init?: SidebarInitial }) {
  const d = useSidebarData(activeId, init);
  const snap = { ready: d.ready, collapsed: [...d.collapsed].sort() };
  log.push(snap);
  return <div data-c={JSON.stringify(snap)} />;
}

const noop = async () => {};
function Tree({ activeId = "a" }: { activeId?: string }) {
  const d = useSidebarData(activeId, two);
  return (
    <SidebarTree
      groups={d.groups} collapsed={d.collapsed} ready={d.ready} toggle={d.toggle} activeId={activeId}
      createPage={async () => null} createBoard={noop} busy={false} loaded={d.loaded}
      move={noop} rename={noop} remove={noop} toggleFavorite={d.toggleFavorite} setDocType={d.setDocType}
    />
  );
}

describe("useSidebarData — 서버 기본 접힘", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(sameData);
  });
  afterEach(() => {
    fetchMock.mockReset(); // 원래 구현으로 되돌린다
  });

  it("initial 이 있으면 서버 렌더부터 ready·현재 프로젝트만 펼친 기본값이다", () => {
    const log: CSnap[] = [];
    renderToString(<CProbe log={log} />);
    expect(log[0]).toEqual({ ready: true, collapsed: ["__none__", "pr2"] });
  });

  it("저장값이 없으면 마운트 뒤에도 뒤집히지 않고 기본값을 저장해 둔다", async () => {
    const log: CSnap[] = [];
    render(<CProbe log={log} />);
    await waitFor(() => expect(calledWith("/api/visits")).toBe(1));
    await waitFor(() => expect(localStorage.getItem(LS_COLLAPSED)).not.toBeNull());
    expect(new Set(log.map((x) => JSON.stringify(x)))).toEqual(new Set([JSON.stringify(log[0])]));
    expect(JSON.parse(localStorage.getItem(LS_COLLAPSED)!).sort()).toEqual(["__none__", "pr2"]);
  });

  it("저장값이 있으면 마운트 뒤 한 번 그 값으로 바뀐다(서버는 localStorage 를 모른다)", async () => {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(["pr1"]));
    const log: CSnap[] = [];
    render(<CProbe log={log} />);
    expect(log[0]).toEqual({ ready: true, collapsed: ["__none__", "pr2"] });
    await waitFor(() => expect(log.at(-1)).toEqual({ ready: true, collapsed: ["pr1"] }));
  });

  it("initial 이 없으면 예전처럼 결정 전(ready=false)으로 시작한다", () => {
    const log: CSnap[] = [];
    renderToString(<CProbe log={log} init={null} />);
    expect(log[0]).toEqual({ ready: false, collapsed: [] });
  });

  it("SidebarTree 를 서버 HTML 위에 hydrateRoot 해도 복구 가능한 하이드레이션 오류가 없다", async () => {
    const html = renderToString(<Tree />);
    // 서버 HTML 에 이미 현재 프로젝트 문서가 있고, 접힌 프로젝트 문서는 없다
    expect(html).toContain('href="/p/a"');
    expect(html).not.toContain('href="/p/b"');
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Tree />, { onRecoverableError });
    });
    await waitFor(() => expect(calledWith("/api/visits")).toBe(1));
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.filter((c) => /hydrat/i.test(c.map(String).join(" ")))).toEqual([]);
    errSpy.mockRestore();
    expect(container.innerHTML).toContain('href="/p/a"');
    expect(container.innerHTML).not.toContain('href="/p/b"');
    act(() => root!.unmount());
    container.remove();
  });

  it("음성 대조: 서버 HTML 과 다른 트리(activeId 다름)를 hydrate 하면 하이드레이션 신호가 잡힌다", async () => {
    const html = renderToString(<Tree activeId="a" />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Tree activeId="b" />, { onRecoverableError });
    });
    const signals = onRecoverableError.mock.calls.length + errSpy.mock.calls.filter((c) => /hydrat/i.test(c.map(String).join(" "))).length;
    errSpy.mockRestore();
    expect(signals).toBeGreaterThan(0);
    act(() => root!.unmount());
    container.remove();
  });
});
