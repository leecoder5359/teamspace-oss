import type { Metadata } from "next";
import { Suspense } from "react";
import LessonsPage from "@/components/ws/LessonsPage";

export const metadata: Metadata = { title: "레슨" };

export default function Lessons() {
  // LessonsPage 가 useSearchParams(?project=·?tab=)를 쓰므로 Suspense 경계가 필요하다.
  return (
    <Suspense fallback={<div className="ws-db" style={{ padding: 40 }} />}>
      <LessonsPage />
    </Suspense>
  );
}
