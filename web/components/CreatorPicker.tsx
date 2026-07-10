"use client";

import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = creators.find((creator) => creator.id === value);
  const selectedIndex = Math.max(0, creators.findIndex((creator) => creator.id === value) + 1);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const focusOption = useCallback((index: number) => {
    const count = creators.length + 1;
    const wrapped = ((index % count) + count) % count;
    optionRefs.current[wrapped]?.focus();
  }, [creators.length]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && open) closeAndRestoreFocus();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeAndRestoreFocus, open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => focusOption(selectedIndex));
  }, [focusOption, open, selectedIndex]);

  return (
    <div className={`${styles.picker} ${compact ? styles.compact : ""}`} ref={rootRef}>
      <button
        className={styles.trigger}
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          window.requestAnimationFrame(() => {
            focusOption(event.key === "ArrowDown" ? selectedIndex : selectedIndex - 1);
          });
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
      >
        <span>{selected ? `@${selected.username}` : value !== "all" ? `@${value}` : "All creators"}</span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div
          className={styles.menu}
          id={listboxId}
          role="listbox"
          aria-label="Filter by creator"
          onKeyDown={(event) => {
            const currentIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
            if (event.key === "Escape") {
              event.preventDefault();
              closeAndRestoreFocus();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              focusOption(currentIndex + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusOption(currentIndex - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusOption(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusOption(creators.length);
            }
          }}
        >
          <button
            className={value === "all" ? styles.optionSelected : styles.option}
            ref={(node) => { optionRefs.current[0] = node; }}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={value === "all"}
            onClick={() => {
              onChange("all");
              closeAndRestoreFocus();
            }}
          >
            <span>All creators</span>
            {value === "all" ? <Check size={14} /> : null}
          </button>
          {creators.map((creator, index) => (
            <button
              className={value === creator.id ? styles.optionSelected : styles.option}
              ref={(node) => { optionRefs.current[index + 1] = node; }}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={value === creator.id}
              key={creator.id}
              onClick={() => {
                onChange(creator.id);
                closeAndRestoreFocus();
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
