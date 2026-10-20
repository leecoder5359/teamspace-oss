"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { badge, card } from "./LessonsSurface";

/* 팀원 레슨 — 다른 멤버가 공개한 개인 레슨을 사람별로 보고 골라 가져온다(pull). 가져온 레슨은 내 개인 레슨이 되어
   내 세션에만 주입된다. 원본과는 독립(구독 아님). 읽기 전용 — 수정·삭제는 작성자만. */

type TeammateLesson = {
  id: string;
  title: string;
  body: string;
  author: { id: string; name: string };
  /** 내가 이미 가져온 복사본 id(없으면 null) */
  copiedId: string | null;
  updatedAt: string;
};

export default function LessonsTeammates() {
  const [list, setList] = useState<TeammateLesson[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/lessons?scope=teammates", { cache: "no-store" });
    if (res.ok) setList(((await res.json()) as { lessons: TeammateLesson[] }).lessons);
    else setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "불러오지 못했습니다.");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function copy(id: string) {
    setBusy(id);
    setErr(null);
    try {
      const res = await fetch(`/api/lessons/${id}/copy`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { lesson?: { id: string }; lessonId?: string | null; error?: string };
      // 409 = 이미 가져온 레슨 — 같은 결과로 표시한다
      if (res.ok || res.status === 409) {
        const copiedId = j.lesson?.id ?? j.lessonId ?? "copied";
        setList((cur) => (cur ?? []).map((l) => (l.id === id ? { ...l, copiedId } : l)));
      } else setErr(j.error ?? "가져오지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; items: TeammateLesson[] }>();
    for (const l of list ?? []) {
      const g = m.get(l.author.id) ?? { id: l.author.id, name: l.author.name, items: [] };
      g.items.push(l);
      m.set(l.author.id, g);
    }
    return [...m.values()];
  }, [list]);

  if (list === null && !err) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px 60px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px" }}>
          팀원이 공개한 <b>개인 레슨</b>입니다. 가져오면 내 개인 레슨으로 복사되어 내 세션에만 주입됩니다. (CLI: <code>pnpm ws lesson copy &lt;id&gt;</code>)
        </p>
        {err && <div style={{ fontSize: 12.5, color: "var(--color-danger)", marginBottom: 10 }}>{err}</div>}
        {groups.length === 0 ? (
          <div className="ws-docs-empty">
            <span style={{ color: "var(--text-muted)" }}><Icon name="users" size={32} /></span>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>팀원이 공개한 레슨이 없어요</div>
            <div style={{ fontSize: "var(--ds-fs-md)", color: "var(--text-sub)", marginTop: 6 }}>팀원이 내 레슨 탭에서 개인 레슨을 만들면 여기에 보입니다.</div>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.id} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: "var(--ds-fs-md)", fontWeight: 700, color: "var(--text-strong)", margin: "0 0 8px" }}>
                <span>{g.name}</span> <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{g.items.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {g.items.map((l) => (
                  <div key={l.id} style={{ ...card, gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "flex", color: "var(--color-primary)" }}><Icon name="flag" size={15} /></span>
                      <span style={{ fontSize: "var(--ds-fs-base)", fontWeight: 700, color: "var(--text-strong)", flex: 1 }}>{l.title}</span>
                      {l.copiedId ? (
                        <span style={badge}>가져옴</span>
                      ) : (
                        <button className="ws-btn-soft" disabled={busy === l.id} onClick={() => void copy(l.id)}>가져오기</button>
                      )}
                    </div>
                    <div style={{ fontSize: "var(--ds-fs-md)", color: "var(--text-body)", whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{l.body}</div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
