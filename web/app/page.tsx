import type { Metadata } from "next";
import { MobileFeed } from "../components/feed/MobileFeed";
import { mockCreators, mockVideos } from "../lib/mock-data";

export const metadata: Metadata = {
  title: "Feed",
  description: "A private, swipeable feed for your saved creator archive.",
};

export default function FeedPage() {
  const liveMode = Boolean(process.env.NEXT_PUBLIC_ARCHIVE_API_BASE);
  return <MobileFeed creators={liveMode ? [] : mockCreators} videos={liveMode ? [] : mockVideos} />;
}
