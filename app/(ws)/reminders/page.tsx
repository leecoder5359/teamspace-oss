import type { Metadata } from "next";
import Reminders from "@/components/ws/Reminders";

export const metadata: Metadata = { title: "리마인더" };

export default function RemindersPage() {
  return <Reminders />;
}
