import { describe, it, expect } from "vitest";
import { isPacked, packRows, unpackRows } from "./rowPack";

describe("rowPack — 열 행렬 왕복", () => {
  it("되돌리면 원래 배열과 같다(null·false·0·빈 문자열 유지)", () => {
    const rows = [
      { id: "a", icon: null, n: 0, f: false, s: "" },
      { id: "b", icon: "📄", n: 3, f: true, s: "x" },
    ];
    const p = packRows(rows);
    expect(p.cols).toEqual(["id", "icon", "n", "f", "s"]);
    expect(unpackRows(p)).toEqual(rows);
  });

  it("일부 행에만 있는 키는 없는 행에서 없는 키로 남는다(undefined 키 생기지 않음)", () => {
    const rows: { id: string; archived?: true }[] = [{ id: "a" }, { id: "b", archived: true }];
    const back = unpackRows<(typeof rows)[number]>(JSON.parse(JSON.stringify(packRows(rows))));
    expect(back).toEqual(rows);
    expect("archived" in back[0]).toBe(false);
  });

  it("JSON 왕복 뒤에도 같고, 크기는 줄어든다", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, title: `t${i}`, restrictedSelf: false, isFavorite: false }));
    const wire = JSON.stringify(packRows(rows));
    expect(unpackRows(JSON.parse(wire))).toEqual(rows);
    expect(wire.length).toBeLessThan(JSON.stringify(rows).length * 0.6);
  });

  it("isPacked 는 행렬 모양만 참", () => {
    expect(isPacked(packRows([{ a: 1 }]))).toBe(true);
    expect(isPacked([{ a: 1 }])).toBe(false);
    expect(isPacked(null)).toBe(false);
  });
});
