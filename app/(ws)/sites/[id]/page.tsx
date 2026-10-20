import type { Metadata } from "next";
import SiteDetail from "@/components/ws/SiteDetail";

export const metadata: Metadata = { title: "퍼블리시" };

export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SiteDetail id={id} />;
}
