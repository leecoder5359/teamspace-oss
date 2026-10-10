"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/* =====================================================================
   설정 › AI 실행 경로 (관리자) — GET /api/ai-routes.
   AI 호출이 어디로 나가는지(사용처)와 기간 사용량, 외부 중계 서버 상태.
   중계가 설정되지 않은 서버(AI_RELAY_* env 없음)에서는 중계 구역을 숨긴다.
   표·알약 모양은 기존 설정/결정 화면의 패턴을 그대로 쓴다.
   ===================================================================== */

type Agg = { calls: number; ok: number; failed: number; inputTokens: number; outputTokens: number; avgMs: number | null; p95Ms: number | null; usd?: number | null };
type RelayStatus = {
  process: { state: string; pid: number | null; lastExitStatus: number | null };
  health: { state: string; httpStatus: number | null; error: string | null; ms: number | null };
  watchdog: { state: string; at: string | null; text: string | null };
  deploy: { state: string; version: string | null };
  models: { list: string[]; defaultModel: string | null; since: string | null };
};
type Data = {
  days: number;
  relay: {
    configured: boolean;
    label: string;
    status: RelayStatus | null;
    usage:
      | {
          byDay: (Agg & { day: string })[];
          totals: Agg & { okRate: number | null; healthChecks: number; otherRequests: number };
          failureCodes: { code: string; count: number }[];
          recentFailures: { at: string; method: string; path: string; status: number; code: string; durationMs: number }[];
          badLines: number;
          log: { size: number; scannedBytes: number; truncated: boolean };
        }
      | null;
    usageError: string | null;
  };
  teamspace: {
    provider: string;
    models: { synthesize: string; extract: string } | null;
    cacheHits: number;
    totals: Agg & { okRate: number | null; cacheHits: number };
    /** calls 는 실제 호출만, cacheHits 는 응답 캐시 적중 수 */
    byFeature: (Agg & { feature: string; lastAt: string | null; cacheHits: number })[];
    errorKinds: { errorKind: string; count: number }[];
  };
  cost?: { todayTokens: number | null; todayUsd: number | null; periodUsd: number | null; budgetTokens: number; exceeded: boolean; cacheHits: number };
  routes: { name: string; kind: string; calls: number; ok: number; inputTokens: number | null; outputTokens: number | null }[];
};

const FEATURE_LABEL: Record<string, string> = {
  ask: "질문 답변",
  clip: "웹 클립 분류",
  "graph-infer": "그래프 연관 찾기",
  "qa-extract": "Q&A 뽑기",
  "search-concept": "개념 검색",
  provenance: "출처 분석",
  "glossary-extract": "용어 뽑기",
  "dod-extract": "완료 기준 뽑기",
  "onboarding-extract": "온보딩 뽑기",
  "entities-extract": "개체 뽑기",
  "feedback-classify": "피드백 분류",
  complete: "기타",
};
const PROVIDER_LABEL: Record<string, string> = { api: "Anthropic API", cli: "claude CLI(로컬 로그인)", off: "꺼짐" };

const GOOD = "#12B886";
const WARN = "#F5A623";
const BAD = "#C0392B";
const MUTED = "#9AA0A6";

const n = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toLocaleString("ko-KR"));
const usd = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `$${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)}`);
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 1000) / 10}%`);
const dur = (ms: number | null) => (ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${ms}ms`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const bytes = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);

