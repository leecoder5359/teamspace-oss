import type { Metadata } from "next";
import AiConnect from "@/components/ws/AiConnect";

export const metadata: Metadata = { title: "AI 연결" };

export default function AiConnectPage() {
  return <AiConnect />;
}
