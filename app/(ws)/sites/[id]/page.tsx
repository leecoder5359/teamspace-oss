import SiteDetail from "@/components/ws/SiteDetail";

export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SiteDetail id={id} />;
}
