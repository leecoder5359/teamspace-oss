import { describe, it, expect } from "vitest";
import { collectOpsStatus, evaluateOps, parseBackupName, WORKER_FRESH_SEC, type OpsDeps, type OpsStatus } from "./opsStatus";

const NOW = new Date(2026, 9, 9, 12, 0, 0); // 로컬 시각 — 백업 폴더명도 로컬 시각이다

function deps(over: Partial<OpsDeps> & { files?: Record<string, number> } = {}): OpsDeps {
  const files = over.files ?? { "/b/20261009-110000/docs.tar.gz": 100, "/b/20261009-110000/teamspace.dump": 50, "/b/20261008-110000/x": 1 };
  return {
    fs: {
      readdir: async (p) => {
        if (p === "/b") return ["20261008-110000", "20261009-110000", "notes.txt"];
        if (p === "/b/20261009-110000") return ["docs.tar.gz", "teamspace.dump"];
        if (p === "/b/20261008-110000") return ["x", "teamspace.dump"];
        throw new Error("ENOENT");
      },
      stat: async (p) => ({ size: files[p] ?? 0, mtimeMs: NOW.getTime() - 3_600_000, isFile: () => true }),
      statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
      readFile: async (p) => {
        if (p.endsWith("package.json")) return JSON.stringify({ version: "1.2.3" });
        if (p.endsWith("BUILD_ID")) return "abc123\n";
        throw new Error("ENOENT");
      },
    },
    now: () => NOW,
    heartbeat: async () => ({ db: true, at: new Date(NOW.getTime() - 30_000) }),
    usedTokensToday: async () => 500,
    dailyBudgetTokens: () => 1000,
    usageByDay: async () => [{ day: "2026-10-09", usd: 0.42 }],
    dayKey: () => "2026-10-09",
    env: { TEAMSPACE_BACKUP_DIR: "/b" },
    dataDir: "/data",
    cwd: "/app",
    ...over,
  };
}

describe("collectOpsStatus", () => {
  it("정상 상태를 모은다", async () => {
    const s = await collectOpsStatus(deps());
    expect(s.health).toEqual({ db: true, worker: true, workerAgeSec: 30 });
    expect(s.backup).toMatchObject({ dir: "/b", latest: "20261009-110000", sizeBytes: 150 });
    expect(s.backup.ageHours).toBeCloseTo(1, 5);
    expect(s.disk).toEqual({ path: "/data", requestedPath: "/data", freeBytes: 250 * 4096, totalBytes: 1000 * 4096, freeRatio: 0.25 });
    expect(s.llm).toEqual({ todayTokens: 500, todayUsd: 0.42, budgetTokens: 1000, exceeded: false });
    expect(s.build).toEqual({ version: "1.2.3", buildId: "abc123" });
  });

  it("하트비트가 90초 이상 묵으면 worker false", async () => {
    const s = await collectOpsStatus(deps({ heartbeat: async () => ({ db: true, at: new Date(NOW.getTime() - 120_000) }) }));
    expect(s.health).toEqual({ db: true, worker: false, workerAgeSec: 120 });
  });

  it("db 가 죽으면 worker 도 false", async () => {
    const s = await collectOpsStatus(deps({ heartbeat: async () => ({ db: false, at: null }) }));
    expect(s.health).toEqual({ db: false, worker: false, workerAgeSec: null });
  });

  it("백업 폴더가 없으면 latest null", async () => {
    const s = await collectOpsStatus(deps({ env: { TEAMSPACE_BACKUP_DIR: "/nope" } }));
    expect(s.backup).toEqual({ dir: "/nope", latest: null, ageHours: null, sizeBytes: null });
  });

  it("데이터 폴더가 없으면 상위 폴더로 재고, 끝까지 실패하면 null", async () => {
    const seen: string[] = [];
    const d = deps({ dataDir: "/data/sub" });
    d.fs.statfs = async (p) => {
      seen.push(p);
      if (p === "/data/sub" || p === "/data") throw new Error("ENOENT");
      return { bsize: 1, blocks: 100, bavail: 10 };
    };
    expect((await collectOpsStatus(d)).disk).toEqual({ path: "/", requestedPath: "/data/sub", freeBytes: 10, totalBytes: 100, freeRatio: 0.1 });
    expect(seen).toEqual(["/data/sub", "/data", "/"]);
  });

  it("statfs 실패면 disk null, package.json·BUILD_ID 없으면 unknown/null", async () => {
    const d = deps();
    d.fs.statfs = async () => { throw new Error("x"); };
    d.fs.readFile = async () => { throw new Error("x"); };
    const s = await collectOpsStatus(d);
    expect(s.disk).toBeNull();
    expect(s.build).toEqual({ version: "unknown", buildId: null });
  });

  it("예산 초과·오늘 행 없음", async () => {
    const s = await collectOpsStatus(deps({ usedTokensToday: async () => 1500, usageByDay: async () => [] }));
    expect(s.llm).toEqual({ todayTokens: 1500, todayUsd: null, budgetTokens: 1000, exceeded: true });
  });

  it("사용량 조회가 throw 해도 나머지는 돈다", async () => {
    const s = await collectOpsStatus(deps({ usedTokensToday: async () => { throw new Error("x"); }, usageByDay: async () => { throw new Error("x"); } }));
    expect(s.llm.todayTokens).toBeNull(); // 실패는 0 이 아니라 "모름"
    expect(s.llm.exceeded).toBe(false);
    expect(s.llm.todayUsd).toBeNull();
  });
});

