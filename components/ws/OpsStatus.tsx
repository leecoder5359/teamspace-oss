"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* =====================================================================
   설정 › 운영 상태 (관리자) — GET /api/ops/status.
   health·마지막 백업·디스크·오늘 AI 비용 4칸 + 경고 목록. 타일 모양은 AI 실행 경로의 비용 카드와 같다.
   ===================================================================== */

type Status = {
  checkedAt: string;
  health: { db: boolean; worker: boolean; workerAgeSec: number | null };
  backup: { dir: string; latest: string | null; ageHours: number | null; sizeBytes: number | null; inProgress?: boolean; clockSkew?: boolean };
  disk: { path: string; requestedPath: string; freeBytes: number; totalBytes: number; freeRatio: number } | null;
  llm: { todayTokens: number | null; todayUsd: number | null; budgetTokens: number; exceeded: boolean };
  build: { version: string; buildId: string | null };
};
type Warning = { level: "warn" | "crit"; code: string; message: string };

const WARN = "#F5A623";
const BAD = "#C0392B";
const GOOD = "#12B886";

const usd = (x: number | null) => (x === null ? "—" : `$${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)}`);
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)}GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)}MB`;

async function fetchStatus(): Promise<{ data: { status: Status; warnings: Warning[] } | null; error: string | null }> {
  try {
    const res = await fetch("/api/ops/status", { cache: "no-store" });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return { data: await res.json(), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "불러오지 못했습니다." };
  }
}

export default function OpsStatus() {
  const [data, setData] = useState<{ status: Status; warnings: Warning[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [tick, setTick] = useState(0);

  // setState 는 .then 콜백에서만 — effect 본문(과 그 안에서 부르는 함수)에서 동기 호출하면 연쇄 렌더가 난다.
  useEffect(() => {
    let alive = true;
    void fetchStatus().then((r) => {
      if (!alive) return;
      setError(r.error);
      if (r.data) setData(r.data);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [tick]);

  const refresh = () => {
    setLoading(true);
    setTick((t) => t + 1);
  };

  const s = data?.status;
  const crit = data?.warnings.some((w) => w.level === "crit");
  const overall = !s ? null : crit ? { t: "점검 필요", c: BAD } : data.warnings.length ? { t: "주의", c: WARN } : { t: "정상", c: GOOD };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {s ? `${new Date(s.checkedAt).toLocaleTimeString("ko-KR")} 확인 · v${s.build.version}${s.build.buildId ? ` (${s.build.buildId.slice(0, 7)})` : ""}` : " "}
        </span>
        <button type="button" onClick={refresh} disabled={loading} aria-label="운영 상태 새로고침" title="새로고침" style={iconBtn}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && <p style={{ fontSize: 12.5, color: BAD, margin: 0 }}>{error}</p>}
      {!s && !error && <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>불러오는 중…</p>}
      {s && overall && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>
            <Tile label="상태" value={overall.t} color={overall.c} sub={`DB ${s.health.db ? "정상" : "끊김"} · 워커 ${s.health.worker ? "정상" : "지연"}`} />
            <Tile
              label="마지막 백업"
              value={s.backup.ageHours === null ? "없음" : `${Math.floor(s.backup.ageHours)}시간 전`}
              sub={(s.backup.sizeBytes === null ? s.backup.dir : `${mb(s.backup.sizeBytes)} · ${s.backup.latest}`) + (s.backup.inProgress ? " · 새 백업 진행 중" : "")}
            />
            <Tile
              label="디스크 여유"
              value={s.disk ? `${Math.round(s.disk.freeRatio * 1000) / 10}%` : "—"}
              sub={s.disk ? `${gb(s.disk.freeBytes)} / ${gb(s.disk.totalBytes)}` : "읽지 못함"}
            />
            <Tile
              label="오늘 AI 비용(추정)"
              value={usd(s.llm.todayUsd)}
              sub={`토큰 ${s.llm.todayTokens === null ? "—" : s.llm.todayTokens.toLocaleString("ko-KR")}${s.llm.budgetTokens > 0 ? ` / ${s.llm.budgetTokens.toLocaleString("ko-KR")}` : ""}`}
            />
          </div>
          {data.warnings.length > 0 && (
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {data.warnings.map((w) => (
                <li key={w.code} style={{ fontSize: 12.5, color: "var(--text-strong)", display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: w.level === "crit" ? BAD : WARN, minWidth: 28 }}>{w.level === "crit" ? "위험" : "주의"}</span>
                  {w.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={box}>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color ?? "var(--text-strong)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4, overflowWrap: "anywhere" }}>{sub}</div>}
    </div>
  );
}

const box: CSSProperties = { padding: "10px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", minWidth: 0 };
const iconBtn: CSSProperties = { display: "inline-flex", border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", borderRadius: 8, padding: 6, cursor: "pointer" };
