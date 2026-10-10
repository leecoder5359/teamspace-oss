"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ProgressBar, IdChip } from "./ui";
import { Pill, Table, Sub, td, tdNum, rowStyle, hint, empty, inputStyle } from "./AiRoutes";

/* =====================================================================
   설정 › 레슨 주입 점검(편집자 이상) — GET /api/lessons/inspect · /api/lessons/injections.
   세션 시작 주입에서 어떤 레슨이 요약·제목만·잘림으로 들어가는지(시뮬레이터),
   어느 cwd·프로젝트가 연결이 빠졌는지(연결 점검), 주입이 실제로 일어났는지(주입 기록),
   무엇을 정리하면 좋을지(정리 후보)를 본다. 표·알약·막대는 기존 설정 화면 패턴 그대로.
   ===================================================================== */

type Status = "gist" | "title" | "omitted" | "not_applicable";
type Scope = "project" | "stack" | "global";
type Inspect = {
  resolved: { resolution: "cwd" | "project_rule" | "project_unmapped" | "none"; cwd: string | null; projectId: string | null; projectName: string | null; projectStack: string[] };
  budget: { contextBudget: number; lessonMinBudget: number; lessonBudget: number | null; lessonChars: number; restChars: number; totalChars: number };
  sections: { kind: Scope; tag: string | null; count: number; budget: number | null; used: number; gist: number; title: number; omitted: number }[];
  preview: string;
  statusCounts: Record<Status, number>;
  lessons: { id: string; title: string; scope: Scope; projectName: string | null; stack: string | null; status: Status; reason: "other_project" | "stack_mismatch" | null }[];
  linkChecks: {
    windowDays: number;
    unmappedCwds: { cwd: string; count: number; lastAt: string }[];
    emptyStackProjects: { id: string; name: string; mapped: boolean; missedStackLessons: number }[];
    orphanStackLessons: { id: string; title: string; stack: string }[];
    brokenRouteRules: { id: string; cwdPrefix: string; projectId: string }[];
  };
  projects: { id: string; name: string; stack: string[] }[];
};
type Injections = {
  days: number;
  totals: { injections: number; last7: number; reads: number };
  byProject: { projectId: string | null; projectName: string | null; last7: number; lastN: number }[];
  recent: { id: string; at: string; actorName: string | null; cwd: string | null; projectName: string | null; via: string; mode: string; gist: number; titleOnly: number; omitted: number; chars: number }[];
  lessons: { id: string; title: string; scope: Scope; gist: number; titleOnly: number; omitted: number; reads: number }[];
  cleanup: {
    alwaysTruncated: { id: string; title: string; titleOnly: number; omitted: number }[];
    neverInjected: { id: string; title: string; scope: Scope; stack: string | null }[];
    similarTitles: { a: { id: string; title: string }; b: { id: string; title: string }; score: number }[];
  };
  truncated: boolean;
};

const GOOD = "#12B886";
const WARN = "#F5A623";
const BAD = "#C0392B";
const MUTED = "#9AA0A6";

const STATUS: Record<Status, { label: string; color: string }> = {
  gist: { label: "요약 포함", color: GOOD },
  title: { label: "제목만", color: WARN },
  omitted: { label: "잘림", color: BAD },
  not_applicable: { label: "해당 없음", color: MUTED },
};
const SCOPE: Record<Scope, string> = { project: "프로젝트", stack: "스택", global: "전역" };
const REASON = { other_project: "다른 프로젝트", stack_mismatch: "스택 안 맞음" } as const;
const RESOLUTION: Record<Inspect["resolved"]["resolution"], string> = {
  cwd: "입력한 폴더로 계산",
  project_rule: "이 프로젝트에 연결된 폴더로 계산",
  project_unmapped: "이 프로젝트에 연결된 폴더가 없어 실제 세션에는 들어가지 않습니다. 연결했다면 이렇게 들어갑니다(추정).",
  none: "프로젝트가 없는 세션(워크스페이스 기본)으로 계산",
};

