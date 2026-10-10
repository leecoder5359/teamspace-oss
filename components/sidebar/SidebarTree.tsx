"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "../ws/icons";
import { DOC_TYPES, DOC_TYPE_LABEL, docTypeIcon, type DocType } from "@/lib/docOrganize";
import { isTaskNoteFolder, limitChildren, type Group, type PageNode } from "./treeModel";

export type CreatePageOpts = { parentId?: string | null; projectId?: string | null; title?: string; folder?: boolean };

export type SidebarTreeProps = {
  groups: Group[];
  collapsed: Set<string>;
  /** 접힘 상태가 정해졌나. 그 전엔 그룹 머리 행만 그린다(전부 펼친 채 한 프레임 깜빡이지 않게). */
  ready: boolean;
  toggle: (key: string) => void;
  activeId: string | null;
  onNavigate?: () => void;
  /** 새 페이지 id 를 돌려준다(실패 시 null). 문서면 호출부가 이동, 폴더면 트리가 이름 편집에 들어간다. */
  createPage: (opts: CreatePageOpts) => Promise<string | null>;
  createBoard: (projectId: string | null) => Promise<void>;
  busy: boolean;
  loaded: boolean;
  move: (id: string, parentId: string | null, projectId: string | null) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (node: { id: string; title: string; hasChildren: boolean }) => Promise<void>;
  toggleFavorite: (pageId: string) => Promise<void>;
  setDocType: (pageId: string, t: DocType | null) => Promise<void>;
};

type Menu = { node: PageNode; hasChildren: boolean; x: number; y: number };

