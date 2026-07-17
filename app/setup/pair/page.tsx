import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ApproveButton } from "./ApproveButton";

export const runtime = "nodejs";

// /setup/pair?code=<32자hex> — curl 설치기가 브라우저로 여는 페어링 승인 페이지.
// 미들웨어(middleware.ts)가 미인증 접근을 /login?callbackUrl=... 로 이미 리다이렉트하지만,
// 방어적으로 여기서도 세션을 확인해 미인증 상태로 렌더링되는 경우가 없도록 한다.
export default async function PairPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const session = await auth().catch(() => null);
  if (!session?.user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/setup/pair?code=${code ?? ""}`)}`);
  }
  if (!code || !/^[0-9a-f]{32}$/.test(code)) {
    return <main style={{ padding: 40 }}>유효하지 않은 페어링 링크입니다.</main>;
  }
  return (
    <main style={{ padding: 40, maxWidth: 480 }}>
      <h1>새 기기 연결 승인</h1>
      <p>이 브라우저 계정({session.user.email})으로 새 머신에 에이전트 토큰을 발급합니다.</p>
      <ApproveButton code={code} />
    </main>
  );
}