describe("워커 경계", () => {
  const at = (sec: number) => ({ heartbeat: async () => ({ db: true, at: new Date(NOW.getTime() - sec * 1000) }) });
  it("89초는 살아 있고 90초는 죽은 것", async () => {
    expect((await collectOpsStatus(deps(at(89)))).health).toEqual({ db: true, worker: true, workerAgeSec: 89 });
    expect((await collectOpsStatus(deps(at(90)))).health).toEqual({ db: true, worker: false, workerAgeSec: 90 });
  });
  it("db 는 되는데 하트비트 행이 없으면 worker false · workerAgeSec null", async () => {
    const s = await collectOpsStatus(deps({ heartbeat: async () => ({ db: true, at: null }) }));
    expect(s.health).toEqual({ db: true, worker: false, workerAgeSec: null });
  });
});

describe("백업 진행 중·시계 어긋남", () => {
  const withDirs = (dirs: Record<string, { name: string; size?: number; ageMs: number }[]>): Partial<OpsDeps> => ({
    fs: {
      readdir: async (p) => {
        if (p === "/b") return Object.keys(dirs);
        const k = p.replace("/b/", "");
        if (dirs[k]) return dirs[k].map((f) => f.name);
        throw new Error("ENOENT");
      },
      stat: async (p) => {
        const [, , k, f] = p.split("/");
        const e = dirs[k]?.find((x) => x.name === f);
        if (!e) throw new Error("ENOENT");
        return { size: e.size ?? 1, mtimeMs: NOW.getTime() - e.ageMs, isFile: () => true };
      },
      statfs: async () => ({ bsize: 1, blocks: 100, bavail: 50 }),
      readFile: async () => { throw new Error("ENOENT"); },
    },
  });
  const OLD = 3_600_000;

  it("가장 새 폴더에 덤프가 없으면 건너뛰고 직전 완성본 + inProgress", async () => {
    const s = await collectOpsStatus(deps(withDirs({
      "20261009-115900": [{ name: "docs.tar.gz", ageMs: OLD }],
      "20261008-110000": [{ name: "teamspace.dump", size: 7, ageMs: OLD }],
    })));
    expect(s.backup).toMatchObject({ latest: "20261008-110000", sizeBytes: 7, inProgress: true });
    expect(s.backup.ageHours).toBeCloseTo(25, 5);
  });

  it("덤프는 있어도 파일이 2분 안에 바뀌었으면 진행 중", async () => {
    const s = await collectOpsStatus(deps(withDirs({
      "20261009-115800": [{ name: "teamspace.dump", ageMs: OLD }, { name: "docs.tar.gz", ageMs: 119_000 }],
      "20261008-110000": [{ name: "teamspace.dump", ageMs: OLD }],
    })));
    expect(s.backup).toMatchObject({ latest: "20261008-110000", inProgress: true });
  });

  it("정확히 2분 지났으면 완성으로 본다", async () => {
    const s = await collectOpsStatus(deps(withDirs({
      "20261009-115800": [{ name: "teamspace.dump", ageMs: 120_000 }],
      "20261008-110000": [{ name: "teamspace.dump", ageMs: OLD }],
    })));
    expect(s.backup.latest).toBe("20261009-115800");
    expect(s.backup.inProgress).toBeUndefined();
  });

  it("진행 중인데 직전 백업이 없으면 latest null + inProgress", async () => {
    const s = await collectOpsStatus(deps(withDirs({ "20261009-115900": [{ name: "docs.tar.gz", ageMs: 1000 }] })));
    expect(s.backup).toEqual({ dir: "/b", latest: null, ageHours: null, sizeBytes: null, inProgress: true });
  });

  it("미래 이름은 조용히 0 으로 깎지 않고 clockSkew 로 드러낸다", async () => {
    const s = await collectOpsStatus(deps(withDirs({ "20261009-130000": [{ name: "teamspace.dump", ageMs: OLD }] })));
    expect(s.backup).toMatchObject({ latest: "20261009-130000", ageHours: 0, clockSkew: true });
    expect(evaluateOps({ ...base, backup: s.backup }).map((w) => w.code)).toEqual(["backup_clock_skew"]);
  });

  it("정상 백업에는 두 플래그가 없다", async () => {
    const s = await collectOpsStatus(deps());
    expect(s.backup.inProgress).toBeUndefined();
    expect(s.backup.clockSkew).toBeUndefined();
  });
});

