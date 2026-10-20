"use client";

import { useRouter, useSearchParams } from "next/navigation";
import LessonsSurface from "./LessonsSurface";
import LessonsTeammates from "./LessonsTeammates";

/* /lessons — 레슨(팀 작업규칙)을 문서 허브 탭에서 사이드바 메뉴로 올린 화면. 탭: 팀 레슨 · 내 레슨 · 팀원 레슨.
   ?project=<id> = 프로젝트 필터(문서 허브에서 넘어올 때), ?tab=team|mine|teammates = 북마크 가능한 탭. */

type Tab = "team" | "mine" | "teammates";
const TABS: { id: Tab; label: string }[] = [
  { id: "team", label: "팀 레슨" },
  { id: "mine", label: "내 레슨" },
  { id: "teammates", label: "팀원 레슨" },
];

export { lessonsHref } from "./lessonsHref";

export default function LessonsPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const project = sp.get("project") ?? "";
  const raw = sp.get("tab");
  const tab: Tab = raw === "mine" || raw === "teammates" ? raw : "team";

  function go(t: Tab) {
    const q = new URLSearchParams(sp.toString());
    if (t === "team") q.delete("tab");
    else q.set("tab", t);
    const s = q.toString();
    router.replace(`/lessons${s ? `?${s}` : ""}`);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 화면 제목 — 보이는 제목 자리가 탭이라 스크린리더용으로만 둔다 */}
      <h1 className="sr-only">레슨</h1>
      <div className="ws-db-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`ws-db-tab${tab === t.id ? " active" : ""}`} onClick={() => go(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "teammates" ? <LessonsTeammates /> : <LessonsSurface key={tab} project={project} scope={tab} />}
      </div>
    </div>
  );
}
