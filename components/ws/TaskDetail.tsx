"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./icons";
import {
  Avatar,
  DDay,
  Dot,
  IdChip,
  LabelChip,
  PriorityTag,
  ProgressBar,
  SeverityBadge,
  StatusPill,
  fmtDateK,
  shortId,
} from "./ui";
import type { DbProperty, DbRow, Role, SelectOption } from "../DatabaseView";

/* 태스크 상세 드로어 — 제네릭 DbRow 모델 위에 Saebit detail.jsx 를 포팅.
   속성 편집(Menu/인라인) · 관련 문서 · .md 설명(미리보기 토글) · 체크리스트 · 댓글. */

type TaskDetailProps = {
  row: DbRow;
  properties: DbProperty[];
  roles: Map<string, Role>;
  titleId: string | null;
  onChange: (propId: string, value: unknown) => void;
  onClose: () => void;
};

function optionById(prop: DbProperty | undefined, id: unknown): SelectOption | undefined {
  if (!prop?.config?.options || typeof id !== "string") return undefined;
  return prop.config.options.find((o) => o.id === id);
}

function roleIcon(role: Role): Parameters<typeof Icon>[0]["name"] {
  switch (role) {
    case "person":
      return "user";
    case "priority":
      return "flag";
    case "severity":
      return "alert";
    case "date":
      return "calendar";
    case "label":
      return "tag";
    case "progress":
      return "circle";
    case "number":
      return "hash";
    case "checkbox":
      return "check";
    default:
      return "doc";
  }
}

/* ---------- click-outside 닫힘 드롭다운 ---------- */
function Menu({
  triggerClass,
  trigger,
  children,
}: {
  triggerClass: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="ws-menu-wrap" ref={ref}>
      <button type="button" className={triggerClass} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/* ---------- select/multiselect 옵션 선택 메뉴 ---------- */
function OptionMenu({
  prop,
  value,
  display,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  display: ReactNode;
  onChange: (v: unknown) => void;
}) {
  const options = prop.config?.options ?? [];
  return (
    <Menu
      triggerClass="ws-prop-trigger"
      trigger={
        <>
          {display}
          <Icon name="chevronDown" size={13} />
        </>
      }
    >
      {(close) => (
        <>
          <button
            type="button"
            className="ws-menuitem"
            onClick={() => {
              onChange(null);
              close();
            }}
          >
            <Dot color="gray" size={6} />
            없음
          </button>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="ws-menuitem"
              onClick={() => {
                onChange(o.id);
                close();
              }}
            >
              <Dot color={o.color} size={6} />
              {o.name}
              {value === o.id && <Icon name="check" size={13} style={{ marginLeft: "auto" }} />}
            </button>
          ))}
        </>
      )}
    </Menu>
  );
}

/* ---------- 속성 행 ---------- */
function PropRow({ icon, label, children }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; children: ReactNode }) {
  return (
    <div className="ws-prop-row">
      <span className="ws-prop-label">
        <Icon name={icon} size={14} />
        {label}
      </span>
      <span className="ws-prop-value">{children}</span>
    </div>
  );
}

