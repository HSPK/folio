use super::watch_access::WatchAccess;
use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        Self(
            std::env::current_dir()
                .unwrap()
                .join("target/access-tests")
                .join(hex(&random)),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "Could not clean access fixture {}: {error}",
                self.0.display()
            );
        }
    }
}

#[test]
fn retired_git_catalog_metadata_does_not_change_project_files_or_permissions() {
    let fixture = Fixture::new();
    let notes = fixture.0.join("notes");
    fs::create_dir_all(notes.join(".git")).unwrap();
    fs::write(notes.join(".git/config"), "fixture repository data").unwrap();
    fs::write(notes.join("note.md"), "# Kept\n").unwrap();
    let users = UserStore::new(fixture.0.join("config/users.json"));
    users.initialize_admin("alice", "test password").unwrap();
    let registry =
        Arc::new(Registry::open(Arc::new(files::Root::open(&notes).unwrap()), &users).unwrap());
    registry.initialize().unwrap();
    let mut saved: serde_json::Value = load_json(&registry.path, "projects").unwrap().unwrap();
    let project = saved["projects"]["default"].as_object_mut().unwrap();
    project.insert(
        "repository".into(),
        "https://example.invalid/legacy.git".into(),
    );
    project.insert("token".into(), "retired-test-credential".into());
    project.insert("gitSync".into(), serde_json::json!({"enabled": true}));
    fs::write(&registry.path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let owner = registry
        .resolve(
            "default",
            &AuthenticatedUser {
                username: "alice".into(),
                role: Role::Admin,
            },
        )
        .unwrap();
    assert!(owner.document_permissions("note.md").unwrap().writable);
    registry
        .mutate(|catalog| {
            catalog.projects.get_mut("default").unwrap().name = "Renamed".into();
            Ok(())
        })
        .unwrap();
    let migrated: serde_json::Value = load_json(&registry.path, "projects").unwrap().unwrap();
    for field in ["repository", "token", "gitSync"] {
        assert!(migrated["projects"]["default"].get(field).is_none());
    }
    assert_eq!(
        fs::read_to_string(notes.join("note.md")).unwrap(),
        "# Kept\n"
    );
    assert_eq!(
        fs::read_to_string(notes.join(".git/config")).unwrap(),
        "fixture repository data"
    );
    let mut invalid = migrated;
    invalid["projects"]["default"]["unknownField"] = true.into();
    fs::write(&registry.path, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(
        registry
            .load()
            .err()
            .expect("Unknown fields must be rejected")
            .message
            .contains("unknown field")
    );
}

#[test]
fn retained_access_and_weak_grants_recheck_current_permissions() {
    let fixture = Fixture::new();
    let notes = fixture.0.join("notes");
    fs::create_dir_all(&notes).unwrap();
    fs::write(notes.join("note.md"), "# Note\n").unwrap();
    let users = UserStore::new(fixture.0.join("config/users.json"));
    users
        .initialize_admin("alice", "access test password long enough")
        .unwrap();
    users
        .add("bob", "access test password long enough", Role::User)
        .unwrap();
    let root = Arc::new(files::Root::open(&notes).unwrap());
    let registry = Arc::new(Registry::open(root, &users).unwrap());
    let owner = registry
        .resolve(
            "default",
            &AuthenticatedUser {
                username: "alice".into(),
                role: Role::Admin,
            },
        )
        .unwrap();
    let share = |level| {
        registry
            .mutate(|catalog| {
                catalog.projects.get_mut("default").unwrap().shared = level;
                Ok(())
            })
            .unwrap()
    };
    share(Sharing::Edit);
    let member = registry
        .resolve(
            "default",
            &AuthenticatedUser {
                username: "bob".into(),
                role: Role::User,
            },
        )
        .unwrap();
    let watched = WatchAccess::new(&member);
    assert!(
        member
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
    share(Sharing::Read);
    assert!(!member.document_permissions("note.md").unwrap().writable);
    assert!(
        !watched
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
    assert_eq!(
        member.check(Some("note.md"), true).unwrap_err().status,
        axum::http::StatusCode::FORBIDDEN
    );
    assert!(owner.document_permissions("note.md").unwrap().writable);
    assert!(!owner.document_permissions("note.md").unwrap().collaborative);
    share(Sharing::Private);
    assert!(member.document_permissions("note.md").is_err());
    assert!(watched.document_permissions("note.md").is_err());
    share(Sharing::Edit);
    registry
        .mutate(|catalog| {
            catalog
                .projects
                .get_mut("default")
                .unwrap()
                .pages
                .insert("note.md".into(), Sharing::Private);
            Ok(())
        })
        .unwrap();
    assert!(member.check(Some("note.md"), false).is_err());
    assert!(!owner.document_permissions("note.md").unwrap().collaborative);
    registry
        .mutate(|catalog| {
            catalog
                .projects
                .get_mut("default")
                .unwrap()
                .pages
                .remove("note.md");
            Ok(())
        })
        .unwrap();
    assert!(
        member
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
    assert!(
        watched
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
}

#[test]
fn project_directory_changes_invalidate_retained_libraries_and_watch_grants() {
    let fixture = Fixture::new();
    let notes = fixture.0.join("notes");
    let replacement = fixture.0.join("replacement");
    fs::create_dir_all(&notes).unwrap();
    fs::create_dir(&replacement).unwrap();
    fs::write(notes.join("note.md"), "# Original\n").unwrap();
    fs::write(replacement.join("note.md"), "# Replacement\n").unwrap();
    let users = UserStore::new(fixture.0.join("config/users.json"));
    users.initialize_admin("alice", "test password").unwrap();
    let registry =
        Arc::new(Registry::open(Arc::new(files::Root::open(&notes).unwrap()), &users).unwrap());
    let admin = AuthenticatedUser {
        username: "alice".into(),
        role: Role::Admin,
    };
    let retained = registry.resolve("default", &admin).unwrap();
    let watched = WatchAccess::new(&retained);
    registry
        .manage(
            "default",
            &admin,
            SettingsUpdate {
                name: None,
                path: None,
                shared: Some(Sharing::Private),
                image_directory: None,
                root: Some(replacement.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
    assert!(retained.check(Some("note.md"), true).is_err());
    assert!(retained.tree().is_err());
    assert!(watched.document_permissions("note.md").is_err());
    let current = registry.resolve("default", &admin).unwrap();
    assert!(!Arc::ptr_eq(&retained.library, &current.library));
    assert_eq!(
        current.library.root.document("note.md").unwrap().content,
        "# Replacement\n"
    );
    assert!(current.check(Some("note.md"), true).is_ok());
}
