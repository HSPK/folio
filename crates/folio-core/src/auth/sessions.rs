use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{AuthenticatedUser, UserDatabase, hex};
use crate::storage::{PublishMode, load_json, save_json};

const DATABASE_VERSION: u32 = 2;
const MAX_SESSIONS: usize = 1024;

pub(super) fn scope(store: &Path, root: &Path) -> Result<(PathBuf, String), String> {
    let store = if store.is_absolute() {
        store.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(store)
    };
    let mut digest = Sha256::new();
    digest.update(store.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(root.to_string_lossy().as_bytes());
    let scope = hex(&digest.finalize());
    Ok((
        store.with_file_name(format!("sessions-{}.json", &scope[..16])),
        format!("folio_user_session_{}", &scope[..16]),
    ))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Session {
    user: AuthenticatedUser,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
    credential_hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionDatabase {
    version: u32,
    sessions: HashMap<String, Session>,
}

#[derive(Default)]
pub(super) struct SessionStore {
    path: Option<PathBuf>,
    sessions: HashMap<String, Session>,
    active: HashMap<String, Session>,
}

impl SessionStore {
    pub(super) fn revoke_user(&mut self, username: &str) -> Result<(), String> {
        self.sessions
            .retain(|_, session| session.user.username != username);
        self.active
            .retain(|_, session| session.user.username != username);
        self.persist(&self.sessions)
    }
    pub(super) fn load(
        path: Option<PathBuf>,
        users: Option<&UserDatabase>,
    ) -> Result<Self, String> {
        Self::load_at(path, users, unix_time())
    }

    fn load_at(
        path: Option<PathBuf>,
        users: Option<&UserDatabase>,
        now: u64,
    ) -> Result<Self, String> {
        let allowed = users
            .into_iter()
            .flat_map(|database| database.users.iter())
            .map(|(name, user)| (name.as_str(), (user.role, token_hash(&user.password_hash))))
            .collect::<HashMap<_, _>>();
        let (mut sessions, migrate) = match path.as_deref() {
            Some(path) => load_json::<SessionDatabase>(path, "sessions")?
                .map(|database| {
                    if !matches!(database.version, 1 | DATABASE_VERSION) {
                        return Err(format!(
                            "Unsupported session database version {}.",
                            database.version
                        ));
                    }
                    if database.sessions.len() > MAX_SESSIONS {
                        return Err(format!(
                            "The session database cannot contain more than {MAX_SESSIONS} entries."
                        ));
                    }
                    let migrate = database.version != DATABASE_VERSION
                        || database
                            .sessions
                            .values()
                            .any(|session| session.expires_at.is_some());
                    Ok((database.sessions, migrate))
                })
                .transpose()?
                .unwrap_or_default(),
            None => (HashMap::new(), false),
        };
        for token in sessions.keys() {
            if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("The session database contains an invalid token hash.".into());
            }
        }
        sessions.retain(|_, session| {
            session.expires_at.is_none_or(|expiry| expiry > now)
                && allowed
                    .get(session.user.username.as_str())
                    .is_some_and(|(role, credential)| {
                        *role == session.user.role && *credential == session.credential_hash
                    })
        });
        for session in sessions.values_mut() {
            session.expires_at = None;
        }
        let store = Self {
            path,
            sessions,
            active: HashMap::new(),
        };
        if migrate {
            store.persist(&store.sessions)?;
        }
        Ok(store)
    }

    pub(super) fn authenticate(&mut self, token: &str) -> Option<AuthenticatedUser> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        if let Some(session) = self.active.get(token) {
            return Some(session.user.clone());
        }
        let session = self.sessions.get(&token_hash(token))?.clone();
        let user = session.user.clone();
        self.active.insert(token.to_owned(), session);
        Some(user)
    }

    pub(super) fn insert(
        &mut self,
        token: &str,
        user: AuthenticatedUser,
        password_hash: &str,
    ) -> Result<(), String> {
        let key = token_hash(token);
        if self.sessions.len() >= MAX_SESSIONS && !self.sessions.contains_key(&key) {
            return Err("The login session limit has been reached. Log out of an existing session or reset your password before logging in again.".into());
        }
        let mut sessions = self.sessions.clone();
        let session = Session {
            user,
            expires_at: None,
            credential_hash: token_hash(password_hash),
        };
        sessions.insert(key, session.clone());
        self.persist(&sessions)?;
        self.sessions = sessions;
        self.active.insert(token.to_owned(), session);
        Ok(())
    }

    pub(super) fn remove(&mut self, token: &str) -> Result<(), String> {
        let key = token_hash(token);
        if !self.sessions.contains_key(&key) {
            return Ok(());
        }
        let mut sessions = self.sessions.clone();
        sessions.remove(&key);
        self.persist(&sessions)?;
        self.sessions = sessions;
        self.active.remove(token);
        Ok(())
    }

    fn persist(&self, sessions: &HashMap<String, Session>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        load_json::<SessionDatabase>(path, "sessions")?;
        save_json(
            path,
            "sessions",
            &SessionDatabase {
                version: DATABASE_VERSION,
                sessions: sessions.clone(),
            },
            PublishMode::Replace,
        )
    }
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Role;

    fn user() -> AuthenticatedUser {
        AuthenticatedUser {
            username: "tester".into(),
            role: Role::Admin,
        }
    }

    #[test]
    fn capacity_does_not_revoke_existing_sessions() {
        let mut store = SessionStore::default();
        for index in 0..MAX_SESSIONS {
            store
                .insert(&format!("{index:064x}"), user(), "credential")
                .unwrap();
        }
        assert!(store.insert(&"f".repeat(64), user(), "credential").is_err());
        assert!(store.authenticate(&format!("{:064x}", 0)).is_some());
        assert!(
            store
                .authenticate(&format!("{:064x}", MAX_SESSIONS - 1))
                .is_some()
        );
        store.remove(&format!("{:064x}", 0)).unwrap();
        store.insert(&"f".repeat(64), user(), "credential").unwrap();
        assert!(store.authenticate(&"f".repeat(64)).is_some());
    }

    fn session_file(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "folio-sessions-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&directory).unwrap();
        directory.join("sessions.json")
    }

    #[test]
    fn persistent_sessions_survive_years_and_remain_revocable() {
        let path = session_file("persistent");
        let users = UserDatabase::initial("tester".into(), "credential".into());
        let token = "a".repeat(64);
        let mut store = SessionStore::load(Some(path.clone()), Some(&users)).unwrap();
        store.insert(&token, user(), "credential").unwrap();
        let later = unix_time() + 10 * 365 * 24 * 60 * 60;
        let mut restored = SessionStore::load_at(Some(path.clone()), Some(&users), later).unwrap();
        assert!(restored.authenticate(&token).is_some());
        restored.revoke_user("tester").unwrap();
        let mut revoked = SessionStore::load_at(Some(path.clone()), Some(&users), later).unwrap();
        assert!(revoked.authenticate(&token).is_none());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn valid_legacy_sessions_migrate_without_reviving_expired_tokens() {
        let now = unix_time();
        let path = session_file("legacy");
        let users = UserDatabase::initial("tester".into(), "credential".into());
        let mut sessions = HashMap::new();
        let expired = "e".repeat(64);
        let active = "a".repeat(64);
        sessions.insert(
            token_hash(&expired),
            Session {
                user: user(),
                expires_at: Some(now - 1),
                credential_hash: token_hash("credential"),
            },
        );
        sessions.insert(
            token_hash(&active),
            Session {
                user: user(),
                expires_at: Some(now + 60),
                credential_hash: token_hash("credential"),
            },
        );
        std::fs::write(
            &path,
            serde_json::to_vec(&SessionDatabase {
                version: 1,
                sessions,
            })
            .unwrap(),
        )
        .unwrap();
        let mut store = SessionStore::load_at(Some(path.clone()), Some(&users), now).unwrap();
        assert!(store.authenticate(&active).is_some());
        assert!(store.authenticate(&expired).is_none());
        let mut restored =
            SessionStore::load_at(Some(path.clone()), Some(&users), now + 86400).unwrap();
        assert!(restored.authenticate(&active).is_some());
        assert!(restored.authenticate(&expired).is_none());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
