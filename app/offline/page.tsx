/* 오프라인 안내 (격차 F1). 서비스 워커가 미리 받아 두는 유일한 화면이라
   **외부 자원에 기대지 않는다** — 폰트·이미지·API 없이 혼자 서야 한다. */
export const metadata = { title: "오프라인 — TeamSpace" };

export default function Offline() {
  return (
    <div style={{ maxWidth: 420, margin: "18vh auto", padding: 24, textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🔌</div>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>오프라인입니다</h1>
      <p style={{ fontSize: 14, lineHeight: 1.7, color: "#8A93A6" }}>
        네트워크가 돌아오면 이어서 쓸 수 있습니다.
        <br />
        문서·태스크는 최신 상태로만 보여 주기 때문에, 오프라인에서는 지난 내용을 띄우지 않습니다.
      </p>
      <p style={{ marginTop: 20 }}>
        <a href="/dashboard" style={{ fontSize: 14, color: "#2F62FF" }}>
          다시 시도
        </a>
      </p>
    </div>
  );
}
