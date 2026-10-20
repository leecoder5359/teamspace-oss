import type { Metadata } from "next";
import Sites from "@/components/ws/Sites";

export const metadata: Metadata = { title: "퍼블리시" };

export default function SitesPage() {
  return <Sites />;
}
