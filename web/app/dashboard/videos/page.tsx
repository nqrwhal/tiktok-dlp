import type { Metadata } from "next";
import { VideoLibrary } from "../../../components/dashboard/VideoLibrary";
import styles from "../../../components/dashboard/dashboard.module.css";
import { mockCreators, mockVideos } from "../../../lib/mock-data";

export const metadata: Metadata = {
  title: "Videos",
};

export default function VideosPage() {
  const liveMode = Boolean(process.env.NEXT_PUBLIC_ARCHIVE_API_BASE);
  return (
    <div className={styles.pageWrap}>
      <VideoLibrary creators={liveMode ? [] : mockCreators} videos={liveMode ? [] : mockVideos} />
    </div>
  );
}