describe("parseBackupName", () => {
  it("로컬 시각으로 파싱, 형식 아니면 null", () => {
    expect(parseBackupName("20261009-063250")).toEqual(new Date(2026, 9, 9, 6, 32, 50));
    expect(parseBackupName("latest")).toBeNull();
  });
});

const base: OpsStatus = {
  checkedAt: "x",
  health: { db: true, worker: true, workerAgeSec: 10 },
  backup: { dir: "/b", latest: "20261009-110000", ageHours: 1, sizeBytes: 1 },
  disk: { path: "/d", requestedPath: "/d", freeBytes: 50, totalBytes: 100, freeRatio: 0.5 },
  llm: { todayTokens: 0, todayUsd: null, budgetTokens: 0, exceeded: false },
  build: { version: "1", buildId: null },
};
const codes = (s: OpsStatus) => evaluateOps(s).map((w) => `${w.level}:${w.code}`);

describe("evaluateOps", () => {
  it("정상이면 경고 없음", () => expect(evaluateOps(base)).toEqual([]));

  it.each([
    [30, []],
    [30.5, ["warn:backup_stale"]],
    [72, ["warn:backup_stale"]],
    [72.5, ["crit:backup_stale"]],
  ])("백업 나이 %s시간", (h, want) => {
    expect(codes({ ...base, backup: { ...base.backup, ageHours: h } })).toEqual(want);
  });

  it("첫 백업이 진행 중이면 backup_missing crit 대신 warn backup_in_progress", () => {
    expect(codes({ ...base, backup: { dir: "/b", latest: null, ageHours: null, sizeBytes: null, inProgress: true } })).toEqual(["warn:backup_in_progress"]);
  });

  it("백업이 없으면 crit", () => {
    expect(codes({ ...base, backup: { dir: "/b", latest: null, ageHours: null, sizeBytes: null } })).toEqual(["crit:backup_missing"]);
  });

  it.each([
    [0.15, []],
    [0.14, ["warn:disk_low"]],
    [0.07, ["warn:disk_low"]],
    [0.06, ["crit:disk_low"]],
  ])("디스크 여유 %s", (r, want) => {
    expect(codes({ ...base, disk: { ...base.disk!, freeRatio: r } })).toEqual(want);
  });

  it("disk null 은 경고하지 않는다", () => expect(evaluateOps({ ...base, disk: null })).toEqual([]));

  it("예산 초과 warn", () => expect(codes({ ...base, llm: { ...base.llm, exceeded: true } })).toEqual(["warn:llm_budget"]));

  it("워커 지연 warn, db 다운 crit(워커 경고는 중복하지 않음)", () => {
    expect(codes({ ...base, health: { db: true, worker: false, workerAgeSec: 200 } })).toEqual(["warn:worker_down"]);
    expect(evaluateOps({ ...base, health: { db: true, worker: false, workerAgeSec: 200 } })[0].message).toContain(`${WORKER_FRESH_SEC}초 초과`);
    expect(codes({ ...base, health: { db: false, worker: false, workerAgeSec: null } })).toEqual(["crit:db_down"]);
  });
});
