import type { Metadata } from "next";
import Inbox from "@/components/ws/Inbox";

export const metadata: Metadata = { title: "알림" };

export default function InboxPage() {
  return <Inbox />;
}
