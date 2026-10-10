"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./icons";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { Avatar, DDay, Dot, colorFor, shortId } from "./ui";
import {
  classifyRoles,
  type DbProperty,
  type DbRow,
  type Role,
} from "../DatabaseView";
import { getPages } from "@/lib/pagesClient";
import { relativeTime, summarizeSessions, type SessionLike, type SessionSummary } from "@/lib/sessionSummary";

/* 대시보드 — 전체 현황 요약 (Saebit dashboard.jsx 포팅 → 제네릭 DB 모델 매핑) */

type DbPayload = {
  page: { id: string; title: string; kind: string };
  properties: DbProperty[];
  rows: DbRow[];
};

/* 디자인 소스 accent 팔레트 */
const ACCENT = {
  blue: "#2F62FF",
  orange: "#F5A623",
  purple: "#7165E3",
  green: "#12B886",
  red: "#F0494E",
};

/* ---------- 헬퍼 ---------- */
function personNames(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 오늘 기준 마감일까지 남은 일수 (음수 = 지연) */
function dayDiff(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return Math.round((t.getTime() - today.getTime()) / 86400000);
}

/* ============ 프리미티브 ============ */
/* 최근 활동 피드 (W6 inv-5): 문서·태스크·결정·관리 행위. 30초 자동 갱신. */
function ActivityFeed() {
  const [items, setItems] = useState<{ id: string; actorName: string; verb: string; targetType: string; targetTitle: string; createdAt: string }[] | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/activity?limit=15", { cache: "no-store" });
    if (r.ok) setItems(((await r.json()) as { activities: typeof items }).activities ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useAutoRefresh(load);

  const VERB: Record<string, string> = { created: "생성", updated: "수정", deleted: "삭제", restored: "복원", purged: "영구 삭제", claimed: "클레임", commented: "코멘트", requested: "승인 요청", decided: "결정", uploaded: "업로드", invited: "초대", revoked: "회수", moved: "보드 이동" };
  const TYPE: Record<string, string> = { doc: "문서", task: "태스크", board: "보드", decision: "결정", approval: "승인", member: "멤버", token: "토큰", file: "파일", lesson: "레슨" };

  return (
    <DashPanel title="최근 활동">
      {items === null ? (
        <div style={emptyNote}>불러오는 중…</div>
      ) : items.length === 0 ? (
        <div style={emptyNote}>아직 활동이 없어요.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {items.map((a, i) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
              <Avatar name={a.actorName} size={22} />
              <span style={{ fontSize: 12.5, color: "var(--text-body)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <b style={{ color: "var(--text-strong)" }}>{a.actorName}</b>
                {" · "}{TYPE[a.targetType] ?? a.targetType} <b>{a.targetTitle}</b> {VERB[a.verb] ?? a.verb}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "0 0 auto" }}>
                {new Date(a.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}
    </DashPanel>
  );
}

function SessionCard() {
  const router = useRouter();
  // null = 로딩, "error" = 실패
  const [sum, setSum] = useState<SessionSummary | "error" | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store" });
      if (!r.ok) return setSum("error");
      const { sessions } = (await r.json()) as { sessions: SessionLike[] };
      setSum(summarizeSessions(sessions ?? [], new Date()));
    } catch {
      setSum("error");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useAutoRefresh(load);

  const now = new Date();
  return (
    <DashPanel
      title="에이전트 세션"
      action={
        <button className="ws-link" onClick={() => router.push("/settings")}>
          라이브 세션 관리
        </button>
      }
    >
      {sum === null ? (
        <div style={emptyNote}>불러오는 중…</div>
      ) : sum === "error" ? (
        <div style={emptyNote}>세션을 불러오지 못했어요.</div>
      ) : sum.top.length === 0 ? (
        <div style={emptyNote}>아직 연결된 에이전트 세션이 없어요.</div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginBottom: 4 }}>
            활성 {sum.active} · 24시간 {sum.recent}
            {sum.lastActivityAt && ` · 마지막 활동 ${relativeTime(sum.lastActivityAt, now)}`}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {sum.top.map((t, i) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: t.status === "active" ? "var(--color-primary)" : "var(--text-muted)", flex: "0 0 auto" }}>
                  {t.status === "active" ? "활성" : "종료"}
                </span>
                <span style={{ fontSize: 12.5, color: "var(--text-body)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "0 0 auto" }}>
                  항목 {t.itemCount} · {relativeTime(t.updatedAt, now)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </DashPanel>
  );
}

function DashPanel({
  title,
  action,
  children,
  style,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        background: "var(--surface-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 14,
        padding: 18,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-strong)" }}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  accent,
  alert,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent: string;
  alert?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        background: "var(--surface-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 12,
        padding: "16px 16px 14px 18px",
        overflow: "hidden",
      }}
    >
      <span
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accent }}
        aria-hidden
      />
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-sub)" }}>{label}</div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 34,
          fontWeight: 700,
          lineHeight: 1.1,
          color: "var(--text-strong)",
          marginTop: 4,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, marginTop: 4, color: alert ? "var(--color-danger)" : "var(--text-muted)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function BarRow({
  label,
  count,
  max,
  color,
  leading,
}: {
  label: string;
  count: number;
  max: number;
  color: string;
  leading?: ReactNode;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
      {leading}
      <span
        style={{
          width: 96,
          flexShrink: 0,
          fontSize: 12.5,
          color: "var(--text-sub)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={label}
      >
        {label}
      </span>
      <span
        style={{
          flex: 1,
          height: 8,
          background: "var(--surface-sunken)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <span
          style={{ display: "block", height: "100%", width: `${pct}%`, background: color, borderRadius: 4 }}
        />
      </span>
      <span
        style={{ width: 26, textAlign: "right", fontSize: 12.5, fontWeight: 600, color: "var(--text-strong)" }}
      >
        {count}
      </span>
    </div>
  );
}

/* ============ 대시보드 ============ */
export default function Dashboard({ userName }: { userName: string }) {
  const router = useRouter();
  const [taskDbId, setTaskDbId] = useState<string | null>(null);
  const [data, setData] = useState<DbPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notif, setNotif] = useState<{ sentToday: number; logs: { id: string; channel: string; text: string; state: string; createdAt: string }[] } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/slack/log?limit=4", { cache: "no-store" });
      if (res.ok) setNotif((await res.json()) as { sentToday: number; logs: { id: string; channel: string; text: string; state: string; createdAt: string }[] });
    })();
  }, []);

  const load = useCallback(async () => {
    // 사이드바와 동일한 방식: 첫 데이터베이스 페이지 = 태스크 DB
    const pagesRes = await getPages();
    if (!pagesRes.ok) return;
    const { pages } = pagesRes.data as { pages: { id: string; kind: string }[] };
    const db = pages.find((p) => p.kind === "database");
    if (!db) {
      setTaskDbId(null);
      setData(null);
      return;
    }
    setTaskDbId(db.id);
    const dbRes = await fetch(`/api/databases/${db.id}`, { cache: "no-store" });
    if (!dbRes.ok) return;
    const payload = (await dbRes.json()) as DbPayload;
    setData(payload);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const model = useMemo(() => {
    if (!data) return null;
    const { roles, titleId } = classifyRoles(data.properties);
    const byRole = (r: Role) => data.properties.find((p) => roles.get(p.id) === r);
    const statusProp = byRole("status");
    // 두 번째 분포 패널: 우선순위 → 심각도 → 첫 라벨 순으로 선택
    const secondProp =
      byRole("priority") ?? byRole("severity") ?? data.properties.find((p) => roles.get(p.id) === "label");
    const personProp = byRole("person");
    const dateProp = byRole("date");
    const titleProp = data.properties.find((p) => p.id === titleId) ?? data.properties[0];

    const statusOptions = statusProp?.config?.options ?? [];
    // 완료 = 마지막 상태 옵션, 진행 중 = 이름 휴리스틱 → 없으면 2번째 옵션
    const doneOpt = statusOptions[statusOptions.length - 1];
    const inProgressOpt =
      statusOptions.find((o) => /진행|doing|in.?progress|wip|작업/i.test(o.name)) ??
      (statusOptions.length > 2 ? statusOptions[1] : undefined);

    return {
      rows: data.rows,
      statusProp,
      statusOptions,
      doneOpt,
      inProgressOpt,
      secondProp,
      personProp,
      dateProp,
      titleProp,
    };
  }, [data]);

  const openTask = () => {
    if (taskDbId) router.push(`/p/${taskDbId}?view=table`);
  };

  if (loading && !data) {
    return <div style={wrap}>불러오는 중…</div>;
  }

  if (!taskDbId || !model) {
    return (
      <div style={wrap}>
        <h2 style={greetingStyle}>안녕하세요, {userName}님</h2>
        <div
          style={{
            marginTop: 28,
            padding: "48px 24px",
            textAlign: "center",
            background: "var(--surface-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 14,
            color: "var(--text-sub)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>
            아직 태스크가 없어요
          </div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>
            태스크 데이터베이스를 만들면 현황 요약이 여기에 나타납니다.
          </div>
          <button
            className="ws-link"
            style={{ fontSize: 13, padding: "8px 14px", background: "var(--color-primary-weak)" }}
            onClick={openTask}
          >
            태스크 보드 열기
          </button>
        </div>
      </div>
    );
  }

  const { rows, statusProp, statusOptions, doneOpt, inProgressOpt, secondProp, personProp, dateProp } = model;
  const total = rows.length;

  /* ---------- 상태 메트릭 ---------- */
  const statusCount = (optId: string) => rows.filter((r) => r.props[statusProp!.id] === optId).length;
  const inProgress = inProgressOpt ? statusCount(inProgressOpt.id) : 0;
  const done = doneOpt ? statusCount(doneOpt.id) : 0;

  /* ---------- 마감 메트릭 ---------- */
  const isOpen = (r: DbRow) => !doneOpt || r.props[statusProp?.id ?? ""] !== doneOpt.id;
  const dueDiffs = dateProp
    ? rows.map((r) => ({ row: r, diff: dayDiff(r.props[dateProp.id]) }))
    : [];
  const overdue = dueDiffs.filter((x) => x.diff !== null && x.diff < 0 && isOpen(x.row)).length;
  const dueToday = dueDiffs.filter((x) => x.diff === 0 && isOpen(x.row)).length;
  const dueThisWeek = dueDiffs.filter((x) => x.diff !== null && x.diff >= 0 && x.diff <= 7 && isOpen(x.row)).length;

  const greetingSub = dateProp
    ? `오늘 마감 ${dueToday}건, 이번 주 마감 ${dueThisWeek}건, 지연 ${overdue}건이 있어요.`
    : `진행 중인 태스크 ${inProgress}건이 있어요.`;

  /* ---------- 상태 분포 ---------- */
  const statusBuckets = statusOptions
    .map((o) => ({ opt: o, count: statusCount(o.id) }))
    .filter((b) => b.count > 0);
  const unsetCount = statusProp
    ? rows.filter((r) => !statusOptions.some((o) => o.id === r.props[statusProp.id])).length
    : 0;
  const distTotal = statusBuckets.reduce((s, b) => s + b.count, 0) + unsetCount;

  /* ---------- 두 번째 분포 (BarRow) ---------- */
  const secondOptions = secondProp?.config?.options ?? [];
  const secondBuckets = secondOptions.map((o) => ({
    opt: o,
    count: rows.filter((r) => r.props[secondProp!.id] === o.id).length,
  }));
  const secondMax = Math.max(1, ...secondBuckets.map((b) => b.count));

  /* ---------- 담당자별 작업량 ---------- */
  const assigneeMap = new Map<string, number>();
  if (personProp) {
    for (const r of rows) {
      for (const name of personNames(r.props[personProp.id])) {
        assigneeMap.set(name, (assigneeMap.get(name) ?? 0) + 1);
      }
    }
  }
  const assignees = [...assigneeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const assigneeMax = Math.max(1, ...assignees.map(([, c]) => c));

  /* ---------- 마감 임박 ---------- */
  const upcoming = dateProp
    ? dueDiffs
        .filter((x) => x.diff !== null && isOpen(x.row))
        .sort((a, b) => (a.diff! - b.diff!))
        .slice(0, 5)
    : [];

  return (
    <div style={wrap}>
      {/* 인사 */}
      <h2 style={greetingStyle}>안녕하세요, {userName}님</h2>
      <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--text-sub)" }}>{greetingSub}</p>

      {/* 메트릭 그리드 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(176px, 1fr))",
          gap: 12,
          marginTop: 22,
        }}
      >
        <Metric label="전체 태스크" value={total} accent={ACCENT.blue} />
        {statusProp && (
          <Metric
            label={inProgressOpt ? inProgressOpt.name : "진행 중"}
            value={inProgress}
            accent={ACCENT.orange}
          />
        )}
        {dateProp && (
          <Metric
            label="이번 주 마감"
            value={dueThisWeek}
            sub={overdue > 0 ? `지연 ${overdue}건` : "지연 없음"}
            accent={ACCENT.purple}
            alert={overdue > 0}
          />
        )}
        {statusProp && doneOpt && (
          <Metric label={doneOpt.name} value={done} accent={ACCENT.green} />
        )}
      </div>

      {/* 분포 행 */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <DashPanel title="상태 분포" style={{ flex: "2 1 320px" }}>
          {distTotal > 0 ? (
            <>
              <div
                style={{
                  display: "flex",
                  height: 12,
                  borderRadius: 6,
                  overflow: "hidden",
                  background: "var(--surface-sunken)",
                }}
              >
                {statusBuckets.map((b) => (
                  <span
                    key={b.opt.id}
                    title={`${b.opt.name} ${b.count}`}
                    style={{ width: `${(b.count / distTotal) * 100}%`, background: colorFor(b.opt.color) }}
                  />
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", marginTop: 14 }}>
                {statusBuckets.map((b) => (
                  <span key={b.opt.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                    <Dot color={b.opt.color} />
                    <span style={{ color: "var(--text-sub)" }}>{b.opt.name}</span>
                    <span style={{ fontWeight: 600, color: "var(--text-strong)" }}>{b.count}</span>
                  </span>
                ))}
                {unsetCount > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                    <Dot color="gray" />
                    <span style={{ color: "var(--text-sub)" }}>미지정</span>
                    <span style={{ fontWeight: 600, color: "var(--text-strong)" }}>{unsetCount}</span>
                  </span>
                )}
              </div>
            </>
          ) : (
            <div style={emptyNote}>상태 데이터가 없어요.</div>
          )}
        </DashPanel>

        <DashPanel title={secondProp ? secondProp.name : "분류"} style={{ flex: "1 1 240px" }}>
          {secondBuckets.length > 0 ? (
            secondBuckets.map((b) => (
              <BarRow
                key={b.opt.id}
                label={b.opt.name}
                count={b.count}
                max={secondMax}
                color={colorFor(b.opt.color)}
              />
            ))
          ) : (
            <div style={emptyNote}>분류 속성이 없어요.</div>
          )}
        </DashPanel>
      </div>

      {/* 작업량 행 */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <DashPanel title="담당자별 작업량" style={{ flex: "1 1 320px" }}>
          {assignees.length > 0 ? (
            assignees.map(([name, count]) => (
              <BarRow
                key={name}
                label={name}
                count={count}
                max={assigneeMax}
                color={ACCENT.blue}
                leading={<Avatar name={name} size={22} />}
              />
            ))
          ) : (
            <div style={emptyNote}>담당자가 지정된 태스크가 없어요.</div>
          )}
        </DashPanel>

        <DashPanel
          title="마감 임박"
          action={
            <button className="ws-link" onClick={openTask}>
              전체 보기
            </button>
          }
          style={{ flex: "1 1 320px" }}
        >
          {upcoming.length > 0 ? (
            upcoming.map(({ row }) => {
              const title = model.titleProp ? row.props[model.titleProp.id] : "";
              const assignee = personProp ? personNames(row.props[personProp.id])[0] ?? "" : "";
              return (
                <div
                  key={row.id}
                  className="ws-listrow"
                  onClick={openTask}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 6px",
                    cursor: "pointer",
                  }}
                >
                  <Avatar name={assignee} size={24} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--text-strong)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {typeof title === "string" && title ? title : "Untitled"}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {shortId(row.id)}
                    </span>
                  </span>
                  {dateProp && <DDay value={row.props[dateProp.id]} />}
                </div>
              );
            })
          ) : (
            <div style={emptyNote}>마감 예정인 태스크가 없어요.</div>
          )}
        </DashPanel>
      </div>

      {/* 최근 활동 (W6 활동 피드) */}
      <div style={{ marginTop: 12 }}>
        <ActivityFeed />
      </div>

      {/* 에이전트 세션 (F7) */}
      <div style={{ marginTop: 12 }}>
        <SessionCard />
      </div>

      {/* 알림 요약 (슬랙 연동 예정) */}
      <div style={{ marginTop: 12 }}>
        <DashPanel
          title="오늘 보낸 알림"
          action={
            <button className="ws-link" onClick={() => router.push("/slack")}>
              발송 이력
            </button>
          }
        >
          {!notif || notif.logs.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 6px", color: "var(--text-muted)", fontSize: 13 }}>
              <Icon name="slack" size={18} />
              {notif ? "아직 발송된 알림이 없어요." : "불러오는 중…"}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginBottom: 4 }}>오늘 {notif.sentToday}건 전송</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {notif.logs.map((l, i) => (
                  <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                    <span style={{ display: "flex", color: l.state === "failed" ? "var(--color-danger)" : "var(--text-muted)" }}><Icon name="hash" size={15} /></span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-body)", flex: "0 0 auto" }}>{l.channel}</span>
                    <span style={{ fontSize: 12.5, color: "var(--text-sub)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.text}</span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "0 0 auto" }}>{new Date(l.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </DashPanel>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  maxWidth: 1180,
  margin: "0 auto",
  padding: "40px 28px 96px",
};

const greetingStyle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  color: "var(--text-strong)",
};

const emptyNote: CSSProperties = {
  fontSize: 12.5,
  color: "var(--text-muted)",
  padding: "6px 0",
};
