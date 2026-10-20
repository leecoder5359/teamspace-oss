import type { Metadata } from "next";
import Docs from "@/components/ws/Docs";

export const metadata: Metadata = { title: "문서" };

// ?cat=&id= 딥링크(탭·선택 항목)는 서버에서 읽어 초기값으로 내려준다(Next 16: searchParams 는 Promise).
export default async function DocsPage({ searchParams }: { searchParams: Promise<{ cat?: string | string[]; id?: string | string[] }> }) {
  const { cat, id } = await searchParams;
  return <Docs initialParams={{ cat, id }} />;
}
