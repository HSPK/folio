use std::path::{Path, PathBuf};

use super::Settings;
use crate::storage::{PublishMode, load_json, save_json};

/// Owns the platform location and atomic persistence of editor settings.
#[derive(Clone, Debug)]
pub struct SettingsStore {
    path: PathBuf,
    legacy: Vec<PathBuf>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            legacy: Vec::new(),
        }
    }

    fn migrating(directory: PathBuf, legacy: Vec<PathBuf>) -> Self {
        Self {
            path: directory.join("settings.json"),
            legacy: legacy
                .into_iter()
                .map(|directory| directory.join("settings.json"))
                .collect(),
        }
    }

    pub fn platform_default() -> Result<Self, String> {
        let (current, legacy) = Self::platform_data_directories()?;
        #[cfg(windows)]
        let home_variable = "USERPROFILE";
        #[cfg(not(windows))]
        let home_variable = "HOME";
        let home = PathBuf::from(
            std::env::var_os(home_variable)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{home_variable} is not set."))?,
        );
        if !home.is_absolute() {
            return Err(format!("{home_variable} must be absolute."));
        }
        Ok(Self::migrating(
            home.join(".local").join("folio"),
            vec![current, legacy],
        ))
    }

    pub(crate) fn platform_data_directory() -> Result<PathBuf, String> {
        Self::platform_data_directories().map(|(current, _)| current)
    }

    fn platform_data_directories() -> Result<(PathBuf, PathBuf), String> {
        #[cfg(windows)]
        {
            std::env::var_os("LOCALAPPDATA")
                .map(|path| {
                    let base = PathBuf::from(path);
                    (base.join("Folio"), base.join("NotesApp"))
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
                    (base.join("Folio"), base.join("NotesApp"))
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
            Ok((directory.join("folio"), directory.join("notes-app")))
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
            for legacy in &self.legacy {
                settings = load_json(legacy, "legacy settings")?;
                if settings.is_some() {
                    migrated = true;
                    break;
                }
            }
        }
        if let Some(settings) = &settings {
            settings.validate()?;
            if migrated {
                save_json(&self.path, "settings", settings, PublishMode::Create)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_settings_without_removing_legacy_data_or_overwriting_new_settings() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("folio-migration-{}", std::process::id()));
        let legacy = base.join("legacy");
        let older = base.join("older");
        let current = base.join("folio");
        let old = SettingsStore::new(legacy.join("settings.json"));
        let settings = Settings {
            port: 9123,
            ..Settings::default()
        };
        SettingsStore::new(older.join("settings.json"))
            .save(&Settings {
                port: 9122,
                ..settings.clone()
            })
            .unwrap();
        let store = SettingsStore::migrating(current, vec![legacy, older]);
        assert_eq!(store.load().unwrap().unwrap().port, 9122);
        std::fs::remove_file(store.path()).unwrap();
        old.save(&settings).unwrap();
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
