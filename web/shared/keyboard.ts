export function primaryShortcut(keys: string) {
  return `${/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl"}+${keys}`;
}
