// Settings sections: ids, labels and the DOM anchor each one scrolls to. No imports, so onboarding can use it too.
export const SETTINGS_SECTIONS = [
  { id: "profile", label: "Profile & setup" },
  { id: "goals", label: "Goals" },
  { id: "framework", label: "Role framework" },
  { id: "split", label: "Work split" },
  { id: "guardrails", label: "Guardrails" },
  { id: "plan", label: "Plan" },
  { id: "sources", label: "Sources & connectors" },
  { id: "data", label: "Data" },
  { id: "advanced", label: "Advanced" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export const isSettingsSection = (value: string | undefined | null): value is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === value);
export const sectionDomId = (id: SettingsSection): string => `pt-section-${id}`;

/** Scroll a Settings section into view (no-op when it is not mounted). */
export function scrollToSection(id: SettingsSection): void {
  if (typeof document === "undefined") return;
  document.getElementById(sectionDomId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
}
