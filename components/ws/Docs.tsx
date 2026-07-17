"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { filterDocs, NO_PROJECT } from "@/lib/docFilter";
import { useIsMobile } from "@/lib/useIsMobile";
import MarkdownPreview from "../MarkdownPreview";
import DatabaseView from "../DatabaseView";
import DecisionsSurface from "./DecisionsSurface";
import LessonsSurface from "./LessonsSurface";
import GlossarySurface from "./GlossarySurface";
import ChangelogSurface from "./ChangelogSurface";
import RisksSurface from "./RisksSurface";
import QaSurface from "./QaSurface";
import DataModelSurface from "./DataModelSurface";
import DodSurface from "./DodSurface";
import OnboardingSurface from "./OnboardingSurface";
import GraphSurface from "./GraphSurface";
import LintSurface from "./LintSurface";

/* 문서 허브 (design app/docs.jsx 포팅) — 카테고리 레일 + 프로젝트 전환기 + surface.
   '문서'(mddocs) 카테고리는 file-first Page 데이터로 2-pane 동작.
   구조화 surface(결정/QA/리스크/데이터모델/DoD/변경이력/용어집/온보딩)는 후속(준비 중). */

type DocItem = {
  id: string;
  title: string;
  kind: "doc" | "database";
  icon: string | null;
  projectId: string | null;
  updatedAt: string;
};
type ProjectLite = { id: string; name: string; boardPageId: string | null };

type Cat = { key: string; label: string; sub: string; icon: IconName; color: string; scope: "project" | "common" };
const DOC_CATS: Cat[] = [
  { key: "mddocs", label: "문서", sub: "기획·회의록·가이드", icon: "doc", color: "#2F62FF", scope: "project" },
  { key: "decisions", label: "결정", sub: "의사결정 기록", icon: "flag", color: "#7165E3", scope: "project" },
  { key: "lessons", label: "팀 작업규칙", sub: "레슨 — 매 세션 자동 주입", icon: "check", color: "#F5A623", scope: "project" },
  { key: "qa", label: "QA", sub: "테스트 시나리오", icon: "comment", color: "#12B886", scope: "project" },
  { key: "risks", label: "리스크", sub: "위험·이슈", icon: "alert", color: "#F0494E", scope: "project" },
  { key: "datamodel", label: "데이터 모델", sub: "엔티티·관계", icon: "table", color: "#2F62FF", scope: "common" },
  { key: "dod", label: "완료 기준 (DoD)", sub: "Definition of Done", icon: "check", color: "#12B886", scope: "common" },
  { key: "changelog", label: "변경 이력", sub: "릴리스 노트", icon: "refresh", color: "#F5A623", scope: "common" },
  { key: "glossary", label: "용어집", sub: "도메인 용어", icon: "tag", color: "#7165E3", scope: "common" },
  { key: "onboarding", label: "온보딩", sub: "시작 가이드", icon: "user", color: "#2F62FF", scope: "common" },
  { key: "graph", label: "그래프 뷰", sub: "위키링크 연결", icon: "link", color: "#12B886", scope: "common" },
  { key: "lint", label: "위키 점검", sub: "깨진 링크·고아", icon: "alert", color: "#F0494E", scope: "common" },
];

