"use client";

import { useRef, useState } from "react";
import { Icon } from "./icons";

/* =====================================================================
   데이터 반출입 UI (격차 E2 후속).

   내보내기(E1)·가져오기(E2)는 API·CLI 로만 있어서 비개발자는 쓸 수 없었다.
   회수 경로가 터미널 뒤에 있으면 없는 것과 비슷하다.

   가져오기는 **드라이런을 건너뛸 수 없게** 만든다. 파일을 고르면 먼저
   "무엇이 생기고 무엇이 빠지는지" 를 보여주고, 그걸 본 뒤에만 실제 버튼이
   활성화된다. 수백 개 문서를 만드는 되돌릴 수 없는 작업이라, 확인 없이
   실행할 수 있는 자리를 아예 만들지 않는 쪽이 낫다.
   ===================================================================== */

type Plan = {
  format: string;
  counts: {
    documents: number;
    duplicates: number;
    skippedFiles: number;
    projectsToCreate: number;
    attachments: number;
    attachmentBytes: number;
    boards: number;
    boardRows: number;
    boardDuplicates: number;
    created?: number;
    skippedDuplicates?: number;
    boardsCreated?: number;
    boardRowsCreated?: number;
    skippedBoardDuplicates?: number;
  };
  projects: { name: string; projectId: string | null; willCreate: boolean }[];
  documents: { path: string; title: string; project: string | null; duplicate?: boolean; attachments?: number }[];
  boards?: {
    title: string;
    project?: string | null;
    projectName?: string | null;
    rows: number;
    columns: { name: string; type: string; options: number }[];
    linkedDocs?: number;
    duplicate?: boolean;
  }[];
  skipped: { path: string; reason: string }[];
  warnings: string[];
};

const TYPE_LABEL: Record<string, string> = {
  text: "글자",
  number: "숫자",
  date: "날짜",
  select: "선택",
  checkbox: "체크",
};

const FORMAT_LABEL: Record<string, string> = {
  teamspace: "TeamSpace 내보내기",
  notion: "노션 export",
  markdown: "마크다운 폴더",
};

const fmtBytes = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

