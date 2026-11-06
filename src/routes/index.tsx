import { createFileRoute } from "@tanstack/react-router";
import { Player } from "@/components/Player";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BKS Player — Música e Rádio com VU LED" },
      { name: "description", content: "Player roxo com VU LED, pastas de música, rádios online, equalizador e bass boost." },
      { property: "og:title", content: "BKS Player" },
      { property: "og:description", content: "Música local, rádios online, VU LED e equalizador." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Player,
});