/* ---------- 날짜 ---------- */
function fmtEditedShort(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} 수정`;
}
function fmtEditedLong(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

/* ---------- 문서 행 ---------- */
function DocRow({ doc, onOpen }: { doc: DocItem; onOpen: (d: DocItem) => void }) {
  return (
    <div className="ws-doc-row" onClick={() => onOpen(doc)} role="button" tabIndex={0}>
      <div className="ws-doc-ico">
        <Icon name="doc" size={19} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div title={doc.title} style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {doc.title || "제목 없음"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{fmtEditedShort(doc.updatedAt)}</div>
      </div>
      <Icon name="chevronRight" size={16} />
    </div>
  );
}

/* ---------- '문서' surface (리스트) ---------- */
function DocsList({
  docs,
  loading,
  projectId,
  onOpen,
  onCreate,
  creating,
}: {
  docs: DocItem[];
  loading: boolean;
  projectId: string;
  onOpen: (d: DocItem) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => filterDocs(docs, { query: q, projectId }), [docs, q, projectId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <div className="ws-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="문서 검색" aria-label="문서 검색" />
        </div>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={onCreate} disabled={creating}>
          <Icon name="plus" size={15} />
          새 문서
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {loading ? (
            <div className="ws-empty-hint">불러오는 중…</div>
          ) : filtered.length > 0 ? (
            <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "4px 10px" }}>
              {filtered.map((d, idx) => (
                <div key={d.id} style={idx > 0 ? { borderTop: "1px solid var(--border-subtle)" } : undefined}>
                  <DocRow doc={d} onOpen={onOpen} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}>
                <Icon name="doc" size={34} />
              </span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>
                {q.trim() ? "검색 결과가 없어요" : "문서가 없어요"}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>
                {q.trim() ? "다른 검색어로 시도해 보세요." : "새 문서를 만들어 마크다운으로 기록을 시작하세요."}
              </div>
              {!q.trim() && (
                <button className="ws-btn-soft" style={{ marginTop: 16 }} onClick={onCreate} disabled={creating}>
                  <Icon name="plus" size={15} />
                  새 문서
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 문서 리더 ---------- */
function DocReader({ doc, docs, onBack, onOpen }: { doc: DocItem; docs: DocItem[]; onBack: () => void; onOpen: (d: DocItem) => void }) {
  const router = useRouter();
  const [md, setMd] = useState("");
  const [title, setTitle] = useState(doc.title);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(true);
  const [backlinks, setBacklinks] = useState<{ id: string; title: string }[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [revs, setRevs] = useState<{ rev: number; title: string; authorName: string | null; createdAt: string }[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [comments, setComments] = useState<{ id: string; body: string; authorName: string; authorIsAgent: boolean; createdAt: string }[] | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const loadComments = useCallback(async () => {
    const r = await fetch(`/api/pages/${doc.id}/comments`, { cache: "no-store" });
    if (r.ok) setComments(((await r.json()) as { comments: typeof comments }).comments ?? []);
  }, [doc.id]);

  async function postComment() {
    const text = commentDraft.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const r = await fetch(`/api/pages/${doc.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (r.ok) {
        setCommentDraft("");
        await loadComments();
      }
    } finally {
      setPosting(false);
    }
  }

  async function toggleHistory() {
    const next = !histOpen;
    setHistOpen(next);
    if (next && revs === null) {
      const r = await fetch(`/api/pages/${doc.id}/revisions`, { cache: "no-store" });
      if (r.ok) setRevs(((await r.json()) as { revisions: typeof revs }).revisions ?? []);
      else setRevs([]);
    }
  }

  async function restoreRev(rev: number) {
    if (restoring) return;
    setRestoring(true);
    try {
      const r = await fetch(`/api/pages/${doc.id}/revisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rev }),
      });
      if (r.ok) {
        const fresh = await fetch(`/api/pages/${doc.id}`, { cache: "no-store" });
        if (fresh.ok) {
          const d = (await fresh.json()) as { page?: { title?: string }; markdown?: string };
          setMd(d.markdown ?? "");
          if (d.page?.title) setTitle(d.page.title);
        }
        setRevs(null);
        setHistOpen(false);
        window.dispatchEvent(new CustomEvent("pages:changed"));
      }
    } finally {
      setRestoring(false);
    }
  }

  // [[제목]] → /p/<id> (워크스페이스 문서 제목 매칭, 대소문자 무시)
  const resolveLink = useMemo(() => {
    const byTitle = new Map(docs.map((d) => [d.title.trim().toLowerCase(), d.id]));
    return (t: string) => {
      const id = byTitle.get(t.trim().toLowerCase());
      return id ? `/p/${id}` : null;
    };
  }, [docs]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/pages/${doc.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { page?: { title?: string }; markdown?: string } | null) => {
        if (!alive || !data) return;
        setMd(data.markdown ?? "");
        if (data.page?.title) setTitle(data.page.title);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadComments();
    fetch(`/api/pages/${doc.id}/backlinks`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { backlinks?: { id: string; title: string }[] } | null) => {
        if (alive && data?.backlinks) setBacklinks(data.backlinks);
      });
    return () => {
      alive = false;
    };
  }, [doc.id, loadComments]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <button className="ws-btn-soft" onClick={onBack}>
          <Icon name="chevronLeft" size={15} />
          문서
        </button>
        <span className="ws-md-badge" style={badgeStyle}>
          <Icon name="doc" size={12} />
          {(title || "문서") + ".md"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ws-toggle-md" data-on={preview ? "1" : "0"} onClick={() => setPreview((v) => !v)}>
          {preview ? "미리보기" : "마크다운"}
        </button>
        <button className="ws-btn-soft" onClick={toggleHistory}>
          <Icon name="clock" size={14} />
          히스토리
        </button>
        <button className="ws-btn-soft" onClick={() => router.push(`/p/${doc.id}`)}>
          <Icon name="settings" size={14} />
          편집
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "32px 24px 80px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "-0.02em", margin: "0 0 4px" }}>
            {title || "제목 없음"}
          </h1>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 18 }}>마지막 수정 {fmtEditedLong(doc.updatedAt)}</div>

          {histOpen && (
            <div style={{ marginBottom: 18, border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8 }}>
                <Icon name="clock" size={14} /> 버전 히스토리
              </div>
              {revs === null ? (
                <div className="ws-empty-hint">불러오는 중…</div>
              ) : revs.length === 0 ? (
                <div className="ws-empty-hint">아직 저장된 버전이 없습니다. (이후 저장부터 적재됩니다)</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {revs.map((r) => (
                    <div key={r.rev} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 8 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-muted)", width: 34 }}>v{r.rev}</span>
                      <span style={{ flex: 1, fontSize: 12.5, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {new Date(r.createdAt).toLocaleString("ko-KR")} {r.authorName ? `· ${r.authorName}` : ""}
                      </span>
                      <button className="ws-btn-soft" disabled={restoring} onClick={() => void restoreRev(r.rev)}>
                        복원
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="ws-empty-hint">불러오는 중…</div>
          ) : preview ? (
            <MarkdownPreview markdown={md} resolveLink={resolveLink} />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7, color: "var(--text-body)", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "16px 18px", margin: 0 }}>
              {md || "(빈 문서)"}
            </pre>
          )}

          {/* 코멘트 (W6) */}
          <div style={{ marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 10 }}>
              <Icon name="comment" size={14} /> 코멘트 {comments ? comments.length : ""}
            </div>
            {comments === null ? (
              <div className="ws-empty-hint">불러오는 중…</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {comments.map((c) => (
                  <div key={c.id} style={{ padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)" }}>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 3 }}>
                      <b style={{ color: "var(--text-strong)" }}>{c.authorName}</b>
                      {c.authorIsAgent && <span style={{ marginLeft: 6, fontSize: 10.5, padding: "1px 6px", borderRadius: 6, background: "var(--surface-sunken)", color: "var(--text-muted)" }}>에이전트</span>}
                      {" · "}{new Date(c.createdAt).toLocaleString("ko-KR")}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-body)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.body}</div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void postComment(); }}
                    placeholder="코멘트 작성 — @이름 으로 멘션하면 알림이 갑니다"
                    style={{ flex: 1, padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" }}
                  />
                  <button className="ws-btn-soft" onClick={() => void postComment()} disabled={posting || !commentDraft.trim()}>등록</button>
                </div>
              </div>
            )}
          </div>

          {/* 백링크 */}
          {backlinks.length > 0 && (
            <div style={{ marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 10 }}>
                <Icon name="link" size={14} /> 이 문서를 참조하는 문서 {backlinks.length}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {backlinks.map((b) => {
                  const target = docs.find((d) => d.id === b.id);
                  return (
                    <button
                      key={b.id}
                      onClick={() => target && onOpen(target)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 8, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                    >
                      <Icon name="doc" size={13} /> {b.title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const badgeStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11.5,
  color: "var(--text-sub)", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)",
  padding: "4px 9px", borderRadius: 7, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

/* ---------- 준비 중 surface ---------- */
function ComingSoon({ cat }: { cat: Cat }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${cat.color} 13%, var(--surface-card))`, color: cat.color }}>
          <Icon name={cat.icon} size={26} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-strong)" }}>{cat.label}</div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.7 }}>
          {cat.sub} · 구조화 화면은 곧 추가됩니다. 지금은 ‘문서’ 카테고리에서 마크다운 문서를 관리할 수 있어요.
        </div>
      </div>
    </div>
  );
}

