export default function SiteNotFound() {
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "24px 16px" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>페이지를 찾을 수 없습니다</h1>
        <p style={{ fontSize: 14, color: "var(--text-muted, #666)", marginTop: 8 }}>링크가 잘못됐거나 공유가 중단된 페이지입니다.</p>
      </div>
    </main>
  );
}
