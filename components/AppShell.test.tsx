// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { _resetPagesClientForTests, getPagesSync } from "@/lib/pagesClient";

// 사이드바는 이 테스트의 관심이 아니다 — 마운트되기 전에 자식이 캐시를 읽는 경우만 본다.
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import AppShell, { type InitialSidebar } from "./AppShell";

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

  it("initialSidebar 가 없으면 심지 않는다", () => {
    render(<AppShell><div /></AppShell>);
    expect(getPagesSync()).toBeNull();
  });
});