/* ---------- 카테고리 레일 ---------- */
function CatItem({ cat, active, onGo }: { cat: Cat; active: boolean; onGo: () => void }) {
  return (
    <button
      onClick={onGo}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
        padding: "8px 10px", borderRadius: 9, border: "none", cursor: "pointer",
        background: active ? "var(--surface-hover, var(--surface-sunken))" : "transparent",
        color: "var(--text-body)", font: "inherit",
      }}
    >
      <span style={{ display: "flex", color: active ? cat.color : "var(--text-muted)", flex: "0 0 auto" }}>
        <Icon name={cat.icon} size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: active ? "var(--text-strong)" : "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cat.label}</span>
        <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cat.sub}</span>
      </span>
    </button>
  );
}

/* ---------- 카테고리 칩 (모바일 가로 레일) ---------- */
function CatChip({ cat, active, onGo }: { cat: Cat; active: boolean; onGo: () => void }) {
  return (
    <button
      onClick={onGo}
      style={{
        flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6,
        padding: "7px 12px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap", font: "inherit",
        border: `1px solid ${active ? "var(--color-primary)" : "var(--border-default)"}`,
        background: active ? "var(--color-primary-weak)" : "var(--surface-card)",
        color: active ? "var(--color-primary)" : "var(--text-body)",
      }}
    >
      <Icon name={cat.icon} size={15} />
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{cat.label}</span>
    </button>
  );
}

