"use client";

import { Icon } from "../ws/icons";
import { filterKindOf, OPS_BY_KIND, OP_LABEL, type FilterGroup, type FilterOp } from "@/lib/dbFilter";
import type { DbProperty } from "./useBoardData";

/* ===== 복합 필터 패널 (T-4b — DatabaseView 에서 분리) =====
   AND/OR 와 연산자를 쓰는 필터. 상태는 없다 — 바뀐 그룹을 onChange 로 넘기면 화면이 뷰에 저장한다. */
export default function FilterPanel({
  properties,
  filter,
  onChange,
}: {
  properties: DbProperty[];
  filter: FilterGroup | null;
  /** 바뀐 필터(null = 전체 해제). 저장·실패 알림은 호출 쪽 몫 */
  onChange: (next: FilterGroup | null) => void;
}) {
  return (
    <details className="ws-filter-builder" style={{ position: "relative" }}>
      <summary
        className="ws-db-filter"
        style={{ cursor: "pointer", listStyle: "none", userSelect: "none" }}
        title="AND/OR 와 연산자를 쓰는 필터 — 뷰에 저장된다"
      >
        필터{filter?.rules.length ? ` ${filter.rules.length}` : ""}
      </summary>
      <div
        className="ws-filter-pop"
        style={{
          background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
          borderRadius: 10, padding: 10, boxShadow: "var(--shadow-md, 0 6px 20px rgba(0,0,0,.12))",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <select
            className="ws-db-filter"
            value={filter?.conj ?? "and"}
            onChange={(e) =>
              onChange({ conj: e.target.value as "and" | "or", rules: filter?.rules ?? [] })
            }
            aria-label="조건 결합"
          >
            <option value="and">모두 만족(AND)</option>
            <option value="or">하나라도(OR)</option>
          </select>
          <span style={{ flex: 1 }} />
          {!!filter?.rules.length && (
            <button className="ws-btn-soft" onClick={() => onChange(null)}>
              전체 해제
            </button>
          )}
        </div>

        {(filter?.rules ?? []).map((rule, i) => {
          const prop = properties.find((p) => p.id === rule.propId);
          const kind = filterKindOf(prop?.type ?? "text");
          const ops = OPS_BY_KIND[kind] as readonly FilterOp[];
          const needsValue = !["empty", "notEmpty", "checked", "unchecked"].includes(rule.op);
          const patch = (next: Partial<typeof rule>) => {
            const rules = (filter?.rules ?? []).map((r, j) => (j === i ? { ...r, ...next } : r));
            onChange({ conj: filter?.conj ?? "and", rules });
          };
          return (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6, alignItems: "center" }}>
              <select
                className="ws-db-filter"
                value={rule.propId}
                onChange={(e) => {
                  // 속성이 바뀌면 연산자가 안 맞을 수 있다 — 그 종류의 첫 연산자로 되돌린다
                  const nk = filterKindOf(properties.find((p) => p.id === e.target.value)?.type ?? "text");
                  patch({ propId: e.target.value, op: OPS_BY_KIND[nk][0] as FilterOp, value: null });
                }}
                aria-label="속성"
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                className="ws-db-filter"
                value={rule.op}
                onChange={(e) => patch({ op: e.target.value as FilterOp })}
                aria-label="연산자"
              >
                {ops.map((o) => (
                  <option key={o} value={o}>{OP_LABEL[o]}</option>
                ))}
              </select>
              {needsValue &&
                (kind === "select" && prop?.config?.options?.length ? (
                  <select
                    className="ws-db-filter"
                    value={String(rule.value ?? "")}
                    onChange={(e) => patch({ value: e.target.value || null })}
                    aria-label="값"
                  >
                    <option value="">(선택)</option>
                    {prop.config.options.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="ws-db-filter"
                    type={kind === "date" ? "date" : kind === "number" ? "number" : "text"}
                    value={String(rule.value ?? "")}
                    onChange={(e) => patch({ value: e.target.value || null })}
                    placeholder="값"
                    aria-label="값"
                    style={{ minWidth: 110 }}
                  />
                ))}
              <button
                className="ws-row-del"
                title="이 조건 삭제"
                onClick={() =>
                  onChange({
                    conj: filter?.conj ?? "and",
                    rules: (filter?.rules ?? []).filter((_, j) => j !== i),
                  })
                }
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          );
        })}

        <button
          className="ws-btn-soft"
          onClick={() => {
            const first = properties[0];
            if (!first) return;
            const k = filterKindOf(first.type);
            onChange({
              conj: filter?.conj ?? "and",
              rules: [...(filter?.rules ?? []), { propId: first.id, op: OPS_BY_KIND[k][0] as FilterOp, value: null }],
            });
          }}
        >
          + 조건 추가
        </button>
      </div>
    </details>
  );
}
