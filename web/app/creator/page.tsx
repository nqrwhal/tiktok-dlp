import type { Metadata } from "next";
import { CreatorGallery } from "../../components/creator/CreatorGallery";
import { mockCreators, mockVideos } from "../../lib/mock-data";

export const metadata: Metadata = {
  title: "Creator videos",
  description: "Browse one creator's saved videos in a thumbnail grid.",
};

export default function CreatorPage() {
  const liveMode = Boolean(process.env.NEXT_PUBLIC_ARCHIVE_API_BASE);
  return <CreatorGallery creators={liveMode ? [] : mockCreators} videos={liveMode ? [] : mockVideos} />;
}
