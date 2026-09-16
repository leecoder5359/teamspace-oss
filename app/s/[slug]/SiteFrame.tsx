import { SITE_SANDBOX } from "@/lib/sites/headers";

/* 상단 얇은 바 + 전체 화면 sandbox iframe. sandbox 문자열은 /pub 의 CSP 와 같은 상수를 쓴다. */
export default function SiteFrame({ title, email, src, onSwitch }: { title: string; email: string; src: string; onSwitch: () => Promise<void> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "var(--surface-page, #fff)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderBottom: "1px solid var(--border-subtle, #eee)", fontSize: 13 }}>
        <strong style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
        <span style={{ color: "var(--text-muted, #666)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
        <form action={onSwitch}>
          <button type="submit" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 7, border: "1px solid var(--border-default, #ddd)", background: "transparent", cursor: "pointer" }}>
            로그아웃
          </button>
        </form>
      </header>
      <iframe title={title} src={src} sandbox={SITE_SANDBOX} referrerPolicy="no-referrer" style={{ flex: 1, width: "100%", border: 0 }} />
    </div>
  );
}
