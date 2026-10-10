import { describe, it, expect } from "vitest";
import {
  compareNames, compareValues, DriftInputError, driftIssueCount, driftMap, groupDrift, validateDriftResults,
} from "./drift";
import { computeSyncGroups } from "./syncGroups";

describe("드리프트 비교(순수)", () => {
  it("값 비교: 일치·다름·원격 없음·원격에만, 키 이름 형식이 아닌 원격 항목은 무시", () => {
    const r = compareValues(
      [{ key: "A", value: "1" }, { key: "B", value: "2" }, { key: "C", value: "3" }],
      [{ key: "A", value: "1" }, { key: "B", value: "x" }, { key: "EXTRA", value: "e" }, { key: "lower", value: "z" }],
    );
    expect(r).toEqual({ A: "match", B: "differs", C: "missing_remote", EXTRA: "remote_only" });
    expect(Object.keys(r)).toEqual(["A", "B", "C", "EXTRA"]);
  });

  it("값 비교: 같은 키가 두 번이면 마지막 값", () => {
    expect(compareValues([{ key: "A", value: "2" }], [{ key: "A", value: "1" }, { key: "A", value: "2" }])).toEqual({ A: "match" });
  });

  it("이름 비교: 있음·원격 없음·원격에만", () => {
    expect(compareNames(["A", "B"], new Set(["A", "Z"]))).toEqual({ A: "present", B: "missing_remote", Z: "remote_only" });
  });

  it("묶음·다름 수", () => {
    const r = { A: "match", B: "differs", C: "missing_remote", D: "remote_only", E: "present" } as const;
    expect(groupDrift(r)).toMatchObject({ match: ["A"], differs: ["B"], missing_remote: ["C"], remote_only: ["D"], present: ["E"] });
    expect(driftIssueCount(r)).toBe(3);
  });

  it("저장된 JSON 해석: 모르는 상태는 버린다", () => {
    expect(driftMap({ A: "match", B: "weird", C: 3 })).toEqual({ A: "match" });
    expect(driftMap(null)).toEqual({});
    expect(driftMap([1])).toEqual({});
  });
});

describe("드리프트 결과 검증(서버)", () => {
  const vault = ["A", "B"];
  it("값 읽는 대상: match·differs·missing_remote·remote_only 만", () => {
    expect(validateDriftResults({ B: "differs", A: "match", X: "remote_only" }, "dotenv", vault)).toEqual({ A: "match", B: "differs", X: "remote_only" });
    expect(() => validateDriftResults({ A: "present" }, "ssm", vault)).toThrow(DriftInputError);
  });
  it("이름만 읽는 대상: present·missing_remote·remote_only 만", () => {
    expect(validateDriftResults({ A: "present", B: "missing_remote" }, "vercel", vault)).toEqual({ A: "present", B: "missing_remote" });
    expect(() => validateDriftResults({ A: "match" }, "gha", vault)).toThrow(/상태는/);
  });
  it("모양·키 형식·금고 정합", () => {
    expect(() => validateDriftResults(null, "dotenv", vault)).toThrow(DriftInputError);
    expect(() => validateDriftResults(["A"], "dotenv", vault)).toThrow(DriftInputError);
    expect(() => validateDriftResults({ "bad-key": "match" }, "dotenv", vault)).toThrow(/형식/);
    expect(() => validateDriftResults({ A: "remote_only" }, "dotenv", vault)).toThrow(/remote_only 일 수 없/);
    expect(() => validateDriftResults({ X: "match" }, "dotenv", vault)).toThrow(/금고에 없는 키/);
    expect(() => validateDriftResults({ A: 1 }, "dotenv", vault)).toThrow(DriftInputError);
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`K${i}`, "remote_only"]));
    expect(() => validateDriftResults(many, "dotenv", vault)).toThrow(/1000/);
  });
});

describe("syncGroup 일관성(순수)", () => {
  const m = (name: string, projectName: string, env: string, key: string, digest: string) => ({
    syncGroup: name, projectId: `p-${projectName}`, projectName, env, key, varId: `${projectName}-${env}-${key}`, digest,
  });
  it("같은 지문이면 consistent, 하나라도 다르면 false · 지문은 결과에 없음", () => {
    const r = computeSyncGroups([
      m("db", "web", "dev", "DATABASE_URL", "d1"),
      m("db", "api", "dev", "DB_URL", "d1"),
      m("jwt", "web", "prod", "JWT", "x"),
      m("jwt", "api", "prod", "JWT", "y"),
      m("solo", "web", "dev", "ONE", "z"),
    ]);
    expect(r.map((g) => [g.name, g.consistent])).toEqual([["db", true], ["jwt", false], ["solo", true]]);
    expect(r[0].members.map((x) => x.projectName)).toEqual(["api", "web"]);
    expect(JSON.stringify(r)).not.toMatch(/"digest"|d1|"x"|"y"/);
    expect(r[1].members[0]).toEqual({ projectId: "p-api", projectName: "api", env: "prod", key: "JWT", varId: "api-prod-JWT" });
  });
});
