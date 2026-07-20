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
import { useEffect, useRef, useState } from "react";
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
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const menuButton = menuButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const initialControl = sidebarRef.current?.querySelector<HTMLElement>("[data-drawer-initial]");
    window.requestAnimationFrame(() => initialControl?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    function handlePointerDown(event: PointerEvent) {
      if (!sidebarRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => menuButton?.focus());
    };
  }, [menuOpen]);

  useEffect(() => {
    // Client-side history changes can happen without activating a drawer link.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 980px)");
    function closeAtDesktop(event: MediaQueryListEvent) {
      if (event.matches) setMenuOpen(false);
    }
    desktop.addEventListener("change", closeAtDesktop);
    return () => desktop.removeEventListener("change", closeAtDesktop);
  }, []);

  return (
    <div className={styles.dashboardShell}>
      <a className={styles.skipLink} href="#dashboard-content" inert={menuOpen || undefined}>Skip to content</a>

      <header className={styles.mobileHeader} inert={menuOpen || undefined}>
        <Link className={styles.brand} href="/">
          <span>R</span> rewind
        </Link>
        <button
          className={styles.mobileMenuButton}
          ref={menuButtonRef}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
          aria-expanded={menuOpen}
          aria-controls="dashboard-navigation"
          aria-label="Open navigation"
        >
          <Menu size={21} />
        </button>
      </header>

      <aside
        className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""}`}
        id="dashboard-navigation"
        ref={sidebarRef}
        aria-label="Dashboard navigation"
        role={menuOpen ? "dialog" : undefined}
        aria-modal={menuOpen || undefined}
      >
        <div className={styles.sidebarHeader}>
          <Link className={styles.brand} href="/" onClick={() => setMenuOpen(false)}>
            <span>R</span> rewind
          </Link>
          <button
            className={styles.sidebarCloseButton}
            data-drawer-initial
            type="button"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <X size={21} />
          </button>
        </div>

        <div className={styles.sidebarLabel}>Manage archive</div>
        <nav className={styles.sidebarNav} aria-label="Dashboard navigation">
          {navigation.map(({ href, label, icon: Icon }) => {
            const isActive =
              href === "/dashboard" ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                className={isActive ? styles.sidebarLinkActive : styles.sidebarLink}
                href={href}
                key={href}
                onClick={() => setMenuOpen(false)}
                aria-current={isActive ? "page" : undefined}
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
        </div>
      </aside>

      {menuOpen ? (
        <div className={styles.menuScrim} aria-hidden="true" />
      ) : null}

      <main
        className={styles.dashboardMain}
        id="dashboard-content"
        inert={menuOpen || undefined}
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}
