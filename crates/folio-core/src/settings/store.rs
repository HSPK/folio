use std::path::{Path, PathBuf};

use super::Settings;
use crate::storage::{PublishMode, load_json, save_json};

/// Owns the platform location and atomic persistence of editor settings.
#[derive(Clone, Debug)]
pub struct SettingsStore {
    path: PathBuf,
    legacy: Option<PathBuf>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            legacy: None,
        }
    }

    fn migrating(directory: PathBuf, legacy: PathBuf) -> Self {
        Self {
            path: directory.join("settings.json"),
            legacy: Some(legacy.join("settings.json")),
        }
    }

    pub fn platform_default() -> Result<Self, String> {
        #[cfg(windows)]
        {
            std::env::var_os("LOCALAPPDATA")
                .map(|path| {
                    let base = PathBuf::from(path);
                    Self::migrating(base.join("Folio"), base.join("NotesApp"))
                })
                .ok_or_else(|| "LOCALAPPDATA is not set.".into())
        }
        #[cfg(target_os = "macos")]
        {
            std::env::var_os("HOME")
                .map(|path| {
                    let base = PathBuf::from(path)
                        .join("Library")
                        .join("Application Support");
                    Self::migrating(base.join("Folio"), base.join("NotesApp"))
                })
                .ok_or_else(|| "HOME is not set.".into())
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let directory =
                match std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
                    Some(value) => {
                        let path = PathBuf::from(value);
                        if !path.is_absolute() {
                            return Err("XDG_CONFIG_HOME must be absolute.".into());
                        }
                        path
                    }
                    None => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set.")?)
                        .join(".config"),
                };
            Ok(Self::migrating(
                directory.join("folio"),
                directory.join("notes-app"),
            ))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Err("This platform has no supported settings directory.".into())
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<Settings>, String> {
        let mut settings: Option<Settings> = load_json(&self.path, "settings")?;
        let mut migrated = false;
        if settings.is_none() {
            if let Some(legacy) = &self.legacy {
                settings = load_json(legacy, "legacy settings")?;
                migrated = settings.is_some();
            }
        }
        if let Some(settings) = &settings {
            settings.validate()?;
            if migrated {
                save_json(&self.path, "settings", settings, PublishMode::Create)?;
            }
        }

        #[cfg(test)]
        mod tests {
            use super::*;

            #[test]
            fn migrates_settings_without_removing_legacy_data_or_overwriting_new_settings() {
                let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("target")
                    .join(format!("folio-migration-{}", std::process::id()));
                let legacy = base.join("legacy");
                let current = base.join("folio");
                let old = SettingsStore::new(legacy.join("settings.json"));
                let settings = Settings {
                    port: 9123,
                    ..Settings::default()
                };
                old.save(&settings).unwrap();
                let store = SettingsStore::migrating(current, legacy);
                assert_eq!(store.load().unwrap().unwrap().port, 9123);
                assert!(old.path().exists());
                store
                    .save(&Settings {
                        port: 9124,
                        ..settings
                    })
                    .unwrap();
                assert_eq!(store.load().unwrap().unwrap().port, 9124);
                std::fs::write(old.path(), b"corrupt legacy settings").unwrap();
                assert_eq!(store.load().unwrap().unwrap().port, 9124);
                std::fs::remove_file(store.path()).unwrap();
                assert!(store.load().is_err());
                assert!(!store.path().exists());
                std::fs::remove_dir_all(base).unwrap();
            }
        }
        Ok(settings)
    }

    pub fn save(&self, settings: &Settings) -> Result<(), String> {
        settings.validate()?;
        // Refuse to replace a corrupt previous configuration.
        self.load()?;
        save_json(&self.path, "settings", settings, PublishMode::Replace)
    }
}
