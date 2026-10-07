import { describe, it, expect } from "vitest";
import {
  allowSubmission,
  parseIntakeSubmission,
  rateKey,
  INTAKE_MAX_ITEMS,
  INTAKE_MAX_VALUE_CHARS,
  INTAKE_RATE_LIMIT,
  INTAKE_RATE_WINDOW_MS,
  type RateState,
} from "./intake";

const item = (service: string, fields: { label: string; value: string }[]) => ({ service, fields });

describe("parseIntakeSubmission", () => {
  it("정상 제출", () => {
    const r = parseIntakeSubmission({ items: [item("Supabase", [{ label: "계정 이메일", value: "a@b.com" }])] });
    expect(r).toEqual({ ok: true, items: [{ service: "Supabase", fields: [{ label: "계정 이메일", value: "a@b.com" }] }] });
  });

  it("빈 칸은 버리고, 전부 빈 행은 통째로 버린다", () => {
    const r = parseIntakeSubmission({
      items: [item("도메인", [{ label: "비밀번호", value: "  " }, { label: "", value: "x" }]), item("Supabase", [{ label: "ID", value: "u" }])],
    });
    expect(r.ok && r.items.map((i) => i.service)).toEqual(["Supabase"]);
  });

  it("아무 값도 없으면 거절", () => {
    expect(parseIntakeSubmission({ items: [item("도메인", [{ label: "ID", value: "" }])] })).toMatchObject({ ok: false });
    expect(parseIntakeSubmission({ items: [] })).toMatchObject({ ok: false });
  });

  it("형식이 아니면 거절", () => {
    for (const bad of [null, "x", 1, {}, { items: {} }, { items: [1] }, { items: [{ service: "a" }] }, { items: [{ service: "", fields: [] }] }]) {
      expect(parseIntakeSubmission(bad).ok).toBe(false);
    }
  });

  it("항목 상한", () => {
    const many = Array.from({ length: INTAKE_MAX_ITEMS + 1 }, (_, i) => item(`s${i}`, [{ label: "l", value: "v" }]));
    expect(parseIntakeSubmission({ items: many })).toMatchObject({ ok: false });
  });

  it("제어문자는 제거하되 줄바꿈·탭은 유지한다(백업코드 블록)", () => {
    const r = parseIntakeSubmission({ items: [item("2FA", [{ label: "백업코드", value: "a\u0000b\nc\td" }])] });
    expect(r.ok).toBe(true);
    const v = r.ok ? r.items[0].fields[0].value : "";
    expect(v).toBe("ab\nc\td");
  });

  it("값의 앞뒤 공백을 **보존한다** — 공백 있는 비밀번호를 조용히 바꾸지 않는다", () => {
    const r = parseIntakeSubmission({ items: [item("호스팅", [{ label: "비밀번호", value: "  p@ss  " }])] });
    expect(r.ok && r.items[0].fields[0].value).toBe("  p@ss  ");
  });

  it("공백만 있는 칸은 빈 칸으로 본다", () => {
    expect(parseIntakeSubmission({ items: [item("호스팅", [{ label: "비밀번호", value: "   " }])] }).ok).toBe(false);
  });

  it("값이 상한을 넘으면 **거절한다** — 잘라 저장하면 조용한 손상이 된다", () => {
    const r = parseIntakeSubmission({
      items: [item("2FA", [{ label: "백업코드", value: "x".repeat(INTAKE_MAX_VALUE_CHARS + 1) }])],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(String(INTAKE_MAX_VALUE_CHARS));
    expect(!r.ok && r.error).not.toContain("xxxx"); // 값 자체는 에러에 안 실린다
  });

  it("서비스명·라벨이 상한을 넘어도 거절한다", () => {
    expect(parseIntakeSubmission({ items: [item("s".repeat(121), [{ label: "l", value: "v" }])] }).ok).toBe(false);
    expect(parseIntakeSubmission({ items: [item("호스팅", [{ label: "l".repeat(121), value: "v" }])] }).ok).toBe(false);
  });

  it("서비스명·라벨의 줄바꿈은 공백으로 눕힌다(로그·목록 위조 방지)", () => {
    const r = parseIntakeSubmission({ items: [item("GitHub\n삭제함", [{ label: "ID\n", value: "u" }])] });
    expect(r.ok && r.items[0].service).toBe("GitHub 삭제함");
    expect(r.ok && r.items[0].fields[0].label).toBe("ID");
  });

  it("에러 메시지에 입력값이 실리지 않는다", () => {
    const r = parseIntakeSubmission({ items: [{ service: "도메인", fields: "hunter2" }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).not.toContain("hunter2");
  });
});

describe("allowSubmission — 제출 빈도 제한", () => {
  it("상한까지 허용하고 그다음부터 막는다", () => {
    const s: RateState = new Map();
    const k = rateKey("cs1", "g@gmail.com");
    for (let i = 0; i < INTAKE_RATE_LIMIT; i++) expect(allowSubmission(s, k, 1000)).toBe(true);
    expect(allowSubmission(s, k, 1000)).toBe(false);
  });

  it("창이 지나면 다시 허용", () => {
    const s: RateState = new Map();
    const k = rateKey("cs1", "g@gmail.com");
    for (let i = 0; i < INTAKE_RATE_LIMIT; i++) allowSubmission(s, k, 1000);
    expect(allowSubmission(s, k, 1000 + INTAKE_RATE_WINDOW_MS + 1)).toBe(true);
  });

  it("사이트·이메일이 다르면 서로 영향 없음", () => {
    const s: RateState = new Map();
    for (let i = 0; i < INTAKE_RATE_LIMIT; i++) allowSubmission(s, rateKey("cs1", "a@b.com"), 1000);
    expect(allowSubmission(s, rateKey("cs1", "a@b.com"), 1000)).toBe(false);
    expect(allowSubmission(s, rateKey("cs2", "a@b.com"), 1000)).toBe(true);
    expect(allowSubmission(s, rateKey("cs1", "c@d.com"), 1000)).toBe(true);
  });
});
