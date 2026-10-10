"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Pill, Table, Sub, td, tdNum, rowStyle, hint, empty, inputStyle } from "./AiRoutes";

/* =====================================================================
   설정 › 스킬 레지스트리 (관리자) — GET /api/skills/registry · /diff.
   같은 스킬(SKILL.md)이 레포·워크트리·전역·플러그인에 흩어진 사본을 묶어
   기준본과 같은지·낡았는지 보여 주고, 두 사본을 줄 단위로 비교한다.
   보고만 한다(사본을 고치지 않음). 표·알약·접기는 기존 설정 화면 패턴 그대로.
   ===================================================================== */

type Status = "canonical" | "same" | "differs_newer" | "stale";
type Copy = {
  id: string;
  path: string;
  name: string;
  description: string | null;
  lines: number;
  mtime: string;
  kind: "repo" | "worktree" | "global" | "plugin" | "other";
  scope: string;
  repo: string | null;
  branch: string | null;
  checkout: string | null;
  status: Status;
};
type Group = { key: string; name: string; scope: string; canonicalId: string; copies: Copy[]; distinct: number; stale: number; differs: number };
type Data =
  | { configured: false }
  | {
      configured: true;
      scannedAt: string;
      scan: { truncated: boolean; truncatedReason: string | null; durationMs: number; dirsVisited: number; errors: number; maxDepth: number; roots: { path: string; exists: boolean }[] };
      summary: { groups: number; copies: number; staleCopies: number; groupsWithStale: number; differingCopies: number };
      groups: Group[];
    };
type Diff = { lines: string[]; added: number; removed: number; truncated: boolean; identical: boolean };

const GOOD = "#12B886";
const WARN = "#F5A623";
const BAD = "#C0392B";
const BLUE = "#4c8bf5";

const STATUS: Record<Status, { label: string; color: string }> = {
  canonical: { label: "기준본", color: BLUE },
  same: { label: "같음", color: GOOD },
  differs_newer: { label: "다름 · 더 새것", color: WARN },
  stale: { label: "낡음", color: BAD },
};
const KIND: Record<Copy["kind"], string> = { repo: "레포", worktree: "워크트리", global: "전역", plugin: "플러그인", other: "기타" };

const n = (x: number) => x.toLocaleString("ko-KR");
const day = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const scopeLabel = (s: string) => (s === "global" ? "전역" : s === "other" ? "기타" : s.startsWith("repo:") ? `레포 ${s.slice(5)}` : s.startsWith("plugin:") ? `플러그인 ${s.slice(7)}` : s);

type Filter = "all" | "stale" | "differs";