export default function DataTransfer() {
  /* ── 내보내기 ── */
  const [withAttachments, setWithAttachments] = useState(true);
  const [exporting, setExporting] = useState(false);

  /* ── 가져오기 ── */
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [createProjects, setCreateProjects] = useState(false);
  const [skipExisting, setSkipExisting] = useState(true);

  async function runExport() {
    setExporting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/export${withAttachments ? "" : "?attachments=0"}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      // 서버가 준 파일명을 쓴다(한글 워크스페이스 이름은 RFC 5987 로 실려 온다).
      const cd = res.headers.get("content-disposition") ?? "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="([^"]+)"/i.exec(cd);
      const name = star ? decodeURIComponent(star[1]) : (plain?.[1] ?? "teamspace-export.zip");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (createProjects) form.set("createProjects", "1");
      if (skipExisting) form.set("skipExisting", "1");
      const res = await fetch(`/api/import${dryRun ? "?dryRun=1" : ""}`, { method: "POST", body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
      if (dryRun) setPlan(payload as Plan);
      else {
        setDone(payload as Plan);
        setPlan(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setPlan(null);
    setDone(null);
    setErr(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {err && (
        <p style={{ fontSize: 12.5, color: "#D14343", margin: 0 }}>
          <Icon name="alert" size={13} /> {err}
        </p>
      )}

      {/* ── 내보내기 ── */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>내보내기</div>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.7, margin: "0 0 10px" }}>
          문서(마크다운)·보드(CSV)·구조(workspace.json)를 zip 한 개로 받습니다. 본문의 첨부 링크는 zip 안의
          상대경로로 바뀌어, 서버 없이 옵시디언 같은 도구에서 바로 열립니다.
          <br />
          휴지통 문서와 <strong>내가 볼 수 없는 문서</strong>는 빠집니다.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={withAttachments} onChange={(e) => setWithAttachments(e.target.checked)} />
            첨부 포함
          </label>
          <button className="ws-btn-soft" onClick={() => void runExport()} disabled={exporting}>
            <Icon name="arrowRight" size={14} /> {exporting ? "만드는 중…" : "zip 내려받기"}
          </button>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border-subtle)" }} />

      {/* ── 가져오기 ── */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>가져오기</div>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.7, margin: "0 0 10px" }}>
          우리 내보내기 zip · 노션 export zip · 마크다운 폴더 zip 을 받습니다. 마크다운은 문서로,{" "}
          <strong>CSV 는 보드</strong>로 만듭니다(열 타입은 값을 보고 정합니다). 파일을 고르면{" "}
          <strong>먼저 미리보기</strong>를 보여주고, 확인한 뒤에만 실제로 만듭니다.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setPlan(null);
              setDone(null);
              setErr(null);
            }}
            style={{ fontSize: 13 }}
          />
          <button className="ws-btn-soft" onClick={() => void send(true)} disabled={!file || busy}>
            {busy && !plan ? "읽는 중…" : "미리보기"}
          </button>
          {(plan || done) && (
            <button className="ws-btn-soft" onClick={reset} disabled={busy}>
              지우기
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, marginBottom: 10 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            같은 제목이 이미 있으면 건너뛰기
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={createProjects} onChange={(e) => setCreateProjects(e.target.checked)} />
            없는 프로젝트는 새로 만들기
          </label>
        </div>

        {plan && <Preview plan={plan} onRun={() => void send(false)} busy={busy} />}
        {done && <Result plan={done} />}
      </div>
    </div>
  );
}

function Preview({ plan, onRun, busy }: { plan: Plan; onRun: () => void; busy: boolean }) {
  const c = plan.counts;
  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 12, background: "var(--surface-sunken)" }}>
      <div style={{ fontSize: 12.5, marginBottom: 8 }}>
        <strong>{FORMAT_LABEL[plan.format] ?? plan.format}</strong> 으로 읽었습니다 — 문서 <strong>{c.documents}</strong>건
        {c.boards > 0 && (
          <>
            {" "}
            · 보드 <strong>{c.boards}</strong>개(행 {c.boardRows}건)
          </>
        )}
        {c.attachments > 0 && <> · 첨부 {c.attachments}건({fmtBytes(c.attachmentBytes)})</>}
        {c.duplicates + (c.boardDuplicates ?? 0) > 0 && <> · 같은 제목 있음 {c.duplicates + (c.boardDuplicates ?? 0)}건</>}
        {c.skippedFiles > 0 && <> · 건너뜀 {c.skippedFiles}건</>}
      </div>

      {plan.warnings.map((w, i) => (
        <p key={i} style={{ fontSize: 12, color: "#E0900F", margin: "0 0 4px" }}>
          ⚠ {w}
        </p>
      ))}

      {plan.projects.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0" }}>
          프로젝트:{" "}
          {plan.projects
            .map((p) => `${p.name} → ${p.projectId ? "기존" : p.willCreate ? "새로 만듦" : "미분류"}`)
            .join(" · ")}
        </div>
      )}

      <details style={{ marginTop: 6 }}>
        <summary style={{ fontSize: 12.5, cursor: "pointer" }}>만들어질 문서 {plan.documents.length}건 보기</summary>
        <ul style={{ maxHeight: 200, overflowY: "auto", margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
          {plan.documents.map((d, i) => (
            <li key={i} style={{ color: d.duplicate ? "var(--text-disabled)" : "var(--text-body)" }}>
              {d.title}
              {d.project && <span style={{ color: "var(--text-disabled)" }}> [{d.project}]</span>}
              {d.attachments ? <span style={{ color: "var(--text-disabled)" }}> 📎{d.attachments}</span> : null}
              {d.duplicate && <span style={{ color: "#E0900F" }}> · 같은 제목 있음</span>}
            </li>
          ))}
        </ul>
      </details>

      {(plan.boards?.length ?? 0) > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 12.5, cursor: "pointer" }}>만들어질 보드 {plan.boards!.length}개 보기</summary>
          <ul style={{ maxHeight: 200, overflowY: "auto", margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {plan.boards!.map((b, i) => (
              <li key={i}>
                {b.title}
                {(b.project ?? b.projectName) && (
                  <span style={{ color: "var(--text-disabled)" }}> [{b.project ?? b.projectName}]</span>
                )}
                <span style={{ color: "var(--text-disabled)" }}> · 행 {b.rows}</span>
                {b.linkedDocs ? <span style={{ color: "var(--text-disabled)" }}> · 본문 {b.linkedDocs}</span> : null}
                {b.duplicate && <span style={{ color: "#E0900F" }}> · 같은 제목 있음</span>}
                <div style={{ color: "var(--text-disabled)", fontSize: 11.5 }}>
                  {b.columns.map((col) => `${col.name}(${TYPE_LABEL[col.type] ?? col.type})`).join(" · ")}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {plan.skipped.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 12.5, cursor: "pointer" }}>건너뛴 파일 {plan.skipped.length}건 보기</summary>
          <ul style={{ maxHeight: 160, overflowY: "auto", margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
            {plan.skipped.map((s, i) => (
              <li key={i}>
                {s.path} — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <button
          className="ws-btn-soft"
          onClick={onRun}
          disabled={busy || (plan.documents.length === 0 && c.boards === 0)}
          style={{ background: "var(--color-primary)", color: "#fff", borderColor: "var(--color-primary)" }}
        >
          {busy
            ? "가져오는 중…"
            : c.boards > 0
              ? `문서 ${plan.documents.length}건 · 보드 ${c.boards}개 만들기`
              : `문서 ${plan.documents.length}건 만들기`}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--text-disabled)" }}>되돌리려면 휴지통에서 하나씩 지워야 합니다.</span>
      </div>
    </div>
  );
}

function Result({ plan }: { plan: Plan }) {
  const c = plan.counts;
  return (
    <div style={{ border: "1px solid var(--color-primary)", borderRadius: 10, padding: 12, background: "var(--surface-sunken)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        <Icon name="check" size={14} /> 가져오기 완료
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
        문서 {c.created ?? 0}건 생성
        {(c.boardsCreated ?? 0) > 0 && (
          <>
            {" "}
            · 보드 {c.boardsCreated}개(행 {c.boardRowsCreated ?? 0}건) 생성
          </>
        )}
        {c.attachments > 0 && <> · 첨부 {c.attachments}건 복원</>}
        {(c.skippedDuplicates ?? 0) > 0 && <> · 중복 {c.skippedDuplicates}건 건너뜀</>}
        {c.skippedFiles > 0 && <> · 파일 {c.skippedFiles}건 제외</>}
      </div>
    </div>
  );
}
