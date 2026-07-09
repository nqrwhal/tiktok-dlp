import type { Metadata } from "next";
import { DashboardOverview } from "../../components/dashboard/DashboardOverview";
import { mockCreators, mockStats, mockVideos } from "../../lib/mock-data";

export const metadata: Metadata = {
  title: "Overview",
};

export default function DashboardPage() {
  return (
    <DashboardOverview
      fallbackCreators={mockCreators}
      fallbackVideos={mockVideos}
      fallbackStats={mockStats}
    />
  );
}