export function SidebarTree({
  groups, collapsed, ready, toggle, activeId, onNavigate, createPage, createBoard, busy, loaded, move, rename, remove, toggleFavorite, setDocType,
}: SidebarTreeProps) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<Set<string>>(() => new Set()); // 세션 동안만, 저장 안 함
  const menuRef = useRef<HTMLDivElement>(null);

  // 메뉴를 연 뒤 실제 크기를 재서 화면 안으로 당긴다(항목이 많아 아래·오른쪽으로 넘치지 않게).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`;
    el.style.left = `${Math.max(8, Math.min(menu.x - 180, window.innerWidth - r.width - 8))}px`;
  }, [menu]);

  // 컨텍스트 메뉴: 바깥 클릭/리사이즈 시 닫기
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const create = async (opts: CreatePageOpts) => {
    const id = await createPage(opts);
    if (!id) return;
    if (opts.parentId && collapsed.has(opts.parentId)) toggle(opts.parentId);
    if (opts.folder) {
      // 폴더는 바로 이름 편집 모드로
      setRenaming(id);
      setDraft("새 폴더");
    }
  };

  const commitRename = (id: string, title: string) => {
    setRenaming(null);
    void rename(id, title);
  };

  const moreButton = (key: string, hidden: number) =>
    hidden > 0 ? (
      <li key={`more:${key}`}>
        <button className="ws-tree-more" onClick={() => setMoreOpen((s) => new Set(s).add(key))}>{hidden}개 더 보기</button>
      </li>
    ) : null;

  // ── 렌더: 문서/폴더 노드(재귀) ──
  const renderNode = (node: PageNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const open = !collapsed.has(node.id);
    const active = node.id === activeId;
    const isRenaming = renaming === node.id;
    const isDrop = dropKey === node.id;
    const muted = isTaskNoteFolder(node);
    const kids = limitChildren(node.children, moreOpen.has(node.id));

    return (
      <li key={node.id}>
        <div
          className={`ws-tree-row${muted ? " ws-tree-row--muted" : ""}${active ? " active" : ""}${isDrop ? " drop-over" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={!isRenaming}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ node, hasChildren, x: e.clientX + 180, y: e.clientY });
          }}
          onDragStart={(e) => {
            setDragId(node.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropKey(null);
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id) return;
            e.preventDefault();
            if (dropKey !== node.id) setDropKey(node.id);
          }}
          onDragLeave={() => setDropKey((k) => (k === node.id ? null : k))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== node.id) void move(dragId, node.id, node.projectId);
            setDragId(null);
            setDropKey(null);
          }}
        >
          <button
            className="ws-tree-twist"
            onClick={() => (hasChildren ? toggle(node.id) : undefined)}
            aria-label={hasChildren ? (open ? "접기" : "펼치기") : undefined}
            tabIndex={hasChildren ? 0 : -1}
            style={{ visibility: hasChildren ? "visible" : "hidden" }}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          </button>
          {/* 사용자가 직접 고른 아이콘이 있으면 그것이 우선 */}
          <span className="ws-tree-icon">{node.icon ?? (hasChildren ? "📁" : docTypeIcon(node.docType))}</span>
          {/* D3 후속: 비공개 표시. 잠금이 시작된 지점에만 그린다 —
              자손마다 붙이면 트리가 자물쇠로 뒤덮여 오히려 안 읽힌다. */}
          {node.restrictedSelf && (
            <span
              title="비공개 — 부여받은 사람만 볼 수 있습니다(하위 문서도 함께)"
              style={{ display: "inline-flex", alignItems: "center", color: "#E0900F", marginRight: 2, flexShrink: 0 }}
            >
              <Icon name="lock" size={12} />
            </span>
          )}
          {isRenaming ? (
            <input
              className="ws-tree-rename"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(node.id, draft);
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => commitRename(node.id, draft)}
            />
          ) : (
            <Link href={`/p/${node.id}`} className="ws-tree-name" onClick={onNavigate} title={node.title || "제목 없음"}>
              {node.title || "제목 없음"}
            </Link>
          )}
          {hasChildren && <span className="ws-nav-count">{node.childCount ?? node.children.length}</span>}
          <span className="ws-row-actions">
            <button
              className="ws-icon-btn ws-row-act"
              title="문서 추가"
              onClick={(e) => {
                e.stopPropagation();
                void create({ parentId: node.id, projectId: node.projectId });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              className="ws-icon-btn ws-row-act"
              title="더보기"
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ node, hasChildren, x: r.right, y: r.bottom + 4 });
              }}
            >
              <Icon name="dots" size={15} />
            </button>
          </span>
        </div>
        {hasChildren && open && (
          <ul className="ws-tree">
            {kids.shown.map((c) => renderNode(c, depth + 1))}
            {moreButton(node.id, kids.hidden)}
          </ul>
        )}
      </li>
    );
  };

  const projectCount = groups.filter((g) => g.isProject).length;

  return (
    <div className="ws-nav-section">
      <div className="ws-section-label">
        <Link href="/projects" onClick={onNavigate} title="모든 프로젝트" className="ws-section-link" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "inherit", textDecoration: "none" }}>
          <span>프로젝트</span>
          <span className="ws-nav-count">{projectCount}</span>
        </Link>
        <Link
          href="/projects"
          className="ws-icon-btn ws-section-add"
          onClick={onNavigate}
          title="새 프로젝트"
          aria-label="새 프로젝트"
          style={{ width: 22, height: 22, marginLeft: "auto" }}
        >
          <Icon name="plus" size={15} />
        </Link>
      </div>

      {groups.map((g) => {
        const open = !collapsed.has(g.key);
        const isDrop = dropKey === g.key;
        const rootKey = `root:${g.key}`;
        const roots = limitChildren(g.roots, moreOpen.has(rootKey));
        return (
          <div key={g.key} className="ws-doc-group">
            <div
              className={`ws-tree-row ws-group-row${isDrop ? " drop-over" : ""}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                if (dropKey !== g.key) setDropKey(g.key);
              }}
              onDragLeave={() => setDropKey((k) => (k === g.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) void move(dragId, null, g.isProject ? g.key : null);
                setDragId(null);
                setDropKey(null);
              }}
            >
              <button className="ws-tree-twist" onClick={() => toggle(g.key)} aria-label={open ? "접기" : "펼치기"}>
                <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
              </button>
              <span className="ws-tree-icon">{g.isProject ? "📁" : "🗄"}</span>
              <button className="ws-tree-name ws-group-name" onClick={() => toggle(g.key)} title={g.name}>
                {g.name}
              </button>
              {g.isProject && (
                <span className="ws-row-actions">
                  <button className="ws-icon-btn ws-row-act" title="문서 추가" onClick={() => void create({ projectId: g.key })}>
                    <Icon name="plus" size={14} />
                  </button>
                  <button className="ws-icon-btn ws-row-act" title="폴더 추가" onClick={() => void create({ projectId: g.key, folder: true })}>
                    <Icon name="folder" size={14} />
                  </button>
                </span>
              )}
            </div>

            {ready && open && (
              <ul className="ws-tree">
                {/* 보드 행 */}
                {g.boards.map((b) => (
                  <li key={b.id}>
                    <div className={`ws-tree-row${activeId === b.id ? " active" : ""}`} style={{ paddingLeft: 20 }}>
                      <span className="ws-tree-twist" style={{ visibility: "hidden" }} />
                      <span className="ws-tree-icon"><Icon name="board" size={15} /></span>
                      <Link href={`/p/${b.id}?view=kanban`} className="ws-tree-name" onClick={onNavigate} title={b.title}>
                        {b.title || "태스크 보드"}
                      </Link>
                    </div>
                  </li>
                ))}
                {g.isProject && g.boards.length === 0 && (
                  <li>
                    <button className="ws-tree-row ws-tree-add" style={{ paddingLeft: 20 }} onClick={() => void createBoard(g.key)} disabled={busy}>
                      <span className="ws-tree-twist" style={{ visibility: "hidden" }} />
                      <span className="ws-tree-icon"><Icon name="board" size={15} /></span>
                      <span className="ws-tree-name" style={{ color: "var(--text-muted)" }}>태스크 보드 만들기</span>
                    </button>
                  </li>
                )}
                {/* 문서/폴더 트리 */}
                {roots.shown.map((n) => renderNode(n, 1))}
                {moreButton(rootKey, roots.hidden)}
                {g.boards.length === 0 && g.roots.length === 0 && !g.isProject && (
                  <li className="ws-tree-empty">비어 있음</li>
                )}
              </ul>
            )}
          </div>
        );
      })}
      {groups.length === 0 && loaded && <div className="ws-tree-empty">프로젝트가 없습니다</div>}

      {/* 컨텍스트 메뉴 (… 버튼·우클릭) */}
      {menu && (
        <div ref={menuRef} className="ws-ctx-menu" style={{ top: menu.y, left: Math.max(8, menu.x - 180) }} onClick={(e) => e.stopPropagation()}>
          <button className="ws-ctx-item" onClick={() => { void toggleFavorite(menu.node.id); setMenu(null); }}>
            {menu.node.isFavorite ? "★ 즐겨찾기 해제" : "☆ 즐겨찾기 추가"}
          </button>
          <button className="ws-ctx-item" onClick={() => { setRenaming(menu.node.id); setDraft(menu.node.title); setMenu(null); }}>
            이름 변경
          </button>
          <button className="ws-ctx-item" onClick={() => { void create({ parentId: menu.node.id, projectId: menu.node.projectId }); setMenu(null); }}>
            문서 추가
          </button>
          <button className="ws-ctx-item" onClick={() => { void create({ parentId: menu.node.id, projectId: menu.node.projectId, folder: true }); setMenu(null); }}>
            폴더 추가
          </button>
          <div className="ws-ctx-sep" />
          <div className="ws-ctx-sub">종류</div>
          {DOC_TYPES.map((t) => (
            <button key={t} className={`ws-ctx-item${menu.node.docType === t ? " active" : ""}`} onClick={() => { void setDocType(menu.node.id, t); setMenu(null); }}>
              {docTypeIcon(t)} {DOC_TYPE_LABEL[t]}
            </button>
          ))}
          <div className="ws-ctx-sep" />
          <button className="ws-ctx-item danger" onClick={() => { void remove({ id: menu.node.id, title: menu.node.title, hasChildren: menu.hasChildren }); setMenu(null); }}>
            삭제
          </button>
        </div>
      )}
    </div>
  );
}
