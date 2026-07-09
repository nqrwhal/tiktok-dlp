import type { Metadata } from "next";
import { SettingsForm } from "../../../components/dashboard/SettingsForm";
import styles from "../../../components/dashboard/dashboard.module.css";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <div className={styles.pageWrap}>
      <div className={styles.pageHeader}>
        <div>
          <span className={styles.pageEyebrow}>Preferences</span>
          <h1>Settings</h1>
          <p>Configure playback, monitoring, and storage defaults.</p>
        </div>
      </div>
      <SettingsForm />
    </div>
  );
}
