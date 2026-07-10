import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Rewind Archive",
    short_name: "Rewind",
    description: "A private mobile archive for saved creator videos.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#080a09",
    theme_color: "#080a09",
    orientation: "portrait-primary",
    categories: ["entertainment", "utilities"],
    icons: [
      {
        src: "/rewind-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/rewind-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/rewind-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
