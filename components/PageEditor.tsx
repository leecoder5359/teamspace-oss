"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { SuggestionMenuController, getDefaultReactSlashMenuItems, useCreateBlockNote } from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { wsSchema, CALLOUT_KINDS } from "./editor/schema";
import { parseMarkdown } from "@/lib/md/parse";
import { serializeMarkdown } from "@/lib/md/serialize";
import { astToBlocks, blocksToAst } from "@/lib/md/blocknote";
import { merge3, formatConflicts, hasConflictMarkers, type ConflictBlock } from "@/lib/merge3";
import type { BNBlock } from "@/lib/md/blocknote";
import type { Frontmatter } from "@/lib/md/ast";

/* =====================================================================
   문서 편집기(BlockNote).

   격차조사 A1 의 결론: 이 컴포넌트는 존재했지만 p/[id] 분기에서 도달할 수
   없어 dead code 였고, 실제 편집은 textarea 였다. 이제 doc 페이지가 여기로
   온다.

   저장 포맷은 마크다운 파일 그대로다(파일이 소스오브트루스라는 기존 계약을
   깨지 않는다). BlockNote 의 blocksToMarkdownLossy 대신 lib/md 의 변환기를
   쓴다 — 손실 변환이면 열고 저장하는 것만으로 본문이 깎이기 때문이다.

   프론트매터는 블록 트리 밖에 있어서(BlockNote 에 담을 자리가 없다) 로드
   시점에 떼어 두었다가 저장 때 다시 붙인다.
   ===================================================================== */

type SaveState = "idle" | "loading" | "loadError" | "saving" | "saved" | "error" | "conflict";
type PageLite = { id: string; title: string };

