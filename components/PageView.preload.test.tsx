// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

/* PageView 는 모듈 평가 때(하이드레이션 전) 지금 모드의 편집기 청크를 import 하기 시작한다.
   dynamic() 은 막아 두고, 편집기 모듈이 평가됐는지로 '미리 받기 시작했다' 를 본다. */
const loaded = vi.hoisted(() => [] as string[]);
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./PageEditor", () => {
  loaded.push("PageEditor");
  return { default: () => null };
});
vi.mock("./RawDocEditor", () => {
  loaded.push("RawDocEditor");
  return { default: () => null };
});
vi.mock("./DocToc", () => ({ default: () => null }));
vi.mock("./Breadcrumb", () => ({ default: () => null }));
vi.mock("./ws/PresenceBar", () => ({ default: () => null }));
vi.mock("./ws/SharePanel", () => ({ default: () => null }));

const settle = async () => {
  for (let i = 0; i < 20 && loaded.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("PageView — 편집기 청크 미리 받기", () => {
  beforeEach(() => {
    vi.resetModules();
    loaded.length = 0;
    localStorage.clear();
  });

  it("기본(블록 편집기) 모드면 렌더 전에 PageEditor 만 받기 시작한다", async () => {
    await import("./PageView");
    await settle();
    expect(loaded).toEqual(["PageEditor"]);
  });

  it("원문 모드 사용자는 RawDocEditor 만 — BlockNote 를 받지 않는다", async () => {
    localStorage.setItem("ws:editorMode", "source");
    await import("./PageView");
    await settle();
    expect(loaded).toEqual(["RawDocEditor"]);
  });
});
