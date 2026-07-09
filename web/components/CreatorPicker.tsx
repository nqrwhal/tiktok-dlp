"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Creator } from "../lib/types";
import styles from "./creator-picker.module.css";

export function CreatorPicker({
  creators,
  value,
  onChange,
  compact = false,
}: {
  creators: Creator[];
  value: string;
  onChange(value: string): void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = creators.find((creator) => creator.id === value);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div className={`${styles.picker} ${compact ? styles.compact : ""}`} ref={rootRef}>
      <button
        className={styles.trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selected ? `@${selected.username}` : "All creators"}</span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className={styles.menu} role="listbox" aria-label="Filter by creator">
          <button
            className={value === "all" ? styles.optionSelected : styles.option}
            type="button"
            role="option"
            aria-selected={value === "all"}
            onClick={() => {
              onChange("all");
              setOpen(false);
            }}
          >
            <span>All creators</span>
            {value === "all" ? <Check size={14} /> : null}
          </button>
          {creators.map((creator) => (
            <button
              className={value === creator.id ? styles.optionSelected : styles.option}
              type="button"
              role="option"
              aria-selected={value === creator.id}
              key={creator.id}
              onClick={() => {
                onChange(creator.id);
                setOpen(false);
              }}
            >
              <span className={styles.optionIdentity}>
                <i style={{ background: creator.accent }} />
                @{creator.username}
              </span>
              {value === creator.id ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