export default function PageEditor({ pageId }: { pageId: string }) {
  const editor = useCreateBlockNote({ schema: wsSchema });
  const [title, setTitle] = useState("");
  const [state, setState] = useState<SaveState>("loading");

  const loadedRef = useRef(false);
  const titleRef = useRef("");
  const revRef = useRef(0);
  const frontmatterRef = useRef<Frontmatter | null>(null);
  // 내가 문서를 열었을 때의 본문 — 3-way 병합의 base. 이게 없으면 충돌 시
  // "누가 무엇을 바꿨는지" 를 알 수 없어 한쪽을 버리는 수밖에 없다.
  const baseMarkdownRef = useRef("");
  const [conflict, setConflict] = useState<{
    mine: string;
    theirs: string;
    merged: string;
    conflicts: ConflictBlock[];
    serverRev: number;
  } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // [[ 자동완성용 문서 목록 (B4)
  const [pages, setPages] = useState<PageLite[]>([]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __bnEditor?: typeof editor }).__bnEditor = editor;
    }
  }, [editor]);

  /* ── 로드: 마크다운 → 블록 ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/pages/${pageId}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) throw new Error(`load ${res.status}`);
        const data = (await res.json()) as { page: { title: string; rev?: number }; markdown: string };
        if (cancelled) return;

        revRef.current = data.page.rev ?? 0;
        const doc = parseMarkdown(data.markdown ?? "");
        frontmatterRef.current = doc.frontmatter;
        baseMarkdownRef.current = data.markdown ?? "";

        const blocks = astToBlocks(doc.blocks);
        // 빈 문서도 편집 가능해야 하므로 최소 한 블록은 넣는다
        editor.replaceBlocks(editor.document, (blocks.length ? blocks : [{ type: "paragraph" }]) as never);

        setTitle(data.page.title);
        titleRef.current = data.page.title;
        loadedRef.current = true;
        setState("idle");
      } catch (e) {
        // 여기서 삼키면 "불러오는 중…" 에 영원히 머문다(파싱·replaceBlocks 실패가 침묵).
        // 실패는 시끄러워야 한다 — 상태를 드러내고 콘솔에 원인을 남긴다.
        if (!cancelled) {
          console.error("[PageEditor] 문서 로드 실패:", e);
          setState("loadError");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // pageId 가 바뀔 때만 (PageView 가 key 로 리마운트한다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  /* ── 자동완성 후보 ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/pages", { cache: "no-store" }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const d = (await res.json()) as { pages: { id: string; title: string; kind: string }[] };
      if (!cancelled) setPages(d.pages.filter((p) => p.kind === "doc").map((p) => ({ id: p.id, title: p.title })));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── 저장: 블록 → 마크다운 ── */
  const save = useCallback(async () => {
    if (!loadedRef.current) return;
    setState("saving");
    try {
      const blocks = editor.document as unknown as BNBlock[];
      const markdown = serializeMarkdown({
        frontmatter: frontmatterRef.current,
        blocks: blocksToAst(blocks),
      });
      const res = await fetch(`/api/pages/${pageId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, title: titleRef.current, baseRev: revRef.current }),
      });
      if (res.status === 409) {
        // 종전엔 여기서 "새로고침" 만 안내했고, 누르면 방금 쓴 내용이 사라졌다(격차 D1).
        // 서버가 409 응답에 실어 보내는 currentMarkdown 을 써서 3-way 병합한다.
        const d = (await res.json().catch(() => ({}))) as { currentMarkdown?: string; currentRev?: number };
        const theirs = d.currentMarkdown ?? "";
        const m = merge3(baseMarkdownRef.current, markdown, theirs);
        setConflict({
          mine: markdown,
          theirs,
          merged: m.text,
          conflicts: formatConflicts(m.text),
          serverRev: d.currentRev ?? revRef.current,
        });
        setState("conflict");
        return;
      }
      if (!res.ok) throw new Error("save failed");
      const d = (await res.json()) as { rev?: number };
      if (typeof d.rev === "number") revRef.current = d.rev;
      setState("saved");
      window.dispatchEvent(new CustomEvent("pages:changed"));
    } catch {
      setState("error");
    }
  }, [editor, pageId]);

  /**
   * 충돌 해결: 고른 본문을 편집기에 싣고 서버 rev 를 기준으로 다시 저장한다.
   *
   * 핵심은 **어느 경로로 가든 내가 쓴 글이 사라지지 않는다**는 것이다. 병합본에
   * 충돌 마커가 남아 있으면 저장하지 않고 편집기에만 실어, 사람이 정리한 뒤
   * 평소처럼 저장하게 한다(마커째 저장돼 본문이 오염되는 걸 막는다).
   */
  const applyResolution = useCallback(
    async (chosen: string) => {
      const doc = parseMarkdown(chosen);
      frontmatterRef.current = doc.frontmatter;
      const blocks = astToBlocks(doc.blocks);
      editor.replaceBlocks(editor.document, (blocks.length ? blocks : [{ type: "paragraph" }]) as never);

      // 서버 최신 rev 를 기준으로 삼아야 다음 저장이 또 409 나지 않는다
      revRef.current = conflict?.serverRev ?? revRef.current;
      baseMarkdownRef.current = chosen;
      setConflict(null);

      if (hasConflictMarkers(chosen)) {
        // 아직 사람이 정리해야 한다 — 저장은 미루고 편집만 열어준다
        setState("idle");
        return;
      }
      await save();
    },
    // save 는 아래에서 정의되지만 useCallback 이라 참조 시점에 이미 존재한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, conflict],
  );

  const scheduleSave = useCallback(() => {
    if (!loadedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 800);
  }, [save]);

  /* ── 슬래시 메뉴: 기본 + 콜아웃·임베드 (A7) ── */
  const getSlashItems = useCallback(
    (query: string) => {
      const base = getDefaultReactSlashMenuItems(editor);
      const extra = [
        {
          title: "콜아웃",
          aliases: ["callout", "note", "노트", "주의"],
          group: "기본 블록",
          subtext: "강조 상자 — 클릭으로 종류 전환",
          onItemClick: () => {
            editor.insertBlocks(
              [{ type: "callout", props: { kind: CALLOUT_KINDS[0] } }] as never,
              editor.getTextCursorPosition().block,
              "after",
            );
          },
        },
        {
          title: "문서 임베드",
          aliases: ["embed", "transclude", "임베드", "삽입"],
          group: "기본 블록",
          subtext: "다른 문서를 끼워 넣는다 (![[문서]])",
          onItemClick: () => {
            editor.insertBlocks(
              [{ type: "embed", props: { target: "" } }] as never,
              editor.getTextCursorPosition().block,
              "after",
            );
          },
        },
      ];
      const all = [...base, ...extra];
      const q = query.trim().toLowerCase();
      if (!q) return all;
      return all.filter((it) => {
        const hay = [it.title, ...((it as { aliases?: string[] }).aliases ?? [])].join(" ").toLowerCase();
        return hay.includes(q);
      });
    },
    [editor],
  );

  /* ── [[ 자동완성 (B4) ──
     BlockNote 의 triggerCharacter 는 한 글자만 받는다. 트리거를 `[` 로 걸면
     `[[` 를 칠 때 두 번째 `[` 가 트리거를 다시 잡아 쿼리가 두 형태로 들어온다
     (`[PL` 또는 `PL`). 둘 다 받는다.

     빈 쿼리에는 메뉴를 띄우지 않는다 — 대괄호만 쳤을 때 목록이 튀어나오면
     방해가 되고, 한 글자만 쳐도 바로 좁혀지므로 실사용에 지장이 없다. */
  /**
   * 위키링크를 넣고, 바로 앞에 남은 여는 대괄호를 치운다.
   *
   * 서제스천 메뉴는 트리거 문자(두 번째 `[`)와 쿼리만 걷어간다. 사용자가 친
   * 첫 번째 `[` 는 평범한 글자로 남아서, 그대로 두면 `[` + `[[PLAN]]` =
   * `[[[PLAN]]` 이라는 깨진 마크다운이 저장된다. 삽입 직후 그 한 글자를
   * 블록 내용에서 직접 지운다.
   */
  const insertWikilink = useCallback(
    (target: string, label: string) => {
      editor.insertInlineContent([{ type: "wikilink", props: { target, label } }, " "] as never);

      const block = editor.getTextCursorPosition().block;
      const content = block.content as unknown;
      if (!Array.isArray(content)) return;

      let changed = false;
      const cleaned = content.map((node, i) => {
        const next = content[i + 1] as { type?: string } | undefined;
        const isText = (node as { type?: string }).type === "text";
        if (!isText || next?.type !== "wikilink") return node;
        const t = node as { type: "text"; text: string; styles: Record<string, unknown> };
        if (!t.text.endsWith("[")) return node;
        changed = true;
        return { ...t, text: t.text.slice(0, -1) };
      });
      if (changed) editor.updateBlock(block, { content: cleaned } as never);
    },
    [editor],
  );

  const getWikilinkItems = useCallback(
    (raw: string) => {
      const query = raw.startsWith("[") ? raw.slice(1) : raw;
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const matched = pages.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 12);

      const items = matched.map((p) => ({
        title: p.title,
        group: "문서",
        onItemClick: () => insertWikilink(p.title, p.title),
      }));

      // 후보에 없으면 그 제목으로 링크를 먼저 박을 수 있게 한다(문서는 나중에 만든다)
      const exact = matched.some((p) => p.title.toLowerCase() === q);
      if (!exact) {
        const t = query.trim();
        items.unshift({
          title: `"${t}" 로 링크`,
          group: "새 링크",
          onItemClick: () => insertWikilink(t, t),
        });
      }
      return items;
    },
    [pages, insertWikilink],
  );

  const saveLabel = useMemo(
    () =>
      ({ saving: "저장 중…", saved: "저장됨 ✓", error: "저장 실패 ✗", loading: "불러오는 중…", loadError: "문서를 열지 못했습니다 ✗ — 콘솔 확인" })[
        state as string
      ],
    [state],
  );

  return (
    <div className="ws-editor">
      <input
        className="ws-title-input"
        value={title}
        placeholder="제목 없음"
        onChange={(e) => {
          setTitle(e.target.value);
          titleRef.current = e.target.value;
          scheduleSave();
        }}
        onBlur={() => void save()}
      />
      <div className="ws-save-state">
        {saveLabel}
        {state === "conflict" && <span style={{ color: "#E0900F" }}>다른 곳에서 먼저 수정됨 — 아래에서 정리하세요</span>}
      </div>

      {conflict && (
        <div
          role="alert"
          style={{
            border: "1px solid #E0900F", borderLeft: "3px solid #E0900F", borderRadius: "0 10px 10px 0",
            background: "var(--surface-sunken)", padding: "12px 14px", margin: "8px 0 14px",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, color: "#E0900F", marginBottom: 4 }}>
            다른 곳에서 먼저 저장됐습니다
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-sub)", margin: "0 0 10px", lineHeight: 1.6 }}>
            {conflict.conflicts.length === 0
              ? "겹치는 편집이 없어 자동으로 합칠 수 있습니다. 내가 쓴 내용은 그대로 남습니다."
              : `같은 자리를 서로 다르게 고친 곳이 ${conflict.conflicts.length}군데 있습니다. 어느 쪽도 지우지 않았으니 확인하고 정리하세요.`}
          </p>

          {conflict.conflicts.map((c, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "6px 9px", background: "var(--surface-card)" }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--color-primary)", marginBottom: 3 }}>내 편집</div>
                <pre style={{ margin: 0, fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-body)" }}>{c.mine || "(빈 줄)"}</pre>
              </div>
              <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "6px 9px", background: "var(--surface-card)" }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#E0900F", marginBottom: 3 }}>서버</div>
                <pre style={{ margin: 0, fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-body)" }}>{c.theirs || "(빈 줄)"}</pre>
              </div>
            </div>
          ))}

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="ws-btn-soft" onClick={() => void applyResolution(conflict.merged)}>
              {conflict.conflicts.length === 0 ? "합친 내용으로 저장" : "합친 내용 불러오기(충돌 표시 포함)"}
            </button>
            <button className="ws-btn-soft" onClick={() => void applyResolution(conflict.mine)}>내 것으로 덮어쓰기</button>
            <button className="ws-btn-soft" onClick={() => void applyResolution(conflict.theirs)}>서버 것 가져오기</button>
            <button
              className="ws-btn-soft"
              onClick={() => void navigator.clipboard?.writeText(conflict.mine)}
              title="어떤 선택을 하든 내 원문을 따로 챙겨둘 수 있게"
            >
              내 원문 복사
            </button>
          </div>
        </div>
      )}

      <BlockNoteView editor={editor} onChange={scheduleSave} slashMenu={false}>
        <SuggestionMenuController triggerCharacter="/" getItems={async (q) => getSlashItems(q)} />
        {/* 옵시디언과 같은 트리거 — 여는 대괄호 두 개를 치면 문서 목록이 뜬다.
            (트리거는 `[` 한 글자, 두 번째 `[` 는 getWikilinkItems 가 쿼리에서 판별) */}
        <SuggestionMenuController triggerCharacter="[" getItems={async (q) => getWikilinkItems(q)} />
      </BlockNoteView>
    </div>
  );
}
