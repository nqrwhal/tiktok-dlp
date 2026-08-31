import type { Metadata } from "next";
import { MediaLibrary } from "../../../components/dashboard/MediaLibrary";
import styles from "../../../components/dashboard/dashboard.module.css";

export const metadata: Metadata = {
  title: "Media",
};

export default function MediaPage() {
  return (
    <div className={styles.pageWrap}>
      <MediaLibrary />
    </div>
  );
}
