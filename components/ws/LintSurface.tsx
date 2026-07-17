"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";

/* wiki-lint surface — 깨진 위키링크 + 고아 문서 점검. /api/lint. */

type Lint = {
  broken: { sourceId: string; sourceTitle: string; target: string }[];
  orphans: { id: string; title: string }[];
};

export default function LintSurface() {
  const router = useRouter();
  const [data, setData] = useState<Lint | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/lint", { cache: "no-store" });
      setData((await res.json()) as Lint);
    })();
  }, []);

  if (data === null) return <div className="ws-db" style={{ padding: 40 }} />;
  const clean = data.broken.length === 0 && data.orphans.length === 0;

  return (
    <div className="ws-db" style={{ maxWidth: 760 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="alert" /> 위키 점검
      </h1>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
        깨진 위키링크 {data.broken.length} · 고아 문서 {data.orphans.length}
      </p>

      {clean ? (
        <div className="ws-docs-empty" style={{ marginTop: 24 }}>
          <span style={{ color: "var(--color-success, #12B886)" }}><Icon name="check" size={32} /></span>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>문제 없음</div>
          <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>깨진 링크도, 고아 문서도 없어요.</div>
        </div>
      ) : (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 24 }}>
          {/* 깨진 링크 */}
          <section>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="link" size={14} /> 깨진 링크 {data.broken.length}
            </div>
            {data.broken.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>없음</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {data.broken.map((b, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", border: "1px solid var(--border-subtle)", borderRadius: 9, background: "var(--surface-card)", fontSize: 13 }}>
                    <button onClick={() => router.push(`/p/${b.sourceId}`)} style={{ border: "none", background: "transparent", color: "var(--color-primary)", fontWeight: 600, cursor: "pointer", padding: 0, font: "inherit" }}>{b.sourceTitle}</button>
                    <span style={{ color: "var(--text-muted)" }}>→</span>
                    <span style={{ color: "var(--text-strong)" }}>[[{b.target}]]</span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#c0392b" }}>대상 문서 없음</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 고아 문서 */}
          <section>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="doc" size={14} /> 고아 문서 {data.orphans.length} <span style={{ fontWeight: 500 }}>(드나드는 링크 없음)</span>
            </div>
            {data.orphans.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>없음</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {data.orphans.map((o) => (
                  <button key={o.id} onClick={() => router.push(`/p/${o.id}`)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 8, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                    <Icon name="doc" size={13} /> {o.title}
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
