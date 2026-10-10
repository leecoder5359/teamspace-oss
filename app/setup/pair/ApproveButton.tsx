"use client";

import { useState } from "react";

// label 은 호출부에서 버튼 이름을 드러내려고 받는다(a11y 스캐너가 래퍼 호출부의 이름을 검사한다).
export function ApproveButton({ code, label }: { code: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");

  async function approve() {
    const res = await fetch("/api/pair/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setState(res.ok ? "ok" : "err");
  }

  if (state === "ok") return <p>승인됨 — 터미널로 돌아가세요. 설치가 이어집니다.</p>;
  return (
    <>
      <button onClick={approve} style={{ padding: "10px 20px", fontSize: 16 }}>
        {label}
      </button>
      {state === "err" && <p style={{ color: "crimson" }}>승인 실패 — 링크를 다시 열어 주세요.</p>}
    </>
  );
}
