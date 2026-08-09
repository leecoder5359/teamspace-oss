import { describe, it, expect } from "vitest";
import { repoLabel } from "@/lib/repo";

/* repoLabel: repo URL을 카드에 표시할 "owner/repo" 라벨로. 순수 함수. */

describe("repoLabel", () => {
  it("https GitHub URL → owner/repo", () => {
    expect(repoLabel("https://github.com/leecoder5359/crewpool")).toBe("leecoder5359/crewpool");
  });

  it(".git 접미사와 끝 슬래시 제거", () => {
    expect(repoLabel("https://github.com/leecoder5359/crewpool.git")).toBe("leecoder5359/crewpool");
    expect(repoLabel("https://github.com/leecoder5359/teamspace/")).toBe("leecoder5359/teamspace");
  });

  it("SSH 형식도 처리", () => {
    expect(repoLabel("git@github.com:leecoder5359/crewpool.git")).toBe("leecoder5359/crewpool");
  });

  it("빈 값/형식 불명 → 입력 그대로(트림)", () => {
    expect(repoLabel("")).toBe("");
    expect(repoLabel("  ")).toBe("");
    expect(repoLabel("just-a-name")).toBe("just-a-name");
  });
});
