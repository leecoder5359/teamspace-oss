"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";

/* =====================================================================
   공유 범위 패널 (격차 D3) — 문서·보드 공통.

   화면에서 정직하게 밝혀야 하는 두 가지:
   - **관리자는 볼 수 있다.** 확정 정책이라 감출 게 아니라 적어야 한다. "여긴
     아무도 못 본다" 고 오해한 채 인사·평가를 적는 것이 최악이다.
   - **부여받은 사람에게 알림이 간다.** 조용한 공유는 공유가 아니다.
   ===================================================================== */

type Grant = {
  id: string;
  level: "view" | "edit";
  user?: { id: string; name: string | null; email: string | null } | null;
  team?: { id: string; name: string; color?: string } | null;
};
type Shares = { visibility: "inherit" | "restricted"; grants: Grant[]; canManage: boolean; adminBypass: boolean };
type Member = { id: string; role: string; user: { id: string; name: string | null; email: string | null } };
type Team = { id: string; name: string };

export default function SharePanel({ pageId, projectId }: { pageId?: string; projectId?: string }) {
  const base = pageId ? `/api/pages/${pageId}/grants` : `/api/projects/${projectId}/grants`;
  const label = pageId ? "이 문서" : "이 프로젝트";

  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Shares | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [subject, setSubject] = useState("");
  const [level, setLevel] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 첫 문장이 await 여야 한다 — 이펙트 본문에서 동기적으로 setState 하면
  // react-hooks/set-state-in-effect 가 잡는다(연쇄 렌더 방지 규칙).
  const load = useCallback(async () => {
    try {
      const r = await fetch(base);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const next = (await r.json()) as Shares;
      setData(next);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [base]);

  // 이 레포의 로드 이펙트 관례를 따른다: 인라인 async IIFE + cancelled 가드
  // (이펙트 본문에서 동기 setState 를 하지 않는다 — react-hooks/set-state-in-effect).
  // 잠금 상태는 **열지 않아도** 보여야 한다 — 비공개인 줄 모르고 쓰는 게 제일 위험하다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      void cancelled;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
      // 부여 대상 후보. 열 때 한 번만 받는다.
      const [m, t] = await Promise.all([
        fetch("/api/members").then((r) => r.json()).catch(() => ({})),
        fetch("/api/teams").then((r) => r.json()).catch(() => ({})),
      ]);
      if (cancelled) return;
      setMembers((m as { members?: Member[] }).members ?? []);
      setTeams((t as { teams?: Team[] }).teams ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, load]);

  async function call(method: string, path: string, body?: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      // 실패를 삼키지 않는다 — 권한 UI 가 조용히 실패하면 공유된 줄 알고 넘어간다.
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const restricted = data?.visibility === "restricted";
  const canManage = data?.canManage ?? false;

  return (
    <div style={{ marginTop: 24, borderTop: "1px solid var(--border-subtle)", paddingTop: 16 }}>
      <button
        className="ws-btn-soft"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Icon name={restricted ? "lock" : "users"} size={14} />
        공유 {restricted && <span style={{ color: "#E0900F", fontWeight: 700 }}>· 비공개</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>

      {open && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          {err && <p style={{ color: "#D14343", fontSize: 12.5 }}>{err}</p>}
          {!data && !err && <div className="ws-empty-hint">불러오는 중…</div>}

          {data && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={restricted}
                    disabled={!canManage || busy}
                    onChange={(e) =>
                      call("PATCH", base, { visibility: e.target.checked ? "restricted" : "inherit" })
                    }
                  />
                  {label}를 비공개로 (아래 목록에 있는 사람만)
                </label>
              </div>

              {data.grants.length === 0 && (
                <p className="ws-empty-hint" style={{ marginBottom: 10 }}>
                  {restricted ? "아직 아무에게도 공유하지 않았습니다." : "부여된 권한이 없습니다(위 설정을 따릅니다)."}
                </p>
              )}
              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
                {data.grants.map((g) => (
                  <li
                    key={g.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}
                  >
                    <Icon name={g.team ? "users" : "user"} size={13} />
                    <span style={{ flex: 1 }}>
                      {g.team ? `#${g.team.name}` : (g.user?.name ?? g.user?.email ?? "(알 수 없음)")}
                    </span>
                    <span style={{ color: "var(--text-disabled)", fontSize: 12 }}>
                      {g.level === "edit" ? "편집" : "보기"}
                    </span>
                    {canManage && (
                      <button
                        className="ws-btn-soft"
                        disabled={busy}
                        onClick={() => call("DELETE", `${base}?grantId=${g.id}`)}
                        style={{ padding: "2px 8px", fontSize: 12 }}
                      >
                        회수
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {canManage && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <select
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border-subtle)" }}
                  >
                    <option value="">사람·팀 선택…</option>
                    <optgroup label="멤버">
                      {members.map((m) => (
                        <option key={m.user.id} value={`u:${m.user.id}`}>
                          {m.user.name ?? m.user.email}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="팀">
                      {teams.map((t) => (
                        <option key={t.id} value={`t:${t.id}`}>
                          #{t.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <select
                    value={level}
                    onChange={(e) => setLevel(e.target.value as "view" | "edit")}
                    style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border-subtle)" }}
                  >
                    <option value="view">보기</option>
                    <option value="edit">편집</option>
                  </select>
                  <button
                    className="ws-btn-soft"
                    disabled={!subject || busy}
                    onClick={() =>
                      call("POST", base, {
                        userId: subject.startsWith("u:") ? subject.slice(2) : undefined,
                        teamId: subject.startsWith("t:") ? subject.slice(2) : undefined,
                        level,
                      }).then(() => setSubject(""))
                    }
                  >
                    공유
                  </button>
                </div>
              )}

              <p style={{ marginTop: 12, fontSize: 12, color: "var(--text-disabled)", lineHeight: 1.6 }}>
                {data.adminBypass && "워크스페이스 관리자는 비공개 문서도 볼 수 있습니다(잠금 방지). "}
                사람에게 공유하면 알림이 갑니다. 하위 문서는 이 설정을 물려받고, 하위에 따로 부여하면 그쪽이 우선합니다.
                {!canManage && " 범위를 바꾸려면 편집 권한이 필요합니다."}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
