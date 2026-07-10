import type { Metadata } from "next";
import { CreatorGallery } from "../../components/creator/CreatorGallery";
import { mockCreators, mockVideos } from "../../lib/mock-data";

export const metadata: Metadata = {
  title: "Creator videos",
  description: "Browse one creator's saved videos in a thumbnail grid.",
};

export default function CreatorPage() {
  return <CreatorGallery creators={mockCreators} videos={mockVideos} />;
}
