"use client";

import { useEffect, useState } from "react";
import { AvatarStack } from "./ui";
import { summarize } from "@/lib/presence";

/* =====================================================================
   "지금 누가 보고 있나" 표시 (격차 D4).

   충돌을 병합으로 수습하는 것(D1)보다, 애초에 옆에 누가 있다는 걸 보여 주는
   쪽이 싸다. 15초 하트비트 — 더 자주 보내 봐야 사람 눈에는 같고 서버만 바쁘다.
   ===================================================================== */

type Viewer = { userId: string; name: string; editing: boolean };

export default function PresenceBar({ pageId, editing = false }: { pageId: string; editing?: boolean }) {
  const [viewers, setViewers] = useState<Viewer[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = async () => {
      // 탭이 숨겨져 있으면 보내지 않는다 — 배경 탭까지 '보는 중'으로 세면 거짓말이 된다.
      if (document.hidden) return;
      const r = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId, editing }),
      }).catch(() => null);
      if (!r?.ok || cancelled) return;
      const d = (await r.json()) as { viewers?: Viewer[] };
      if (!cancelled) setViewers(d.viewers ?? []);
    };

    void beat();
    timer = setInterval(() => void beat(), 15_000);
    // 탭으로 돌아오면 **즉시** 갱신한다 — 다음 15초를 기다리면 돌아온 순간엔
    // 아무도 없는 것처럼 보인다(숨어 있는 동안 하트비트를 쉬기 때문).
    const onVisible = () => {
      if (!document.hidden) void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pageId, editing]);

  if (viewers.length === 0) return null;

  const editors = viewers.filter((v) => v.editing).map((v) => v.name);
  const label = summarize(viewers.map((v) => v.name), 3);

  return (
    <div
      title={editors.length ? `${summarize(editors, 3)} 편집 중` : `${label} 보는 중`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}
    >
      <AvatarStack names={viewers.map((v) => v.name)} size={20} />
      <span style={{ whiteSpace: "nowrap" }}>
        {editors.length > 0 ? (
          <span style={{ color: "#E0900F", fontWeight: 600 }}>{summarize(editors, 2)} 편집 중</span>
        ) : (
          `${label} 보는 중`
        )}
      </span>
    </div>
  );
}
