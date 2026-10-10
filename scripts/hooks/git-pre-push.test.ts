import { describe, expect, it } from "vitest";
import { formatWarning, lockNameFor, parsePushRefs, repoNameFromCommonDir, run } from "./git-pre-push.mjs";

// git pre-push 잠금 경고(Console 4): 브랜치 → <repo>/<branch> 잠금, 남의 잠금이면 경고+알림, 항상 통과.
const Z = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parsePushRefs", () => {
  it("브랜치 푸시만, 같은 브랜치는 한 번", () => {
    const stdin = [
      `refs/heads/develop ${A} refs/heads/develop ${B}`,
      `refs/tags/v1 ${A} refs/tags/v1 ${Z}`,
      `refs/heads/feat ${A} refs/heads/develop ${B}`,
      `HEAD ${A} refs/heads/feature/x ${Z}`,
      "",
    ].join("\n");
    expect(parsePushRefs(stdin).map((r: { branch: string }) => r.branch)).toEqual(["develop", "feature/x"]);
  });
  it("브랜치 삭제 표시", () => {
    expect(parsePushRefs(`(delete) ${Z} refs/heads/old ${B}\n`)[0]).toMatchObject({ branch: "old", deleting: true });
  });
  it("빈 입력", () => expect(parsePushRefs("")).toEqual([]));
});

describe("repoNameFromCommonDir · lockNameFor", () => {
  it("본체 .git → 폴더 이름(워크트리여도 공통 .git 의 주인)", () => {
    expect(repoNameFromCommonDir("/Users/u/dev/banjang/.git")).toBe("banjang");
    expect(repoNameFromCommonDir("/Users/u/dev/banjang/.git/")).toBe("banjang");
  });
  it("bare 저장소는 .git 꼬리를 뗀다", () => expect(repoNameFromCommonDir("/srv/teamspace.git")).toBe("teamspace"));
  it("없으면 null", () => expect(repoNameFromCommonDir(null)).toBeNull());
  it("이름은 소문자 <repo>/<branch>, 규칙 밖이면 null", () => {
    expect(lockNameFor("Banjang", "develop")).toBe("banjang/develop");
    expect(lockNameFor("teamspace", "feature/Abc")).toBe("teamspace/feature/abc");
    expect(lockNameFor("teamspace", "weird+branch")).toBeNull();
    expect(lockNameFor(null, "main")).toBeNull();
  });
});

describe("formatWarning", () => {
  it("보유자·메모·나이·만료·진행 안내", () => {
    const s = formatWarning({ name: "banjang/develop", holderName: "mac-mini", ageMin: 12, remainingMin: 18, note: "CI 대기", branch: "develop", cwd: "/w/banjang" });
    expect(s).toContain("mac-mini");
    expect(s).toContain("CI 대기");
    expect(s).toContain("12분 전");
    expect(s).toContain("18분 뒤");
    expect(s).toContain("푸시는 그대로 진행");
  });
});

type Call = { url: string; init?: RequestInit };
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;
const base = { cfg: { base: "http://ts", token: "wst_x" }, commonDir: () => "/w/banjang/.git", cwd: "/w/banjang", log: () => {} };
const stdin = `refs/heads/develop ${A} refs/heads/develop ${B}\n`;

describe("run (훅 본체)", () => {
  it("남의 잠금 → 경고 출력 + notify 호출(세션 id 함께)", async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/notify")) return json({ notified: true });
      return json({ lock: { name: "banjang/develop", active: true, mine: false, holderName: "mac-mini", ageMin: 1, remainingMin: 29, note: null } });
    };
    const r = await run({ ...base, stdin, env: { CLAUDE_CODE_SESSION_ID: "s-me" }, fetchImpl, log: (s: string) => logs.push(s) });
    expect(r).toEqual({ checked: ["banjang/develop"], warned: ["banjang/develop"], notified: ["banjang/develop"] });
    expect(calls[0].url).toBe("http://ts/api/locks/banjang%2Fdevelop?session=s-me");
    expect(calls[1].url).toBe("http://ts/api/locks/banjang%2Fdevelop/notify");
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ session: "s-me", branch: "develop", cwd: "/w/banjang" });
    expect(logs.join("\n")).toContain("mac-mini");
  });

  it("내 잠금·빈 잠금이면 조용히", async () => {
    for (const lock of [{ active: true, mine: true, holderName: "me" }, null]) {
      const calls: string[] = [];
      const r = await run({ ...base, stdin, env: {}, fetchImpl: async (u: string) => (calls.push(u), json({ lock })) });
      expect(r.warned).toEqual([]);
      expect(calls).toHaveLength(1);
    }
  });

  it("토큰이 없으면 서버를 부르지 않는다", async () => {
    let called = false;
    await run({ ...base, cfg: { base: "http://ts", token: "" }, stdin, env: {}, fetchImpl: async () => ((called = true), json({})) });
    expect(called).toBe(false);
  });

  it("fail open: 서버 오류·연결 실패는 던지지 않는다", async () => {
    await expect(run({ ...base, stdin, env: {}, fetchImpl: async () => json({ error: "x" }, false) })).resolves.toMatchObject({ warned: [] });
    await expect(run({ ...base, stdin, env: {}, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).resolves.toMatchObject({ warned: [] });
  });

  it("fail open: 서버가 멈춰 있으면 제한 시간 안에 끝난다", async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    const t = Date.now();
    const r = await run({ ...base, stdin, env: {}, fetchImpl: hang, timeoutMs: 200 });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(r.warned).toEqual([]);
  });

  it("저장소가 아니면(공통 dir 없음) 아무것도 안 한다", async () => {
    let called = false;
    await run({ ...base, commonDir: () => null, stdin, env: {}, fetchImpl: async () => ((called = true), json({})) });
    expect(called).toBe(false);
  });
});
