import type { Metadata } from "next";
import { DubTogetherApp } from "@/components/DubTogetherApp";

export const metadata: Metadata = {
  title: "Dub Together — online dubbing studio",
  description: "Dub Choicer Voicer packs together in your browser, with synchronized roles, microphones and automatic pack sharing.",
};

export default function Home() {
  return <DubTogetherApp />;
}
