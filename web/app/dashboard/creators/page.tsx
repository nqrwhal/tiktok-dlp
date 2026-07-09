import type { Metadata } from "next";
import { CreatorManager } from "../../../components/dashboard/CreatorManager";
import styles from "../../../components/dashboard/dashboard.module.css";
import { mockCreators } from "../../../lib/mock-data";

export const metadata: Metadata = {
  title: "Creators",
};

export default function CreatorsPage() {
  return (
    <div className={styles.pageWrap}>
      <CreatorManager creators={mockCreators} />
    </div>
  );
}
