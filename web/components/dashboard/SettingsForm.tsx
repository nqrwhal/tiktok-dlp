"use client";

import { Check, Save } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  type DefaultFeed,
  readAutoplayPreference,
  readDefaultFeed,
  readRememberSound,
  writeAutoplayPreference,
  writeDefaultFeed,
  writeRememberSound,
} from "../../lib/playback-preferences";
import styles from "./dashboard.module.css";

export function SettingsForm() {
  const [saved, setSaved] = useState(false);
  const [autoplay, setAutoplay] = useState(true);
  const [sound, setSound] = useState(true);
  const [defaultFeed, setDefaultFeed] = useState<DefaultFeed>("all");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSound(readRememberSound(window.localStorage));
    setAutoplay(readAutoplayPreference(window.localStorage));
    setDefaultFeed(readDefaultFeed(window.localStorage));
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeAutoplayPreference(window.localStorage, autoplay);
    writeRememberSound(window.localStorage, sound);
    writeDefaultFeed(window.localStorage, defaultFeed);
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
            <select value={defaultFeed} onChange={(event) => setDefaultFeed(event.target.value as DefaultFeed)}>
              <option value="all">All creators</option>
              <option value="bookmarks">Bookmarks</option>
            </select>
          </label>
        </div>
      </section>

      <div className={styles.settingsFooter}>
        <span>{saved ? <><Check size={15} /> Settings saved</> : "These preferences apply to this browser."}</span>
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
