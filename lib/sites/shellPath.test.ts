import { describe, it, expect, vi } from "vitest";
import {
  shellFileCandidates,
  ambiguousShellPaths,
  prettyPath,
  shellPath,
  parseNavMessage,
  navTarget,
  navTargetForEvent,
  injectNavScript,
  NAV_SCRIPT,
} from "./shellPath";

describe("shellFileCandidates — 셸 하위 경로 → 파일 후보", () => {
  it("빈 경로는 index.html", () => {
    expect(shellFileCandidates([])).toEqual(["index.html"]);
  });
  it("확장자 없으면 .html → /index.html 순", () => {
    expect(shellFileCandidates(["pages", "supabase-setup"])).toEqual(["pages/supabase-setup.html", "pages/supabase-setup/index.html"]);
    expect(shellFileCandidates(["docs"])).toEqual(["docs.html", "docs/index.html"]);
  });
  it("이미 html 이면 그대로", () => {
    expect(shellFileCandidates(["pages", "A1.html"])).toEqual(["pages/A1.html"]);
    expect(shellFileCandidates(["old.htm"])).toEqual(["old.htm"]);
  });
  it("이탈·숨김·예약 폴더·빈 세그먼트·구분자 섞인 세그먼트 거절", () => {
    for (const bad of [[".."], ["a", ".."], [".env"], ["a", ""], ["__ts", "nav"], ["a\\b"], ["a/b"], ["c:"], ["a\x00"]]) {
      expect(shellFileCandidates(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("prettyPath — 파일 → 주소창 경로", () => {
  it.each([
    ["index.html", ""],
    ["pages/x.html", "pages/x"],
    ["docs/index.html", "docs"],
    ["/pages/x.html", "pages/x"],
    ["old.htm", "old.htm"],
    ["a.pdf", "a.pdf"],
  ])("%s → %s", (file, want) => {
    expect(prettyPath(file)).toBe(want);
  });
  it("예쁜 경로가 다시 같은 파일 후보로 돌아온다", () => {
    for (const f of ["index.html", "pages/x.html", "docs/index.html", "old.htm"]) {
      const p = prettyPath(f);
      expect(shellFileCandidates(p ? p.split("/") : [])).toContain(f);
    }
  });
});

describe("shellPath·navTarget", () => {
  it("세그먼트마다 인코딩하고 항상 /s/ 로 시작", () => {
    expect(shellPath("banjang-handover", "")).toBe("/s/banjang-handover");
    expect(shellPath("banjang-handover", "pages/설정 안내")).toBe("/s/banjang-handover/pages/%EC%84%A4%EC%A0%95%20%EC%95%88%EB%82%B4");
  });
  it("메시지 → 예쁜 경로 + 해시", () => {
    expect(navTarget("b-h", { type: "ts-site-nav", path: "pages/y.html", hash: "#step-2" })).toBe("/s/b-h/pages/y#step-2");
    expect(navTarget("b-h", { type: "ts-site-nav", path: "index.html", hash: "" })).toBe("/s/b-h");
    expect(navTarget("b-h", { type: "ts-site-nav", path: "docs/index.html" })).toBe("/s/b-h/docs");
  });
  it("모양이 틀린 메시지는 무시", () => {
    for (const bad of [
      null, "x", 1,
      { type: "other", path: "a.html" },
      { type: "ts-site-nav" },
      { type: "ts-site-nav", path: 3 },
      { type: "ts-site-nav", path: "../x.html" },
      { type: "ts-site-nav", path: "//evil.com/x" },
      { type: "ts-site-nav", path: "/abs.html" },
      { type: "ts-site-nav", path: "a.html", hash: "nohash" },
      { type: "ts-site-nav", path: "a.html", hash: "#a\nb" },
      { type: "ts-site-nav", path: "x".repeat(2000) },
    ]) {
      expect(parseNavMessage(bad), JSON.stringify(bad)).toBeNull();
      expect(navTarget("s1x", bad)).toBeNull();
    }
  });
  it("navTargetForEvent: 우리 iframe(source)·샌드박스 origin(\"null\") 만", () => {
    const frame = {};
    const data = { type: "ts-site-nav", path: "pages/y.html", hash: "" };
    expect(navTargetForEvent({ source: frame, origin: "null", data }, frame, "b-h")).toBe("/s/b-h/pages/y");
    expect(navTargetForEvent({ source: {}, origin: "null", data }, frame, "b-h")).toBeNull();
    expect(navTargetForEvent({ source: frame, origin: "https://evil.example", data }, frame, "b-h")).toBeNull();
    expect(navTargetForEvent({ source: null, origin: "null", data }, null, "b-h")).toBeNull();
  });
});

describe("injectNavScript", () => {
  const src = "/pub/tok.sig/__ts/nav.js";
  const tag = `<script src="${src}"></script>`;
  it("마지막 </body> 앞(대소문자 무시)", () => {
    expect(injectNavScript("<html><BODY>x</BODY></html>", src)).toBe(`<html><BODY>x${tag}</BODY></html>`);
  });
  it("</body> 가 없으면 </html> 앞, 둘 다 없으면 끝", () => {
    expect(injectNavScript("<html>x</html>", src)).toBe(`<html>x${tag}</html>`);
    expect(injectNavScript("<p>x</p>", src)).toBe(`<p>x</p>${tag}`);
  });
  it("src 의 따옴표·꺾쇠는 지운다", () => {
    expect(injectNavScript("", '/x"><img onerror=1>')).toBe('<script src="/ximg onerror=1"></script>');
  });
});

describe("NAV_SCRIPT — iframe 안에서 부모에 경로를 알린다", () => {
  function run(pathname: string, hash = "", framed = true) {
    const post = vi.fn();
    const listeners: Record<string, () => void> = {};
    const parent = { postMessage: post };
    const win: Record<string, unknown> = {
      addEventListener: (t: string, f: () => void) => (listeners[t] = f),
    };
    win.parent = framed ? parent : win;
    const location = { pathname, hash };
    new Function("window", "location", NAV_SCRIPT)(win, location);
    return { post, listeners, location };
  }
  it("로드 때 토큰 뒤 경로(디코딩)·해시를 보낸다", () => {
    const { post } = run("/pub/tok.sig/pages/%EC%84%A4%EC%A0%95.html", "#a");
    expect(post).toHaveBeenCalledWith({ type: "ts-site-nav", path: "pages/설정.html", hash: "#a" }, "*");
  });
  it("hashchange 때 다시 보낸다", () => {
    const { post, listeners, location } = run("/pub/t/index.html");
    location.hash = "#b";
    listeners.hashchange();
    expect(post).toHaveBeenLastCalledWith({ type: "ts-site-nav", path: "index.html", hash: "#b" }, "*");
  });
  it("최상위로 직접 열면 아무것도 안 한다", () => {
    const { post } = run("/pub/t/index.html", "", false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("ambiguousShellPaths", () => {
  it("x.html + x/index.html 쌍만, 주소 순으로", () => {
    expect(ambiguousShellPaths(["index.html", "z.html", "z/index.html", "a.html", "a/index.html", "b.html", "c/index.html", "d.htm", "d/index.html"])).toEqual([
      { pretty: "a", file: "a.html", shadowed: "a/index.html" },
      { pretty: "z", file: "z.html", shadowed: "z/index.html" },
    ]);
  });
  it("셸 후보 순서와 일치 — .html 이 먼저", () => {
    expect(shellFileCandidates(["a"])?.[0]).toBe("a.html");
  });
});
