export interface WebPreferences {
  imageDirectory: string;
  imageCompression: string;
  imageMaxEdge: number;
  imageQuality: number;
  autoSaveDelayMs: number;
  defaultView: string;
  sourceLineWrap: boolean;
  spellcheck: boolean;
  fontSizePx: number;
  lineHeightPercent: number;
  density: string;
  defaultSidebar: string;
  sidebarOpen: boolean;
  hiddenPatterns: string[];
  treeRefreshSeconds: number;
  largeDocumentThresholdKib: number;
  previewDelayMs: number;
  outlineDelayMs: number;
  reducedMotion: boolean;
  highContrast: boolean;
  strongFocus: boolean;
}
export interface Appearance {
  theme: string;
  latinFont: string;
  cjkFont: string;
}
export interface Preferences {
  appearance: Appearance;
  web: WebPreferences;
}
export interface SettingsSnapshot {
  preferences: Preferences;
  pageWidth: string;
  sidebarWidth: number;
  commandShortcut: string;
}

export function createPreferenceDefaults(): WebPreferences {
  return {
    imageDirectory: "assets/images",
    imageCompression: "original",
    imageMaxEdge: 0,
    imageQuality: 85,
    autoSaveDelayMs: 1000,
    defaultView: "live",
    sourceLineWrap: true,
    spellcheck: true,
    fontSizePx: 17,
    lineHeightPercent: 175,
    density: "comfortable",
    defaultSidebar: "files",
    sidebarOpen: true,
    hiddenPatterns: [],
    treeRefreshSeconds: 0,
    largeDocumentThresholdKib: 768,
    previewDelayMs: 300,
    outlineDelayMs: 75,
    reducedMotion: false,
    highContrast: false,
    strongFocus: true,
  };
}
