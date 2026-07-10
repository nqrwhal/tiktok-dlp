import type { Metadata } from "next";
import { DashboardOverview } from "../../components/dashboard/DashboardOverview";
import { mockCreators, mockStats, mockVideos } from "../../lib/mock-data";

export const metadata: Metadata = {
  title: "Overview",
};

export default function DashboardPage() {
  const liveMode = Boolean(process.env.NEXT_PUBLIC_ARCHIVE_API_BASE);
  return (
    <DashboardOverview
      fallbackCreators={liveMode ? [] : mockCreators}
      fallbackVideos={liveMode ? [] : mockVideos}
      fallbackStats={liveMode ? { ...mockStats, creatorCount: 0, videoCount: 0, storageUsed: "0 B", storagePercent: 0, newThisWeek: 0 } : mockStats}
    />
  );
}