/* ---------- 태스크 보드 패널 (프로젝트 선택 시 문서 위에 함께 표시) ---------- */
function BoardPanel({
  pageId,
  projectName,
  expanded,
  onToggle,
}: {
  pageId: string;
  projectName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        maxHeight: expanded ? "min(52vh, 520px)" : undefined,
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--surface-card)",
      }}
    >
      <div className="ws-filterbar">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "var(--text-strong)" }}>
          <span style={{ display: "flex", color: "var(--color-primary)" }}>
            <Icon name="board" size={16} />
          </span>
          태스크 보드
          <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>· {projectName}</span>
        </span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => router.push(`/p/${pageId}?view=board`)} title="보드 전체화면으로 열기">
          <Icon name="board" size={14} />
          전체화면
        </button>
        <button className="ws-btn-soft" onClick={onToggle} aria-expanded={expanded}>
          <Icon name="chevronDown" size={15} style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
          {expanded ? "접기" : "펼치기"}
        </button>
      </div>
      {expanded && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <DatabaseView key={pageId} pageId={pageId} embedded defaultViewType="kanban" />
        </div>
      )}
    </div>
  );
}

/* ---------- 문서 허브 ---------- */
export default function Docs() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState("mddocs");
  const [project, setProject] = useState("");
  const [selected, setSelected] = useState<DocItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [showBoard, setShowBoard] = useState(true);
  // 실제 '데이터베이스' 종류 페이지 id 집합 — 태스크 보드 패널을 진짜 DB일 때만 띄우기 위함
  // (boardPageId 는 DB가 없으면 문서 페이지로 폴백되므로 그대로 임베드하면 빈 보드가 뜬다)
  const [dbPageIds, setDbPageIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [pagesRes, projectsRes] = await Promise.all([
      fetch("/api/pages", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (!pagesRes.ok) {
      setLoading(false);
      return;
    }
    const data = (await pagesRes.json()) as { pages: DocItem[] };
    setDocs(data.pages.filter((p) => p.kind === "doc").sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)));
    setDbPageIds(new Set(data.pages.filter((p) => p.kind === "database").map((p) => p.id)));
    if (projectsRes.ok) {
      const pj = (await projectsRes.json()) as {
        projects: { id: string; name: string; boardPageId: string | null }[];
      };
      setProjects(pj.projects.map((p) => ({ id: p.id, name: p.name, boardPageId: p.boardPageId })));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const onChanged = () => load();
    window.addEventListener("pages:changed", onChanged);
    return () => window.removeEventListener("pages:changed", onChanged);
  }, [load]);
  useAutoRefresh(load); // W6: 30초 폴링+포커스 갱신

  const onCreate = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Untitled" }),
      });
      if (res.ok) {
        const { page } = (await res.json()) as { page: { id: string } };
        window.dispatchEvent(new Event("pages:changed"));
        router.push(`/p/${page.id}`);
      }
    } finally {
      setCreating(false);
    }
  }, [router]);

  const isMobile = useIsMobile();
  const activeCat = DOC_CATS.find((c) => c.key === active)!;
  const switcherDisabled = activeCat.scope === "common";

  // 프로젝트-범위 카테고리에서 특정 프로젝트가 선택되고 그 프로젝트에 보드가 있으면
  // 문서 위에 태스크 보드를 함께 보여준다.
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === project) ?? null,
    [projects, project],
  );
  const boardPageId = selectedProject?.boardPageId ?? null;
  // boardPageId 가 실제 데이터베이스 페이지일 때만 보드 패널 노출(문서 폴백 제외)
  const showBoardPanel =
    activeCat.scope === "project" && !!boardPageId && dbPageIds.has(boardPageId);
  const projItems = DOC_CATS.filter((c) => c.scope === "project");
  const commonItems = DOC_CATS.filter((c) => c.scope === "common");

  const projectSelect = (
    <select
      value={project}
      onChange={(e) => setProject(e.target.value)}
      disabled={switcherDisabled}
      aria-label="프로젝트 전환"
      title={switcherDisabled ? "제품 공통 문서예요 — 프로젝트와 무관" : "프로젝트 전환"}
      style={{ width: "100%", height: 34, padding: "0 8px", border: "1px solid var(--border-default)", borderRadius: 9, background: "var(--surface-card)", color: "var(--text-body)", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", outline: "none", opacity: switcherDisabled ? 0.5 : 1 }}
    >
      <option value="">전체 프로젝트</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
      <option value={NO_PROJECT}>미분류</option>
    </select>
  );

  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", height: "100%", minHeight: 0 }}>
      {/* 카테고리 레일 — 데스크톱: 좌측 232px 세로 / 모바일: 상단 가로 스크롤 칩 */}
      {isMobile ? (
        <nav style={{ flex: "0 0 auto", borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-card)", display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px 8px" }}>
          {projectSelect}
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
            {DOC_CATS.map((c) => (
              <CatChip key={c.key} cat={c} active={active === c.key} onGo={() => { setActive(c.key); setSelected(null); }} />
            ))}
          </div>
        </nav>
      ) : (
        <nav style={{ flex: "0 0 232px", borderRight: "1px solid var(--border-subtle)", background: "var(--surface-card)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: 10, borderBottom: "1px solid var(--border-subtle)" }}>
            {projectSelect}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
            <div style={railLabel}>프로젝트 문서</div>
            {projItems.map((c) => (
              <CatItem key={c.key} cat={c} active={active === c.key} onGo={() => { setActive(c.key); setSelected(null); }} />
            ))}
            <div style={{ ...railLabel, marginTop: 14 }}>제품 공통</div>
            {commonItems.map((c) => (
              <CatItem key={c.key} cat={c} active={active === c.key} onGo={() => { setActive(c.key); setSelected(null); }} />
            ))}
          </div>
        </nav>
      )}

      {/* surface */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {showBoardPanel && (
          <BoardPanel
            pageId={boardPageId!}
            projectName={selectedProject!.name}
            expanded={showBoard}
            onToggle={() => setShowBoard((v) => !v)}
          />
        )}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {active === "mddocs" ? (
          selected ? (
            <DocReader key={selected.id} doc={selected} docs={docs} onBack={() => setSelected(null)} onOpen={setSelected} />
          ) : (
            <DocsList docs={docs} loading={loading} projectId={project} onOpen={setSelected} onCreate={onCreate} creating={creating} />
          )
        ) : active === "decisions" ? (
          <DecisionsSurface project={project} />
        ) : active === "lessons" ? (
          <LessonsSurface project={project} />
        ) : active === "risks" ? (
          <RisksSurface project={project} />
        ) : active === "qa" ? (
          <QaSurface project={project} />
        ) : active === "glossary" ? (
          <GlossarySurface />
        ) : active === "changelog" ? (
          <ChangelogSurface />
        ) : active === "datamodel" ? (
          <DataModelSurface />
        ) : active === "dod" ? (
          <DodSurface />
        ) : active === "onboarding" ? (
          <OnboardingSurface />
        ) : active === "graph" ? (
          <GraphSurface />
        ) : active === "lint" ? (
          <LintSurface />
        ) : (
          <ComingSoon cat={activeCat} />
        )}
        </div>
      </div>
    </div>
  );
}

const railLabel: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "4px 10px 6px", textTransform: "uppercase", letterSpacing: "0.04em",
};
