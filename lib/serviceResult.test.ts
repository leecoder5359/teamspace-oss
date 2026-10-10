import { describe, it, expect } from "vitest";
import { fail, passthrough, failResponse } from "./serviceResult";

describe("serviceResult.failResponse", () => {
  it("fail → { error, ...extra } 본문과 상태 코드(ok·status 는 본문에 넣지 않는다)", async () => {
    const res = failResponse(fail(409, "충돌", { conflict: true, currentRev: 3 }));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(JSON.stringify({ error: "충돌", conflict: true, currentRev: 3 }));
  });

  it("passthrough → 가드가 만든 응답을 그대로", () => {
    const original = new Response("x", { status: 403 });
    expect(failResponse(passthrough(original))).toBe(original);
  });

  it("extra 는 ok·status·error 키를 쓸 수 없다(타입 오류 — tsc 가 검사)", () => {
    // @ts-expect-error status 는 예약 키
    fail(400, "x", { status: 200 });
    // @ts-expect-error error 는 예약 키
    fail(400, "x", { error: "덮어쓰기" });
    // @ts-expect-error ok 는 예약 키
    fail(400, "x", { ok: true });
    expect(fail(400, "x", { issues: [] }).status).toBe(400);
  });
});
