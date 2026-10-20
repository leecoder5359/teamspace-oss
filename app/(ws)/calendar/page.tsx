import type { Metadata } from "next";
import Calendar from "@/components/ws/Calendar";

export const metadata: Metadata = { title: "캘린더" };

export default function CalendarPage() {
  return <Calendar />;
}
