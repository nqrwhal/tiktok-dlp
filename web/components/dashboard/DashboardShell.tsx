"use client";

import {
  Clapperboard,
  Home,
  LayoutDashboard,
  Menu,
  Settings,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import styles from "./dashboard.module.css";

const navigation = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/videos", label: "Videos", icon: Clapperboard },
  { href: "/dashboard/creators", label: "Creators", icon: Users },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={styles.dashboardShell}>
      <header className={styles.mobileHeader}>
        <Link className={styles.brand} href="/">
          <span>R</span> rewind
        </Link>
        <button
          className={styles.mobileMenuButton}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
        >
          {menuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
      </header>

      <aside className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""}`}>
        <Link className={styles.brand} href="/">
          <span>R</span> rewind
        </Link>

        <div className={styles.sidebarLabel}>Manage archive</div>
        <nav className={styles.sidebarNav}>
          {navigation.map(({ href, label, icon: Icon }) => {
            const isActive =
              href === "/dashboard" ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                className={isActive ? styles.sidebarLinkActive : styles.sidebarLink}
                href={href}
                key={href}
                onClick={() => setMenuOpen(false)}
              >
                <Icon size={19} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.sidebarBottom}>
          <Link href="/">
            <Home size={18} />
            Return to feed
          </Link>
          <div className={styles.connectionCard}>
            <span className={styles.connectionDot} />
            <div>
              <strong>Archive online</strong>
              <small>Last checked just now</small>
            </div>
          </div>
        </div>
      </aside>

      {menuOpen ? (
        <button
          className={styles.menuScrim}
          onClick={() => setMenuOpen(false)}
          type="button"
          aria-label="Close navigation"
        />
      ) : null}

      <main className={styles.dashboardMain}>{children}</main>
    </div>
  );
}
