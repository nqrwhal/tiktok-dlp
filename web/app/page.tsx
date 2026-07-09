import type { Metadata } from "next";
import { MobileFeed } from "../components/feed/MobileFeed";
import { mockCreators, mockVideos } from "../lib/mock-data";

export const metadata: Metadata = {
  title: "Feed",
  description: "A private, swipeable feed for your saved creator archive.",
};

export default function FeedPage() {
  return <MobileFeed creators={mockCreators} videos={mockVideos} />;
}