const n = (x: number) => x.toLocaleString("ko-KR");
const when = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const pctOf = (used: number, total: number | null) => (total ? (used / total) * 100 : 0);

export default function LessonInspect() {
  const [projectId, setProjectId] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwd, setCwd] = useState("");
  const [data, setData] = useState<Inspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const q = new URLSearchParams();
      if (cwd) q.set("cwd", cwd);
      else if (projectId) q.set("projectId", projectId);
      const res = await fetch(`/api/lessons/inspect${q.size ? `?${q}` : ""}`, { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as Inspect & { error?: string };
      if (!alive) return;
      if (!res.ok) return void setError(d.error ?? "불러오지 못했습니다.");
      setError(null);
      setData(d);
    })();
    return () => {
      alive = false;
    };
  }, [projectId, cwd]);

  const shown = data ? data.lessons.filter((l) => filter === "all" || l.status === filter) : [];
  const checks = data?.linkChecks;
  const warnCount = checks ? checks.unmappedCwds.length + checks.emptyStackProjects.length + checks.orphanStackLessons.length + checks.brokenRouteRules.length : 0;

  return (
    <div>
      <p style={{ ...hint, marginTop: 0, marginBottom: 12 }}>
        새 세션을 열 때 팀 규칙(레슨)이 어떻게 들어가는지 미리 봅니다. 글자 수가 정해져 있어서 일부는 제목만, 일부는 &lsquo;외 N개&rsquo;로만 들어갑니다. CLI: <code>pnpm ws lesson inspect</code>
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setCwd("");
            setCwdDraft("");
          }}
          style={{ ...inputStyle, minWidth: 0, flex: "1 1 160px" }}
          aria-label="프로젝트"
        >
          <option value="">프로젝트 없음(기본)</option>
          {(data?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <form
          style={{ display: "flex", gap: 8, flex: "2 1 240px", minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            setCwd(cwdDraft.trim());
          }}
        >
          <input value={cwdDraft} onChange={(e) => setCwdDraft(e.target.value)} placeholder="또는 폴더 경로(cwd)" style={{ ...inputStyle, flex: 1, minWidth: 0 }} aria-label="폴더 경로" />
          <button type="submit" style={ghostBtn}>
            보기
          </button>
        </form>
      </div>

      {error && <p style={{ ...hint, color: "var(--text-body)" }}>{error}</p>}
      {!data && !error && <p style={hint}>불러오는 중…</p>}

      {data && (
        <>
          <Sub label="대상">
            <div style={{ fontSize: 13, color: "var(--text-strong)", fontWeight: 600 }}>
              {data.resolved.projectName ?? "프로젝트 없음"}
              {data.resolved.projectStack.length > 0 && <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--text-muted)" }}>스택 {data.resolved.projectStack.join(", ")}</span>}
            </div>
            <p style={{ ...hint, marginTop: 4, color: data.resolved.resolution === "project_unmapped" ? WARN : hint.color }}>
              {RESOLUTION[data.resolved.resolution]}
              {data.resolved.cwd && (
                <>
                  {" "}
                  · <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{data.resolved.cwd}</span>
                </>
              )}
            </p>
          </Sub>

          <Sub label="글자 수 예산">
            <BudgetRow label={`세션 컨텍스트 전체 ${n(data.budget.totalChars)} / ${n(data.budget.contextBudget)}자`} value={pctOf(data.budget.totalChars, data.budget.contextBudget)} />
            <BudgetRow label={`그중 레슨 ${n(data.budget.lessonChars)}자 (레슨 몫 ${data.budget.lessonBudget === null ? "—" : n(data.budget.lessonBudget)}자)`} value={pctOf(data.budget.lessonChars, data.budget.lessonBudget)} />
            <div style={{ marginTop: 10 }}>
              <Table head={["구역", "레슨", "요약", "제목만", "잘림", "사용 / 몫"]} numericFrom={1}>
                {data.sections.map((s) => (
                  <tr key={`${s.kind}-${s.tag ?? ""}`} style={rowStyle}>
                    <td style={{ ...td, fontWeight: 600, color: "var(--text-strong)", whiteSpace: "nowrap" }}>
                      {SCOPE[s.kind]}
                      {s.tag ? `: ${s.tag}` : ""}
                    </td>
                    <td style={tdNum}>{n(s.count)}</td>
                    <td style={tdNum}>{n(s.gist)}</td>
                    <td style={tdNum}>{n(s.title)}</td>
                    <td style={{ ...tdNum, color: s.omitted ? BAD : undefined }}>{n(s.omitted)}</td>
                    <td style={{ ...tdNum, minWidth: 150 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                        <span>
                          {n(s.used)} / {s.budget === null ? "—" : n(s.budget)}
                        </span>
                        <ProgressBar value={pctOf(s.used, s.budget)} showLabel={false} />
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          </Sub>

          <Sub label={`레슨별 상태 (${n(data.lessons.length)}개)`}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <FilterBtn active={filter === "all"} onClick={() => setFilter("all")} label={`전체 ${n(data.lessons.length)}`} />
              {(Object.keys(STATUS) as Status[]).map((s) => (
                <FilterBtn key={s} active={filter === s} onClick={() => setFilter(s)} label={`${STATUS[s].label} ${n(data.statusCounts[s] ?? 0)}`} />
              ))}
            </div>
            {shown.length === 0 ? (
              <p style={empty}>해당하는 레슨이 없습니다.</p>
            ) : (
              <Table head={["상태", "레슨", "범위"]} numericFrom={9}>
                {shown.map((l) => (
                  <tr key={l.id} style={rowStyle}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <Pill color={STATUS[l.status].color} label={STATUS[l.status].label} />
                    </td>
                    <td style={{ ...td, minWidth: 200 }}>
                      <div style={{ color: "var(--text-strong)", fontWeight: 600 }}>{l.title}</div>
                      <div style={{ marginTop: 2 }}>
                        <IdChip id={l.id} />
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                      {SCOPE[l.scope]}
                      {l.scope === "project" && l.projectName ? ` · ${l.projectName}` : ""}
                      {l.scope === "stack" && l.stack ? ` · ${l.stack}` : ""}
                      {l.reason ? ` (${REASON[l.reason]})` : ""}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            <details style={{ marginTop: 10 }}>
              <summary style={{ fontSize: 12.5, cursor: "pointer", color: "var(--text-muted)" }}>실제로 들어가는 레슨 부분 미리보기</summary>
              <pre style={{ marginTop: 8, padding: 12, borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 420, overflow: "auto", color: "var(--text-body)" }}>
                {data.preview}
              </pre>
            </details>
          </Sub>

          <Sub label={`연결 점검${warnCount ? ` · 확인할 것 ${warnCount}건` : ""}`}>
            {checks && warnCount === 0 && <p style={empty}>문제 없습니다.</p>}
            {checks && warnCount > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-body)", lineHeight: 1.7 }}>
                {checks.unmappedCwds.map((c) => (
                  <li key={`u-${c.cwd}`}>
                    최근 {checks.windowDays}일 동안 세션이 열린 폴더가 프로젝트에 연결돼 있지 않습니다: <code style={{ wordBreak: "break-all" }}>{c.cwd}</code> ({n(c.count)}회, 마지막 {when(c.lastAt)}) — 프로젝트 레슨이 안 들어갑니다. <code>pnpm ws route-rule add</code>
                  </li>
                ))}
                {checks.brokenRouteRules.map((r) => (
                  <li key={`b-${r.id}`}>
                    폴더 연결 규칙이 없는 프로젝트를 가리킵니다: <code style={{ wordBreak: "break-all" }}>{r.cwdPrefix}</code> → <code>{r.projectId}</code>
                  </li>
                ))}
                {checks.emptyStackProjects.map((p) => (
                  <li key={`e-${p.id}`}>
                    <b>{p.name}</b> 프로젝트에 기술 스택이 비어 있어 스택 레슨 {n(p.missedStackLessons)}개를 받지 못합니다{p.mapped ? "" : "(폴더 연결도 없음)"}. <code>pnpm ws project set {p.id} --stack …</code>
                  </li>
                ))}
                {checks.orphanStackLessons.map((l) => (
                  <li key={`o-${l.id}`}>
                    스택 레슨 <b>{l.title}</b>({l.stack})은 이 스택을 쓰는 프로젝트가 없어 어디에도 들어가지 않습니다.
                  </li>
                ))}
              </ul>
            )}
          </Sub>

          <InjectionStats />
        </>
      )}
    </div>
  );
}

function InjectionStats() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Injections | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/lessons/injections?days=${days}`, { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as Injections & { error?: string };
      if (!alive) return;
      if (!res.ok) return void setError(d.error ?? "불러오지 못했습니다.");
      setError(null);
      setData(d);
    })();
    return () => {
      alive = false;
    };
  }, [days]);

  const top = data ? data.lessons.filter((l) => l.gist + l.titleOnly + l.omitted + l.reads > 0).sort((a, b) => b.reads - a.reads || b.gist - a.gist) : [];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "4px 0 12px", paddingTop: 14, borderTop: "1px solid var(--border-subtle)" }}>
        <p style={{ ...hint, marginTop: 0, flex: 1, minWidth: 200 }}>
          실제로 들어간 기록입니다. 레슨 내용은 저장하지 않고 어떤 레슨이 어떻게 들어갔는지만 셉니다. CLI: <code>pnpm ws lesson injections</code>
        </p>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={inputStyle} aria-label="기간">
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      </div>
      {error && <p style={{ ...hint, color: "var(--text-body)" }}>{error}</p>}
      {!data && !error && <p style={hint}>불러오는 중…</p>}
      {data && (
        <>
          <Sub label={`주입 횟수 · ${n(data.totals.injections)}회 (최근 7일 ${n(data.totals.last7)}회) · 에이전트가 전문을 읽은 횟수 ${n(data.totals.reads)}회`}>
            {data.byProject.length === 0 ? (
              <p style={empty}>이 기간에 기록이 없습니다. 세션을 새로 열면 쌓입니다.</p>
            ) : (
              <Table head={["프로젝트", "최근 7일", `최근 ${data.days}일`]} numericFrom={1}>
                {data.byProject.map((p) => (
                  <tr key={p.projectId ?? "-"} style={rowStyle}>
                    <td style={{ ...td, fontWeight: 600, color: p.projectId ? "var(--text-strong)" : "var(--text-muted)" }}>{p.projectName ?? (p.projectId ? p.projectId : "프로젝트 연결 없음")}</td>
                    <td style={tdNum}>{n(p.last7)}</td>
                    <td style={tdNum}>{n(p.lastN)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Sub>

          {data.recent.length > 0 && (
            <Sub label={`최근 주입 ${data.recent.length}건`}>
              <Table head={["시각", "프로젝트", "경로", "요약", "제목만", "잘림", "글자"]} numericFrom={3}>
                {data.recent.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--text-muted)" }}>{when(r.at)}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }} title={r.cwd ?? undefined}>
                      {r.projectName ?? "—"}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                      {r.via === "SessionStart" ? "세션 시작" : r.via === "PostToolUse" ? "다른 레포 작업" : "알 수 없음"}
                      {r.mode === "brief" ? " · 요약판" : ""}
                    </td>
                    <td style={tdNum}>{n(r.gist)}</td>
                    <td style={tdNum}>{n(r.titleOnly)}</td>
                    <td style={{ ...tdNum, color: r.omitted ? BAD : undefined }}>{n(r.omitted)}</td>
                    <td style={tdNum}>{n(r.chars)}</td>
                  </tr>
                ))}
              </Table>
            </Sub>
          )}

          {top.length > 0 && (
            <Sub label="레슨별 주입·조회">
              <details open={top.length <= 10}>
                <summary style={{ fontSize: 12.5, cursor: "pointer", color: "var(--text-muted)", marginBottom: 6 }}>{n(top.length)}개 레슨 (조회 많은 순)</summary>
                <Table head={["레슨", "요약", "제목만", "잘림", "조회"]} numericFrom={1}>
                  {top.map((l) => (
                    <tr key={l.id} style={rowStyle}>
                      <td style={{ ...td, minWidth: 180 }}>{l.title}</td>
                      <td style={tdNum}>{n(l.gist)}</td>
                      <td style={tdNum}>{n(l.titleOnly)}</td>
                      <td style={{ ...tdNum, color: l.omitted ? BAD : undefined }}>{n(l.omitted)}</td>
                      <td style={tdNum}>{n(l.reads)}</td>
                    </tr>
                  ))}
                </Table>
              </details>
            </Sub>
          )}

          <Sub label="정리 후보">
            <CandidateList
              title={`늘 잘림 — 이 기간 새 세션에서 요약으로 한 번도 안 들어감 (${data.cleanup.alwaysTruncated.length})`}
              items={data.cleanup.alwaysTruncated.map((l) => ({ key: l.id, text: l.title, id: l.id }))}
              none={data.totals.injections ? "없습니다." : "기록이 쌓이면 보입니다."}
            />
            <CandidateList
              title={`주입 0회 — 이 기간에 어떤 세션에도 대상이 아니었음 (${data.cleanup.neverInjected.length})`}
              items={data.cleanup.neverInjected.map((l) => ({ key: l.id, text: `${l.title} · ${SCOPE[l.scope]}${l.stack ? ` ${l.stack}` : ""}`, id: l.id }))}
              none={data.totals.injections ? "없습니다." : "기록이 쌓이면 보입니다."}
            />
            <CandidateList
              title={`제목이 비슷한 레슨 — 합치거나 지울 수 있는지 (${data.cleanup.similarTitles.length})`}
              items={data.cleanup.similarTitles.map((p) => ({ key: `${p.a.id}-${p.b.id}`, text: `${p.a.title} ↔ ${p.b.title} (${Math.round(p.score * 100)}%)` }))}
              none="없습니다."
            />
          </Sub>
        </>
      )}
    </>
  );
}

function BudgetRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
      <span style={{ fontSize: 12.5, color: "var(--text-body)", flex: "1 1 200px", minWidth: 0 }}>{label}</span>
      <span style={{ flex: "1 1 140px", display: "flex" }}>
        <ProgressBar value={value} />
      </span>
    </div>
  );
}

function FilterBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        ...ghostBtn,
        padding: "4px 10px",
        fontSize: 12,
        background: active ? "color-mix(in srgb, var(--color-primary) 12%, var(--surface-card))" : "var(--surface-card)",
        borderColor: active ? "var(--color-primary)" : "var(--border-default)",
      }}
    >
      {label}
    </button>
  );
}

function CandidateList({ title, items, none }: { title: string; items: { key: string; text: string; id?: string }[]; none: string }) {
  if (items.length === 0)
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>{title}</div>
        <p style={empty}>{none}</p>
      </div>
    );
  // 길면 접어 둔다(설정 화면 감사 로그와 같은 details 패턴)
  return (
    <details open={items.length <= 5} style={{ marginBottom: 12 }}>
      <summary style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, cursor: "pointer" }}>{title}</summary>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-body)", lineHeight: 1.7 }}>
        {items.map((it) => (
          <li key={it.key}>
            {it.text}
            {it.id && (
              <span style={{ marginLeft: 6 }}>
                <IdChip id={it.id} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/* 설정 화면의 ghostBtn 과 같은 모양 */
const ghostBtn: CSSProperties = {
  padding: "6px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", whiteSpace: "nowrap",
};