function PropEditor({
  prop,
  role,
  value,
  onChange,
}: {
  prop: DbProperty;
  role: Role;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const opt = optionById(prop, value);

  if (role === "priority") {
    return (
      <OptionMenu
        prop={prop}
        value={value}
        onChange={onChange}
        display={opt ? <PriorityTag label={opt.name} color={opt.color} /> : <span className="ws-pill-empty">미지정</span>}
      />
    );
  }
  if (role === "severity") {
    return (
      <OptionMenu
        prop={prop}
        value={value}
        onChange={onChange}
        display={opt ? <SeverityBadge label={opt.name} color={opt.color} /> : <span className="ws-pill-empty">미지정</span>}
      />
    );
  }
  if (role === "label") {
    return (
      <OptionMenu
        prop={prop}
        value={value}
        onChange={onChange}
        display={opt ? <LabelChip label={opt.name} color={opt.color} /> : <span className="ws-pill-empty">미지정</span>}
      />
    );
  }

  if (role === "person") {
    const name = typeof value === "string" ? value.split(/[,，]/)[0]?.trim() ?? "" : "";
    return (
      <>
        {name && <Avatar name={name} size={22} />}
        <input
          className="ws-prop-input"
          type="text"
          placeholder="담당자"
          defaultValue={typeof value === "string" ? value : ""}
          onBlur={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </>
    );
  }

  if (role === "date") {
    return (
      <>
        <DDay value={value} />
        {fmtDateK(value) && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{fmtDateK(value)}</span>}
        <input
          className="ws-prop-date"
          type="date"
          value={typeof value === "string" ? value.slice(0, 10) : ""}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label={prop.name}
        />
      </>
    );
  }

  if (role === "progress" || role === "number") {
    return (
      <>
        {role === "progress" && typeof value === "number" && <ProgressBar value={value} />}
        <input
          className="ws-prop-input"
          type="number"
          defaultValue={typeof value === "number" ? value : ""}
          onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{ width: 120 }}
        />
      </>
    );
  }

  if (role === "checkbox") {
    return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }

  // text
  return (
    <input
      className="ws-prop-input"
      type="text"
      defaultValue={typeof value === "string" ? value : ""}
      onBlur={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/* ---------- 가벼운 마크다운 렌더 ---------- */
function inlineMd(text: string, base: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let k = base;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3] !== undefined) nodes.push(<code key={k++}>{m[3]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdown(md: string): ReactNode {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(<pre key={key++}>{buf.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inlineMd(h[2], key * 100);
      if (level === 1) blocks.push(<h3 key={key++}>{content}</h3>);
      else if (level === 2) blocks.push(<h4 key={key++}>{content}</h4>);
      else blocks.push(<h5 key={key++}>{content}</h5>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((t, j) => (
            <li key={j}>{inlineMd(t, j * 100)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("```")
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{inlineMd(buf.join(" "), key * 100)}</p>);
  }
  return blocks;
}

type Tab = "desc" | "check" | "comment";
type ChecklistItem = { id: string; text: string; done: boolean };
type RowCommentT = { id: string; body: string; createdAt: string; user: { id: string; name: string | null; image: string | null } | null };

const taskInp: CSSProperties = {
  flex: 1,
  height: 34,
  border: "1px solid var(--border-default)",
  borderRadius: 9,
  background: "var(--surface-sunken)",
  padding: "0 12px",
  fontSize: 13,
  color: "var(--text-strong)",
  fontFamily: "inherit",
  outline: "none",
};

export default function TaskDetail({ row, properties, roles, titleId, onChange, onClose }: TaskDetailProps) {
  const titleProp = properties.find((p) => p.id === titleId) ?? properties[0];
  const statusProp = properties.find((p) => roles.get(p.id) === "status");
  const statusOpt = optionById(statusProp, statusProp ? row.props[statusProp.id] : undefined);

  // 상세 속성 행: title/status 제외
  const propRows = properties.filter((p) => p.id !== titleId && p.id !== statusProp?.id);

  const [tab, setTab] = useState<Tab>("desc");
  const [toast, setToast] = useState<string | null>(null);
  const [mdPreview, setMdPreview] = useState(true);
  const [md, setMd] = useState("");
  const [mdLoading, setMdLoading] = useState(false);

  const contentPageId = row.contentPageId ?? null;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  }, []);

  // Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 설명 본문 로드
  useEffect(() => {
    if (!contentPageId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMd("");
      return;
    }
    let alive = true;
    setMdLoading(true);
    fetch(`/api/pages/${contentPageId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { markdown?: string } | null) => {
        if (!alive) return;
        setMd(j?.markdown ?? "");
        setMdLoading(false);
      })
      .catch(() => {
        if (alive) setMdLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [contentPageId]);

  const title = typeof row.props[titleProp.id] === "string" ? (row.props[titleProp.id] as string) : "";

  // 체크리스트 / 댓글
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [comments, setComments] = useState<RowCommentT[]>([]);
  const [newCheck, setNewCheck] = useState("");
  const [newComment, setNewComment] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [cRes, mRes] = await Promise.all([
        fetch(`/api/rows/${row.id}/checklist`, { cache: "no-store" }),
        fetch(`/api/rows/${row.id}/comments`, { cache: "no-store" }),
      ]);
      if (!alive) return;
      if (cRes.ok) setChecklist(((await cRes.json()) as { items: ChecklistItem[] }).items);
      if (mRes.ok) setComments(((await mRes.json()) as { comments: RowCommentT[] }).comments);
    })();
    return () => { alive = false; };
  }, [row.id]);

  async function addCheck() {
    const text = newCheck.trim();
    if (!text) return;
    const res = await fetch(`/api/rows/${row.id}/checklist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (res.ok) { const { item } = (await res.json()) as { item: ChecklistItem }; setChecklist((c) => [...c, item]); setNewCheck(""); }
  }
  async function toggleCheck(item: ChecklistItem) {
    const res = await fetch(`/api/rows/${row.id}/checklist/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: !item.done }) });
    if (res.ok) setChecklist((c) => c.map((x) => (x.id === item.id ? { ...x, done: !item.done } : x)));
  }
  async function removeCheck(id: string) {
    const res = await fetch(`/api/rows/${row.id}/checklist/${id}`, { method: "DELETE" });
    if (res.ok) setChecklist((c) => c.filter((x) => x.id !== id));
  }
  async function addComment() {
    const body = newComment.trim();
    if (!body) return;
    const res = await fetch(`/api/rows/${row.id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (res.ok) { const { comment } = (await res.json()) as { comment: RowCommentT }; setComments((c) => [...c, comment]); setNewComment(""); }
  }

  const doneN = checklist.filter((c) => c.done).length;
  const tabs: { id: Tab; label: string }[] = [
    { id: "desc", label: "설명" },
    { id: "check", label: `체크리스트 ${doneN}/${checklist.length}` },
    { id: "comment", label: comments.length ? `댓글 ${comments.length}` : "댓글" },
  ];

  return (
    <div className="ws-drawer-wrap">
      <div className="ws-scrim" onClick={onClose} />
      <aside className="ws-drawer" role="dialog" aria-modal="true">
        {/* header */}
        <header className="ws-drawer-head">
          <IdChip id={shortId(row.id)} />
          <span className="ws-drawer-head-spacer" />
          <button
            type="button"
            className="ws-btn-soft"
            onClick={() => flash("슬랙 리마인드는 준비 중이에요")}
          >
            <Icon name="slack" size={15} />
            슬랙으로 리마인드
          </button>
          <button type="button" className="ws-icon-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" size={18} />
          </button>
        </header>

        {/* body */}
        <div className="ws-drawer-body">
          {/* 상태 + 제목 */}
          {statusProp ? (
            <Menu
              triggerClass="ws-status-trigger"
              trigger={
                <>
                  {statusOpt ? (
                    <StatusPill label={statusOpt.name} color={statusOpt.color} mode="soft" />
                  ) : (
                    <span className="ws-pill-empty">상태 없음</span>
                  )}
                  <Icon name="chevronDown" size={14} />
                </>
              }
            >
              {(close) => (
                <>
                  <button
                    type="button"
                    className="ws-menuitem"
                    onClick={() => {
                      onChange(statusProp.id, null);
                      close();
                    }}
                  >
                    <Dot color="gray" size={6} />
                    없음
                  </button>
                  {(statusProp.config?.options ?? []).map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className="ws-menuitem"
                      onClick={() => {
                        onChange(statusProp.id, o.id);
                        close();
                      }}
                    >
                      <Dot color={o.color} size={6} />
                      {o.name}
                    </button>
                  ))}
                </>
              )}
            </Menu>
          ) : null}

          <h2 className="ws-detail-title">
            <input
              className="ws-detail-title-input"
              defaultValue={title}
              placeholder="제목 없음"
              onBlur={(e) => {
                if (e.target.value !== title) onChange(titleProp.id, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </h2>

          {/* 속성 */}
          <div className="ws-prop-block">
            {propRows.map((p) => {
              const role = roles.get(p.id) ?? "text";
              return (
                <PropRow key={p.id} icon={roleIcon(role)} label={p.name}>
                  <PropEditor prop={p} role={role} value={row.props[p.id]} onChange={(v) => onChange(p.id, v)} />
                </PropRow>
              );
            })}
          </div>

          {/* 관련 문서 */}
          <div>
            <div className="ws-detail-section-head">
              <Icon name="doc" size={14} />
              관련 문서
            </div>
            {contentPageId ? (
              <div className="ws-docs-chips">
                <button type="button" className="ws-task-chip" onClick={() => setTab("desc")}>
                  <Icon name="doc" size={13} />
                  연결된 문서
                </button>
              </div>
            ) : (
              <div className="ws-empty-hint">연결된 문서가 없어요</div>
            )}
          </div>

          {/* 탭 */}
          <div className="ws-subtabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className="ws-subtab"
                data-on={tab === t.id ? "1" : "0"}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="ws-tabpane">
            {tab === "desc" &&
              (contentPageId ? (
                <>
                  <div className="ws-desc-bar">
                    <span className="ws-md-badge">
                      <Icon name="doc" size={12} />
                      {shortId(contentPageId, "DOC")}.md
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="ws-toggle-md"
                      data-on={mdPreview ? "1" : "0"}
                      onClick={() => setMdPreview((v) => !v)}
                    >
                      {mdPreview ? "미리보기" : "마크다운"}
                    </button>
                  </div>
                  {mdLoading ? (
                    <div className="ws-empty-hint">불러오는 중…</div>
                  ) : mdPreview ? (
                    <div className="ws-md-body">{md ? renderMarkdown(md) : <span className="ws-empty-hint">본문이 비어 있어요</span>}</div>
                  ) : (
                    <pre className="ws-md-pre">{md || "(빈 문서)"}</pre>
                  )}
                </>
              ) : (
                <div className="ws-empty-hint">이 태스크에 연결된 설명 문서가 없어요.</div>
              ))}

            {tab === "check" && (
              <div>
                {checklist.length > 0 && <div style={{ marginBottom: 10 }}><ProgressBar value={(doneN / checklist.length) * 100} /></div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {checklist.map((item) => (
                    <div key={item.id} className="ws-listrow" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 6px", borderRadius: 8 }}>
                      <button
                        type="button"
                        onClick={() => void toggleCheck(item)}
                        aria-label={item.done ? "완료 해제" : "완료"}
                        style={{ width: 18, height: 18, flex: "0 0 auto", borderRadius: 5, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", border: item.done ? "none" : "1.5px solid var(--border-default)", background: item.done ? "var(--color-success, #12B886)" : "transparent", color: "#fff" }}
                      >
                        {item.done && <Icon name="check" size={12} />}
                      </button>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: item.done ? "var(--text-muted)" : "var(--text-body)", textDecoration: item.done ? "line-through" : "none" }}>{item.text}</span>
                      <button type="button" onClick={() => void removeCheck(item.id)} title="삭제" aria-label="항목 삭제" style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "flex" }}><Icon name="close" size={13} /></button>
                    </div>
                  ))}
                  {checklist.length === 0 && <p className="ws-empty-hint">체크리스트가 없어요. 아래에서 항목을 추가하세요.</p>}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <input value={newCheck} onChange={(e) => setNewCheck(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addCheck(); }} placeholder="체크리스트 항목 추가" style={taskInp} aria-label="체크리스트 항목" />
                  <button type="button" className="ws-btn-soft" aria-label="체크리스트 항목 추가" title="체크리스트 항목 추가" onClick={() => void addCheck()} disabled={!newCheck.trim()}><Icon name="plus" size={14} /></button>
                </div>
              </div>
            )}

            {tab === "comment" && (
              <div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {comments.map((c) => (
                    <div key={c.id} style={{ display: "flex", gap: 10 }}>
                      <Avatar name={c.user?.name ?? "?"} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>{c.user?.name ?? "익명"}</span>
                          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{new Date(c.createdAt).toLocaleString("ko-KR")}</span>
                        </div>
                        <p style={{ fontSize: 13, color: "var(--text-body)", lineHeight: 1.55, margin: "3px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.body}</p>
                      </div>
                    </div>
                  ))}
                  {comments.length === 0 && <p className="ws-empty-hint">아직 댓글이 없어요.</p>}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <input value={newComment} onChange={(e) => setNewComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addComment(); }} placeholder="댓글을 남겨보세요" style={taskInp} aria-label="댓글" />
                  <button type="button" className="ws-btn-soft" onClick={() => void addComment()} disabled={!newComment.trim()}><Icon name="slack" size={14} /> 등록</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {toast && <div className="ws-detail-toast">{toast}</div>}
      </aside>
    </div>
  );
}