export default function AiRoutes() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/ai-routes?days=${days}`, { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as Data & { error?: string };
      if (!alive) return;
      if (!res.ok) {
        setError(d.error ?? "불러오지 못했습니다.");
        return;
      }
      setError(null);
      setData(d);
    })();
    return () => {
      alive = false;
    };
  }, [days]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <p style={{ ...hint, marginTop: 0, flex: 1, minWidth: 200 }}>
          AI 호출이 어디로 나가는지와 사용량입니다. 질문·답변 내용은 저장하지 않고 횟수·시간·토큰만 셉니다. CLI: <code>pnpm ws ai-routes</code>
        </p>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={inputStyle} aria-label="기간">
          <option value={7}>최근 7일</option>
          <option value={14}>최근 14일</option>
          <option value={30}>최근 30일</option>
        </select>
      </div>

      {error && <p style={{ ...hint, color: "var(--text-body)" }}>{error}</p>}
      {!data && !error && <p style={hint}>불러오는 중…</p>}

      {data && (
        <>
          <Sub label="사용처">
            {data.routes.length === 0 ? (
              <p style={empty}>AI 호출 경로가 없습니다(AI 기능이 꺼져 있음).</p>
            ) : (
              <Table head={["경로", "호출", "성공", "입력 토큰", "출력 토큰"]} numericFrom={1}>
                {data.routes.map((r) => (
                  <tr key={r.name} style={rowStyle}>
                    <td style={{ ...td, fontWeight: 600, color: "var(--text-strong)" }}>{r.name}</td>
                    <td style={tdNum}>{n(r.calls)}</td>
                    <td style={tdNum}>{n(r.ok)}</td>
                    <td style={tdNum}>{n(r.inputTokens)}</td>
                    <td style={tdNum}>{n(r.outputTokens)}</td>
                  </tr>
                ))}
              </Table>
            )}
            {data.routes.some((r) => r.kind === "cli" && r.inputTokens === null) && (
              <p style={hint}>claude CLI 경로의 예전 호출은 토큰이 기록되지 않아 — 로 표시합니다(이후 호출부터 셉니다).</p>
            )}
          </Sub>

          {data.relay.configured && <RelayPart relay={data.relay} days={data.days} />}

          {data.cost && <CostCard cost={data.cost} days={data.days} />}

          <Sub label={`TeamSpace 기능별 호출 · 지금 경로 ${PROVIDER_LABEL[data.teamspace.provider] ?? data.teamspace.provider}${data.teamspace.models ? ` · 합성 ${data.teamspace.models.synthesize} · 추출 ${data.teamspace.models.extract}` : ""}`}>
            {data.teamspace.byFeature.length === 0 ? (
              <p style={empty}>이 기간에 TeamSpace 가 AI 를 부른 기록이 없습니다.</p>
            ) : (
              <Table head={["기능", "호출", "캐시", "실패", "평균 시간", "$", "마지막"]} numericFrom={1}>
                {data.teamspace.byFeature.map((f) => (
                  <tr key={f.feature} style={rowStyle}>
                    <td style={td}>
                      <span style={{ fontWeight: 600, color: "var(--text-strong)" }}>{FEATURE_LABEL[f.feature] ?? f.feature}</span>
                      <span style={{ marginLeft: 6, fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{f.feature}</span>
                    </td>
                    <td style={tdNum}>{n(f.calls)}</td>
                    <td style={tdNum}>{n(f.cacheHits)}</td>
                    <td style={{ ...tdNum, color: f.failed ? BAD : undefined }}>{n(f.failed)}</td>
                    <td style={tdNum}>{dur(f.avgMs)}</td>
                    <td style={tdNum}>{usd(f.usd)}</td>
                    <td style={{ ...tdNum, color: "var(--text-muted)" }}>{when(f.lastAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
            <p style={hint}>공개 단가 기준 추정 — 실제 청구와 다를 수 있음</p>
            <p style={hint}>캐시 적중 {n(data.teamspace.cacheHits)}건(최근 {data.days}일) — 같은 요청은 AI 를 다시 부르지 않고 저장된 답을 썼습니다. 호출·실패·시간·$ 는 실제 호출만 셉니다.</p>
            {data.teamspace.errorKinds.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {data.teamspace.errorKinds.map((e) => (
                  <Pill key={e.errorKind} color={BAD} label={`${e.errorKind} ${n(e.count)}건`} />
                ))}
              </div>
            )}
          </Sub>
        </>
      )}
    </div>
  );
}

function CostCard({ cost, days }: { cost: NonNullable<Data["cost"]>; days: number }) {
  return (
    <Sub label="AI 비용(추정)">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>
        <div style={costBox}>
          <div style={costLabel}>오늘 토큰(이 서버 전체)</div>
          <div style={costValue}>{n(cost.todayTokens)}</div>
        </div>
        <div style={costBox}>
          <div style={costLabel}>최근 {days}일 합계(이 워크스페이스)</div>
          <div style={costValue}>{usd(cost.periodUsd)}</div>
        </div>
        <div style={costBox}>
          <div style={costLabel}>캐시 적중</div>
          <div style={costValue}>{n(cost.cacheHits)}건</div>
        </div>
      </div>
      {cost.budgetTokens > 0 && cost.todayTokens !== null && (
        <div style={{ marginTop: 10 }}>
          <progress value={Math.min(cost.todayTokens, cost.budgetTokens)} max={cost.budgetTokens} aria-label="오늘 토큰 예산" style={{ width: "100%", height: 8 }} />
          <div style={{ ...hint, marginTop: 4 }}>
            {n(cost.todayTokens)} / {n(cost.budgetTokens)}
          </div>
        </div>
      )}
      {cost.exceeded && (
        <p style={{ ...hint, color: BAD, fontWeight: 600 }}>오늘 예산을 넘어 LLM 호출을 멈췄습니다 — LLM_DAILY_BUDGET_TOKENS</p>
      )}
    </Sub>
  );
}

function RelayPart({ relay, days }: { relay: Data["relay"]; days: number }) {
  const s = relay.status;
  const u = relay.usage;
  return (
    <>
      {s && (
        <Sub label={`${relay.label} · 상태`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>
            <StatusCard title="프로세스" {...processView(s.process)} />
            <StatusCard title="응답" {...healthView(s.health)} />
            <StatusCard title="공개 입구" {...watchdogView(s.watchdog)} />
            <StatusCard
              title="배포본"
              color={s.deploy.state === "ok" ? GOOD : MUTED}
              label={s.deploy.state === "ok" ? "확인됨" : s.deploy.state === "not_configured" ? "설정 안 됨" : "확인 불가"}
              detail={s.deploy.version ?? undefined}
              mono
            />
            <StatusCard
              title="모델"
              color={s.models.list.length ? GOOD : MUTED}
              label={s.models.list.length ? `${s.models.list.length}개 허용` : "기록 없음"}
              detail={s.models.defaultModel ? `기본 ${s.models.defaultModel}` : undefined}
              title2={s.models.list.join(", ")}
              mono
            />
          </div>
        </Sub>
      )}

      <Sub label={`${relay.label} · 최근 ${days}일 사용량`}>
        {!u ? (
          <p style={empty}>
            {relay.usageError === "log_missing" ? "로그 파일이 없습니다." : relay.usageError === "not_configured" ? "로그 경로가 설정되지 않았습니다." : "로그를 읽지 못했습니다."}
          </p>
        ) : (
          <>
            <p style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
              합계 {n(u.totals.calls)}회 · 성공률 {pct(u.totals.okRate)} · 입력 {n(u.totals.inputTokens)} / 출력 {n(u.totals.outputTokens)} 토큰 · 평균 {dur(u.totals.avgMs)} · 느린 5% {dur(u.totals.p95Ms)}
              {" "}(AI 호출만 셈 — 생존 확인 {n(u.totals.healthChecks)}회·기타 요청 {n(u.totals.otherRequests)}회는 뺌)
            </p>
            <Table head={["날짜", "호출", "성공률", "입력 토큰", "출력 토큰", "평균", "느린 5%"]} numericFrom={1}>
              {[...u.byDay].reverse().map((d) => (
                <tr key={d.day} style={rowStyle}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{d.day.slice(5).replace("-", "/")}</td>
                  <td style={tdNum}>{n(d.calls)}</td>
                  <td style={{ ...tdNum, color: d.calls && d.failed ? WARN : undefined }}>{d.calls ? pct(d.ok / d.calls) : "—"}</td>
                  <td style={tdNum}>{d.calls ? n(d.inputTokens) : "—"}</td>
                  <td style={tdNum}>{d.calls ? n(d.outputTokens) : "—"}</td>
                  <td style={tdNum}>{dur(d.avgMs)}</td>
                  <td style={tdNum}>{dur(d.p95Ms)}</td>
                </tr>
              ))}
            </Table>

            <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>실패 코드별 건수</div>
            {u.failureCodes.length === 0 ? (
              <p style={empty}>이 기간에 실패가 없습니다.</p>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {u.failureCodes.map((c) => (
                  <Pill key={c.code} color={BAD} label={`${c.code} ${n(c.count)}건`} />
                ))}
              </div>
            )}

            {u.recentFailures.length > 0 && (
              <>
                <div style={{ marginTop: 12, marginBottom: 6, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>최근 실패 {u.recentFailures.length}건</div>
                <Table head={["시각", "코드", "상태", "경로", "걸린 시간"]} numericFrom={4}>
                  {u.recentFailures.map((f, i) => (
                    <tr key={`${f.at}-${i}`} style={rowStyle}>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "var(--text-muted)" }}>{when(f.at)}</td>
                      <td style={{ ...td, fontFamily: "var(--font-mono)", color: BAD }}>{f.code}</td>
                      <td style={td}>{f.status}</td>
                      <td style={{ ...td, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{f.method} {f.path}</td>
                      <td style={tdNum}>{dur(f.durationMs)}</td>
                    </tr>
                  ))}
                </Table>
              </>
            )}
            <p style={hint}>
              로그 {bytes(u.log.size)}
              {u.log.truncated ? ` 중 끝 ${bytes(u.log.scannedBytes)}만 읽었습니다(로그가 회전되지 않아 오래된 기록은 건너뜀).` : " 전체를 읽었습니다."}
              {u.badLines > 0 ? ` 읽지 못한 줄 ${n(u.badLines)}개.` : ""}
            </p>
          </>
        )}
      </Sub>
    </>
  );
}

type View = { color: string; label: string; detail?: string };

function processView(p: RelayStatus["process"]): View {
  switch (p.state) {
    case "running":
      return { color: GOOD, label: "실행 중", detail: `PID ${p.pid}` };
    case "stopped":
      return { color: BAD, label: "멈춤", detail: p.lastExitStatus !== null ? `마지막 종료 코드 ${p.lastExitStatus}` : undefined };
    case "missing":
      return { color: BAD, label: "등록 안 됨", detail: "launchd 에 없음" };
    case "unavailable":
      return { color: MUTED, label: "확인 불가" };
    default:
      return { color: MUTED, label: "설정 안 됨" };
  }
}
function healthView(h: RelayStatus["health"]): View {
  switch (h.state) {
    case "alive":
      return { color: GOOD, label: "응답함", detail: `${h.httpStatus === 401 ? "인증 필요(401)" : `HTTP ${h.httpStatus}`}${h.ms !== null ? ` · ${h.ms}ms` : ""}` };
    case "unexpected":
      return { color: WARN, label: "이상한 응답", detail: `HTTP ${h.httpStatus}` };
    case "down":
      return { color: BAD, label: "응답 없음", detail: h.error === "connection_refused" ? "연결 거부" : h.error === "timeout" ? "3초 안에 응답 없음" : h.error ?? undefined };
    default:
      return { color: MUTED, label: "설정 안 됨" };
  }
}
function watchdogView(w: RelayStatus["watchdog"]): View {
  switch (w.state) {
    case "ok":
      return { color: GOOD, label: "정상", detail: w.at ? `${w.at.replace("T", " ")} 확인` : undefined };
    case "fail":
      return { color: BAD, label: "실패", detail: `${w.text ?? ""}${w.at ? ` · ${w.at.replace("T", " ")}` : ""}` };
    case "empty":
      return { color: MUTED, label: "기록 없음" };
    case "unavailable":
      return { color: MUTED, label: "확인 불가", detail: "감시 로그를 읽지 못함" };
    default:
      return { color: MUTED, label: "설정 안 됨" };
  }
}

function StatusCard({ title, color, label, detail, title2, mono }: View & { title: string; title2?: string; mono?: boolean }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", minWidth: 0 }} title={title2}>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 6 }}>{title}</div>
      <Pill color={color} label={label} />
      {detail && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: mono ? "var(--font-mono)" : undefined }}>
          {detail}
        </div>
      )}
    </div>
  );
}

/* 결정 화면(DecisionsSurface)의 상태 알약과 같은 모양 */
export function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: `color-mix(in srgb, ${color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${color} 80%, var(--text-strong))` }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

/* 결정 화면의 표와 같은 모양(테두리 카드 + 헤더 줄) */
export function Table({ head, numericFrom, children }: { head: string[]; numericFrom: number; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, overflowX: "auto", background: "var(--surface-card)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: 12 }}>
            {head.map((h, i) => (
              <th key={h} style={{ ...th, textAlign: i >= numericFrom ? "right" : "left" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Sub({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.02em", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

const costBox: CSSProperties = { padding: "10px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", minWidth: 0 };
const costLabel: CSSProperties = { fontSize: 11.5, color: "var(--text-muted)", marginBottom: 6 };
const costValue: CSSProperties = { fontSize: 15, fontWeight: 700, color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" };

export const th: CSSProperties = { padding: "8px 12px", fontWeight: 600, whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "8px 12px", verticalAlign: "middle", color: "var(--text-body)" };
export const tdNum: CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
export const rowStyle: CSSProperties = { borderBottom: "1px solid var(--border-subtle)" };
export const hint: CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 8 };
export const empty: CSSProperties = { ...hint, marginTop: 0 };
export const inputStyle: CSSProperties = {
  padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)",
  background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit",
};
