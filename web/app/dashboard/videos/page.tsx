import type { Metadata } from "next";
import { VideoLibrary } from "../../../components/dashboard/VideoLibrary";
import styles from "../../../components/dashboard/dashboard.module.css";
import { mockCreators, mockVideos } from "../../../lib/mock-data";

export const metadata: Metadata = {
  title: "Videos",
};

export default function VideosPage() {
  return (
    <div className={styles.pageWrap}>
      <VideoLibrary creators={mockCreators} videos={mockVideos} />
    </div>
  );
}
