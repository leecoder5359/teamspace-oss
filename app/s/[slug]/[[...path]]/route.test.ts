import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sites/server", () => ({ currentSlugForAlias: vi.fn() }));

import { auth } from "@/auth";
import { currentSlugForAlias } from "@/lib/sites/server";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const get = (path: string) => GET(new Request(`http://localhost:3000${path}`));

describe("옛 /s/[slug]/[[...path]] → /pages 308", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(auth).mockResolvedValue(null);
    m(currentSlugForAlias).mockResolvedValue(null);
  });

  it("슬러그만 → /pages/<slug>, 상대 Location", async () => {
    const res = await get("/s/banjang-handover");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/pages/banjang-handover");
  });

  it("하위 경로·해시 앞부분·쿼리를 원본 인코딩 그대로", async () => {
    const res = await get("/s/banjang-handover/supabase-setup?x=1");
    expect(res.headers.get("location")).toBe("/pages/banjang-handover/supabase-setup?x=1");
    const enc = await get(`/s/b-h/docs/${encodeURIComponent("설정 안내")}`);
    expect(enc.headers.get("location")).toBe(`/pages/b-h/docs/${encodeURIComponent("설정 안내")}`);
  });

  it("비로그인이면 별칭을 풀지 않는다(익명 별칭 조회 차단) — /pages 셸이 로그인 뒤 308", async () => {
    m(currentSlugForAlias).mockResolvedValue("banjang-handover");
    const res = await get("/s/MEzDPE2vDpXH/x");
    expect(res.headers.get("location")).toBe("/pages/MEzDPE2vDpXH/x");
    expect(currentSlugForAlias).not.toHaveBeenCalled();
  });

  it("로그인이면 옛 무작위 슬러그(별칭)를 현재 슬러그로 — 한 번에 정식 주소", async () => {
    m(auth).mockResolvedValue({ user: { email: "g@gmail.com" } });
    m(currentSlugForAlias).mockResolvedValue("banjang-handover");
    const res = await get("/s/MEzDPE2vDpXH/supabase-setup");
    expect(currentSlugForAlias).toHaveBeenCalledWith("MEzDPE2vDpXH");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/pages/banjang-handover/supabase-setup");
  });

  it("로그인했지만 별칭이 아니면(현재 슬러그·없는 슬러그) 같은 슬러그로", async () => {
    m(auth).mockResolvedValue({ user: { email: "g@gmail.com" } });
    const res = await get("/s/banjang-handover");
    expect(res.headers.get("location")).toBe("/pages/banjang-handover");
  });

  it("깨진 퍼센트 인코딩 → 404", async () => {
    const res = await get("/s/%E0%A4%A");
    expect(res.status).toBe(404);
  });
});