async function fetchRegistry(refresh: boolean): Promise<{ data: Data | null; error: string | null }> {
  const res = await fetch(`/api/skills/registry${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }).catch(() => null);
  if (!res) return { data: null, error: "불러오지 못했습니다." };
  const d = (await res.json().catch(() => ({}))) as Data & { error?: string };
  if (!res.ok) return { data: null, error: d.error ?? "불러오지 못했습니다." };
  return { data: d, error: null };
}

export default function SkillRegistry() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchRegistry(false).then((r) => {
      if (!alive) return;
      setError(r.error);
      if (r.data) setData(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  const rescan = async () => {
    setLoading(true);
    const r = await fetchRegistry(true);
    setLoading(false);
    setError(r.error);
    if (r.data) setData(r.data);
  };

  const groups = useMemo(() => {
    if (!data?.configured) return [];
    const needle = q.trim().toLowerCase();
    return data.groups.filter(
      (g) => (filter === "all" || (filter === "stale" ? g.stale > 0 : g.differs > 0)) && (!needle || g.name.toLowerCase().includes(needle)),
    );
  }, [data, filter, q]);

  if (error) return <p style={{ ...hint, color: "var(--text-body)" }}>{error}</p>;
  if (!data) return <p style={hint}>불러오는 중…</p>;
  if (!data.configured)
    return (
      <p style={{ ...hint, marginTop: 0 }}>
        이 서버에는 스캔할 폴더가 정해져 있지 않아 꺼져 있습니다. 서버 env <code>SKILL_SCAN_ROOTS</code>(콜론 구분, 예 <code>~/dev:~/.claude</code>)를 넣으면 켜집니다.
      </p>
    );

  const s = data.summary;
  // 사본이 모두 같은 스킬은 접어 둔다 — 볼 일이 있는 것만 위에
  const busy = groups.filter((g) => g.differs > 0);
  const calm = groups.filter((g) => g.differs === 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <p style={{ ...hint, marginTop: 0, flex: 1, minWidth: 200 }}>
          같은 스킬이 레포·워크트리·전역·플러그인에 흩어진 사본입니다. 기준본은 레포 메인 폴더의 사본(없으면 가장 최근 것)이고, 기준본과 내용이 다르면서 더 오래된 사본을 낡은 사본으로 봅니다. 고치지는 않고 보여 주기만 합니다. CLI: <code>pnpm ws skills</code>
        </p>
        <button type="button" onClick={() => void rescan()} disabled={loading} style={ghostBtn}>
          {loading ? "스캔 중…" : "다시 스캔"}
        </button>
      </div>

      <p style={{ fontSize: 13, color: "var(--text-strong)", fontWeight: 600, margin: "0 0 4px" }}>
        스킬 {n(s.groups)} · 사본 {n(s.copies)} · 낡은 사본 <span style={{ color: s.staleCopies ? BAD : undefined }}>{n(s.staleCopies)}</span>
        {s.differingCopies - s.staleCopies > 0 && <span style={{ fontWeight: 500, color: "var(--text-muted)" }}> · 기준본보다 새 사본 {n(s.differingCopies - s.staleCopies)}</span>}
      </p>
      <p style={{ ...hint, marginTop: 0, marginBottom: 10 }}>
        {day(data.scannedAt)} 스캔 · {data.scan.roots.map((r) => `${r.path}${r.exists ? "" : "(없음)"}`).join(", ")} · 깊이 {data.scan.maxDepth} · 폴더 {n(data.scan.dirsVisited)}개 · {n(data.scan.durationMs)}ms
        {data.scan.truncated && <span style={{ color: BAD }}> · 한도에 닿아 중간에 멈췄습니다 — 일부 사본이 빠졌을 수 있습니다</span>}
      </p>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <FilterBtn active={filter === "all"} onClick={() => setFilter("all")} label="전체" />
        <FilterBtn active={filter === "stale"} onClick={() => setFilter("stale")} label={`낡은 것만 ${n(s.groupsWithStale)}`} />
        <FilterBtn active={filter === "differs"} onClick={() => setFilter("differs")} label="다른 사본 있음" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 검색" aria-label="스킬 이름 검색" style={{ ...inputStyle, padding: "5px 10px", fontSize: 12.5, flex: "1 1 140px", minWidth: 0, maxWidth: 240 }} />
      </div>

      {groups.length === 0 && <p style={empty}>조건에 맞는 스킬이 없습니다.</p>}

      {busy.length > 0 && (
        <Sub label={`사본 내용이 다른 스킬 ${n(busy.length)}개`}>
          <GroupTable groups={busy} open={open} setOpen={setOpen} />
        </Sub>
      )}
      {calm.length > 0 && (
        <details open={busy.length === 0 && calm.length <= 10}>
          <summary style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", cursor: "pointer", marginBottom: 8 }}>사본이 모두 같은 스킬 {n(calm.length)}개</summary>
          <GroupTable groups={calm} open={open} setOpen={setOpen} />
        </details>
      )}
    </div>
  );
}

function GroupTable({ groups, open, setOpen }: { groups: Group[]; open: string | null; setOpen: (k: string | null) => void }) {
  return (
    // 3열로 좁게 — 폰(375px)에서도 표가 카드 폭 안에 들어와야 펼친 사본 목록이 가로로 밀리지 않는다
    <Table head={["스킬 · 범위", "사본 · 내용", "상태"]} numericFrom={1}>
      {groups.map((g) => {
        const isOpen = open === g.key;
        return (
          <Fragment key={g.key}>
            <tr style={{ ...rowStyle, cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : g.key)} aria-expanded={isOpen}>
              <td style={{ ...td, wordBreak: "break-word" }}>
                <div style={{ display: "flex", gap: 4, fontWeight: 600, color: "var(--text-strong)" }}>
                  <span style={{ flex: "none", width: 12, color: "var(--text-muted)" }}>{isOpen ? "▾" : "▸"}</span>
                  <span style={{ minWidth: 0 }}>{g.name}</span>
                </div>
                <div style={{ marginLeft: 16, fontSize: 11.5, color: "var(--text-muted)", wordBreak: "break-all" }}>{scopeLabel(g.scope)}</div>
              </td>
              <td style={tdNum}>
                {n(g.copies.length)} · {n(g.distinct)}종
              </td>
              <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                {g.stale > 0 ? <Pill color={BAD} label={`낡음 ${g.stale}`} /> : g.differs > 0 ? <Pill color={WARN} label={`다름 ${g.differs}`} /> : <Pill color={GOOD} label="모두 같음" />}
              </td>
            </tr>
            {isOpen && (
              <tr style={rowStyle}>
                <td colSpan={3} style={{ ...td, padding: "4px 12px 12px", background: "color-mix(in srgb, var(--surface-card) 92%, var(--text-muted))" }}>
                  <Copies group={g} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </Table>
  );
}

function Copies({ group }: { group: Group }) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const canon = group.copies.find((c) => c.id === group.canonicalId);

  const compare = async (id: string) => {
    if (diffFor === id) {
      setDiffFor(null);
      return;
    }
    setDiffFor(id);
    setDiff(null);
    setDiffErr(null);
    const res = await fetch(`/api/skills/registry/diff?a=${group.canonicalId}&b=${id}`, { cache: "no-store" });
    const d = (await res.json().catch(() => ({}))) as { diff?: Diff; error?: string };
    if (!res.ok || !d.diff) setDiffErr(d.error ?? "비교하지 못했습니다.");
    else setDiff(d.diff);
  };

  return (
    <div>
      {canon?.description && <p style={{ ...hint, marginTop: 6 }}>{canon.description}</p>}
      {group.copies.map((c) => (
        <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pill color={STATUS[c.status].color} label={STATUS[c.status].label} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-strong)" }}>
              {KIND[c.kind]}
              {c.repo ? ` · ${c.repo}` : ""}
            </span>
            {c.branch && <span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{c.branch}</span>}
            <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
              {n(c.lines)}줄 · {day(c.mtime)} 수정
            </span>
            {c.status !== "canonical" && c.status !== "same" && (
              <button type="button" onClick={() => void compare(c.id)} style={{ ...ghostBtn, padding: "3px 10px", fontSize: 12, marginLeft: "auto" }} aria-pressed={diffFor === c.id}>
                {diffFor === c.id ? "비교 닫기" : "기준본과 비교"}
              </button>
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-body)", wordBreak: "break-all" }}>{c.path}</div>
          {diffFor === c.id && (
            <div style={{ marginTop: 8 }}>
              {diffErr && <p style={{ ...empty, color: BAD }}>{diffErr}</p>}
              {!diff && !diffErr && <p style={empty}>비교하는 중…</p>}
              {diff && diff.identical && <p style={empty}>지금은 기준본과 내용이 같습니다(스캔 뒤에 바뀜).</p>}
              {diff && !diff.identical && (
                <>
                  <p style={{ ...empty, marginBottom: 6 }}>
                    기준본에서 이 사본으로: 더해진 줄 <b style={{ color: GOOD }}>{n(diff.added)}</b> · 빠진 줄 <b style={{ color: BAD }}>{n(diff.removed)}</b>
                    {diff.truncated ? " · 길어서 400줄까지만 보여 줍니다" : ""}
                  </p>
                  <pre style={preStyle}>
                    {diff.lines.map((l, i) => (
                      <span key={i} style={{ display: "block", color: l.startsWith("@@") ? BLUE : l.startsWith("+") && !l.startsWith("+++") ? GOOD : l.startsWith("-") && !l.startsWith("---") ? BAD : undefined }}>
                        {l || " "}
                      </span>
                    ))}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* 레슨 주입 점검의 FilterBtn 과 같은 모양 */
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

/* 설정 화면의 ghostBtn 과 같은 모양 */
const ghostBtn: CSSProperties = {
  padding: "6px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", whiteSpace: "nowrap",
};
/* 레슨 주입 점검의 미리보기 pre 와 같은 모양 */
const preStyle: CSSProperties = {
  margin: 0, padding: 12, borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: 11.5, lineHeight: 1.55,
  whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 420, overflow: "auto", color: "var(--text-body)", fontFamily: "var(--font-mono)",
};
