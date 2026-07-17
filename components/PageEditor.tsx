"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error" | "conflict";

export default function PageEditor({ pageId }: { pageId: string }) {
  const editor = useCreateBlockNote();
  const [title, setTitle] = useState("");
  const [state, setState] = useState<SaveState>("loading");
  const loadedRef = useRef(false);
  const titleRef = useRef(""); // 디바운스 저장 시 stale closure 방지
  const revRef = useRef(0); // 낙관적 잠금(baseRev) — 서버 rev 추적
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // dev 디버깅용: 콘솔/테스트에서 editor 접근 가능
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __bnEditor?: typeof editor }).__bnEditor = editor;
    }
  }, [editor]);

  // 페이지 로드: markdown → blocks (key 리마운트로 pageId당 1회)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/pages/${pageId}`, { cache: "no-store" });
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as { page: { title: string; rev?: number }; markdown: string };
      revRef.current = data.page.rev ?? 0;
      const blocks = await editor.tryParseMarkdownToBlocks(data.markdown || "");
      if (cancelled) return;
      editor.replaceBlocks(editor.document, blocks);
      setTitle(data.page.title);
      titleRef.current = data.page.title;
      loadedRef.current = true;
      setState("idle");
    })();
    return () => {
      cancelled = true;
    };
    // pageId가 바뀔 때만 재로드
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const save = async () => {
    if (!loadedRef.current) return;
    setState("saving");
    try {
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      const res = await fetch(`/api/pages/${pageId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, title: titleRef.current, baseRev: revRef.current }),
      });
      if (res.status === 409) {
        // 다른 곳(사람/에이전트)에서 먼저 저장됨 — 덮어쓰지 않고 알림 (감사 doc-2)
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
  };

  const scheduleSave = () => {
    if (!loadedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(), 800);
  };

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
        onBlur={() => save()}
      />
      <div className="ws-save-state">
        {state === "saving" && "저장 중…"}
        {state === "saved" && "저장됨 ✓"}
        {state === "error" && "저장 실패 ✗"}
        {state === "conflict" && (
          <span style={{ color: "#E0900F" }}>
            다른 곳에서 먼저 수정됨 — <button onClick={() => window.location.reload()} style={{ textDecoration: "underline", cursor: "pointer", background: "none", border: 0, color: "inherit", padding: 0, font: "inherit" }}>새로고침</button>
          </span>
        )}
        {state === "loading" && "불러오는 중…"}
      </div>
      <BlockNoteView editor={editor} onChange={scheduleSave} />
    </div>
  );
}
