import { isRecord } from "../../shared/objects";
import { createPreferenceDefaults, type Preferences, type WebPreferences } from "../models/preferences";
import { ApiError } from "./error";

export function decodedPreferences(value: unknown): Preferences {
  if (!isRecord(value) || !isRecord(value.appearance) || !isRecord(value.web))
    throw new ApiError("The service returned incomplete settings.");
  const appearance = value.appearance;
  if (
    typeof appearance.theme !== "string" ||
    !["system", "light", "dark"].includes(appearance.theme) ||
    typeof appearance.latinFont !== "string" ||
    typeof appearance.cjkFont !== "string"
  )
    throw new ApiError("The service returned invalid appearance settings.");
  const web = { ...createPreferenceDefaults(), ...value.web };
  if (typeof web.imageDirectory !== "string")
    throw new ApiError("The service returned an invalid imageDirectory setting.");
  const choices: [keyof WebPreferences, string[]][] = [
    ["imageCompression", ["original", "webp", "jpeg"]],
    ["defaultView", ["live", "source", "compare", "read"]],
    ["density", ["compact", "comfortable"]],
    ["defaultSidebar", ["files", "outline"]],
  ];
  for (const [name, values] of choices) {
    const choice = web[name];
    if (typeof choice !== "string" || !values.includes(choice))
      throw new ApiError(`The service returned an invalid ${name} setting.`);
  }
  for (const name of [
    "sourceLineWrap",
    "spellcheck",
    "sidebarOpen",
    "reducedMotion",
    "highContrast",
    "strongFocus",
  ] as const)
    if (typeof web[name] !== "boolean") throw new ApiError(`The service returned an invalid ${name} setting.`);
  for (const name of [
    "autoSaveDelayMs",
    "fontSizePx",
    "lineHeightPercent",
    "treeRefreshSeconds",
    "largeDocumentThresholdKib",
    "previewDelayMs",
    "outlineDelayMs",
    "imageMaxEdge",
    "imageQuality",
  ] as const)
    if (!Number.isInteger(web[name]) || web[name] < 0)
      throw new ApiError(`The service returned an invalid ${name} setting.`);
  if (!Array.isArray(web.hiddenPatterns) || web.hiddenPatterns.some((pattern) => typeof pattern !== "string"))
    throw new ApiError("The service returned invalid hidden paths.");
  return {
    appearance: { theme: appearance.theme, latinFont: appearance.latinFont, cjkFont: appearance.cjkFont },
    web,
  };
}
