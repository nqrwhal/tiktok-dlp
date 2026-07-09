"use client";

import { Check, Save } from "lucide-react";
import { FormEvent, useState } from "react";
import styles from "./dashboard.module.css";

export function SettingsForm() {
  const [saved, setSaved] = useState(false);
  const [autoplay, setAutoplay] = useState(true);
  const [sound, setSound] = useState(false);
  const [deletionAlerts, setDeletionAlerts] = useState(true);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }

  return (
    <form className={styles.settingsForm} onSubmit={submit}>
      <section className={styles.settingsSection}>
        <div className={styles.settingsIntro}>
          <span className={styles.sectionEyebrow}>Playback</span>
          <h2>Feed experience</h2>
          <p>Control how videos behave while moving through your archive.</p>
        </div>
        <div className={styles.settingsFields}>
          <SettingToggle
            label="Autoplay videos"
            description="Play the focused video as soon as it enters the feed."
            checked={autoplay}
            onChange={setAutoplay}
          />
          <SettingToggle
            label="Remember sound"
            description="Keep your last mute setting on this device."
            checked={sound}
            onChange={setSound}
          />
          <label className={styles.formField}>
            <span>Default feed</span>
            <select defaultValue="all">
              <option value="all">All creators</option>
              <option value="latest">Latest downloads</option>
              <option value="unwatched">Unwatched first</option>
            </select>
          </label>
        </div>
      </section>

      <section className={styles.settingsSection}>
        <div className={styles.settingsIntro}>
          <span className={styles.sectionEyebrow}>Downloads</span>
          <h2>Archive behavior</h2>
          <p>Defaults for monitoring, retention, and new media.</p>
        </div>
        <div className={styles.settingsFields}>
          <label className={styles.formField}>
            <span>Poll interval</span>
            <div className={styles.inputSuffix}>
              <input type="number" min="30" defaultValue="60" />
              <span>seconds</span>
            </div>
          </label>
          <label className={styles.formField}>
            <span>Download concurrency</span>
            <select defaultValue="2">
              <option value="1">1 at a time</option>
              <option value="2">2 at a time</option>
              <option value="3">3 at a time</option>
            </select>
          </label>
          <SettingToggle
            label="Deletion alerts"
            description="Notify me if an original post disappears."
            checked={deletionAlerts}
            onChange={setDeletionAlerts}
          />
        </div>
      </section>

      <section className={styles.settingsSection}>
        <div className={styles.settingsIntro}>
          <span className={styles.sectionEyebrow}>Storage</span>
          <h2>Retention</h2>
          <p>Decide how the server handles older and temporary files.</p>
        </div>
        <div className={styles.settingsFields}>
          <label className={styles.formField}>
            <span>Temporary link lifetime</span>
            <div className={styles.inputSuffix}>
              <input type="number" min="5" defaultValue="30" />
              <span>minutes</span>
            </div>
          </label>
          <label className={styles.formField}>
            <span>Cleanup policy</span>
            <select defaultValue="expired">
              <option value="expired">Remove expired temporary files</option>
              <option value="manual">Manual cleanup only</option>
              <option value="30-days">Remove unsaved files after 30 days</option>
            </select>
          </label>
        </div>
      </section>

      <div className={styles.settingsFooter}>
        <span>{saved ? <><Check size={15} /> Preview settings saved</> : "Changes are stored locally in this frontend preview."}</span>
        <button className={styles.primaryButton} type="submit">
          <Save size={16} /> Save changes
        </button>
      </div>
    </form>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className={styles.settingToggleRow}>
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <button
        className={`${styles.switch} ${checked ? styles.switchOn : ""}`}
        onClick={() => onChange(!checked)}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
      >
        <span />
      </button>
    </div>
  );
}
