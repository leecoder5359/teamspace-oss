import type { Metadata } from "next";
import Clip from "@/components/ws/Clip";

export const metadata: Metadata = { title: "웹 클리퍼" };

export default function ClipPage() {
  return <Clip />;
}
