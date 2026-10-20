import type { Metadata } from "next";
import Settings from "@/components/ws/Settings";

export const metadata: Metadata = { title: "설정" };

export default function SettingsPage() {
  return <Settings />;
}
