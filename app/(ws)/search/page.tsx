import Search from "@/components/ws/Search";

// ?q= 딥링크는 서버에서 읽어 초기값으로 내려준다(Next 16: searchParams 는 Promise).
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  return <Search initialQ={(Array.isArray(q) ? q[0] : q) ?? ""} />;
}
