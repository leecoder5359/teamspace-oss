import type { Metadata } from "next";
import Slack from "@/components/ws/Slack";

export const metadata: Metadata = { title: "슬랙" };

export default function SlackPage() {
  return <Slack />;
}
