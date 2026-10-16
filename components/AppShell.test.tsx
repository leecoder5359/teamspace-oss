// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { _resetPagesClientForTests, getPagesSync } from "@/lib/pagesClient";

// 사이드바는 이 테스트의 관심이 아니다 — 마운트되기 전에 자식이 캐시를 읽는 경우만 본다.
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import AppShell, { type InitialSidebar } from "./AppShell";
import { packRows } from "@/lib/rowPack";

const initial: InitialSidebar = {
  pages: [{ id: "a", title: "a", icon: null, parentId: null, position: 0, kind: "doc", projectId: null }] as NonNullable<InitialSidebar>["pages"],
  projects: [],
  serverTime: new Date().toISOString(),
};

beforeEach(() => _resetPagesClientForTests());
afterEach(() => cleanup());

describe("AppShell — 서버 목록 시드", () => {
  it("자식의 첫 렌더 전에 공유 캐시가 서버 목록으로 채워진다(사이드바 마운트 전 getPages 도 네트워크 없이)", () => {
    const seen: unknown[] = [];
    function Child() {
      seen.push(getPagesSync()?.data ?? null);
      return null;
    }
    render(<AppShell initialSidebar={initial}><Child /></AppShell>);
    expect(seen[0]).toEqual({ pages: initial!.pages });
  });

  it("스트리밍 프라미스 — 도착해 있으면(status=fulfilled) 자식 첫 렌더 전에, 아니면 도착하는 대로 심는다", async () => {
    const ready = Object.assign(Promise.resolve(initial), { status: "fulfilled", value: initial });
    const seen: unknown[] = [];
    function Child() {
      seen.push(getPagesSync()?.data ?? null);
      return null;
    }
    render(<AppShell initialSidebar={ready}><Child /></AppShell>);
    expect(seen[0]).toEqual({ pages: initial!.pages });

    cleanup();
    _resetPagesClientForTests();
    let resolve!: (v: InitialSidebar) => void;
    const later = new Promise<InitialSidebar>((r) => (resolve = r));
    render(<AppShell initialSidebar={later}><div /></AppShell>);
    expect(getPagesSync()).toBeNull();
    resolve(initial);
    await later;
    await Promise.resolve();
    expect(getPagesSync()?.data).toEqual({ pages: initial!.pages });
  });

  it("열 행렬(packRows)로 온 목록은 원래 배열로 되돌려 심는다", () => {
    render(<AppShell initialSidebar={{ ...initial!, pages: packRows(initial!.pages) }}><div /></AppShell>);
    expect(getPagesSync()?.data).toEqual({ pages: initial!.pages });
  });

  it("initialSidebar 가 없으면 심지 않는다", () => {
    render(<AppShell><div /></AppShell>);
    expect(getPagesSync()).toBeNull();
  });
});
