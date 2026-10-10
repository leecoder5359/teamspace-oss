import { Suspense } from "react";
import Approvals from "@/components/ws/Approvals";

export default function ApprovalsPage() {
  // Approvals 가 useSearchParams(?id= 포커스)를 쓰므로 Suspense 경계가 필요하다.
  return (
    <Suspense fallback={<div className="ws-db" style={{ padding: 40 }} />}>
      <Approvals />
    </Suspense>
  );
}
