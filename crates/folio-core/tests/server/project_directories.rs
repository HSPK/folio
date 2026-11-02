use super::{
    projects::{login, request, resource_id, users},
    *,
};

#[test]
fn project_field_patches_preserve_unmentioned_settings_and_require_document_permissions() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let configure = |body| {
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(body),
        )
    };
    let initial = configure(json!({
        "action":"share", "id":"default", "name":"Stable project", "shared":"edit",
        "imageDirectory":"media/initial"
    }));
    assert_eq!(initial.status, 200, "{}", initial.text());
    let patched = configure(json!({
        "action":"share", "id":"default", "imageDirectory":"media/new"
    }));
    assert_eq!(patched.status, 200, "{}", patched.text());
    assert_eq!(patched.json()["shared"], "edit");
    assert_eq!(patched.json()["name"], "Stable project");
    assert_eq!(patched.json()["root"], initial.json()["root"]);
    assert_eq!(patched.json()["imageDirectory"], "media/new");
    let renamed = configure(json!({"action":"share", "id":"default", "name":"Renamed"}));
    assert_eq!(renamed.status, 200, "{}", renamed.text());
    assert_eq!(renamed.json()["shared"], "edit");
    assert_eq!(renamed.json()["imageDirectory"], "media/new");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    configure(json!({"action":"share", "id":"default", "document":document})).error(400);
    let invalid =
        configure(json!({"action":"share", "id":"default", "name":"", "imageDirectory":"changed"}));
    invalid.error(400);
    let projects = request(&client, &alice, "default", "GET", "/api/projects", None).json();
    let current = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["id"] == "default")
        .unwrap();
    assert_eq!(current["name"], "Renamed");
    assert_eq!(current["shared"], "edit");
    assert_eq!(current["imageDirectory"], "media/new");
}

#[test]
fn project_directory_changes_refresh_cached_files_and_survive_restart() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Original\n");
    workspace.write("old-only.md", "# Old directory\n");
    fs::write(workspace.outside.join("note.md"), "# Replacement\n").unwrap();
    fs::write(workspace.outside.join("new-only.md"), "# New directory\n").unwrap();
    let users = users(&workspace);
    let mut server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let id = resource_id(&client, &alice, "default", "note.md", "document");
    let original = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={id}"),
        None,
    )
    .json();
    assert_eq!(
        request(&client, &alice, "default", "GET", "/api/tree", None).json()["files"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let changed = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"share", "id":"default", "shared":"read",
            "root":workspace.outside, "name":"Relocated", "imageDirectory":"media/images"
        })),
    );
    assert_eq!(changed.status, 200, "{}", changed.text());
    let summary = changed.json();
    assert_eq!(summary["id"], "default");
    assert_eq!(summary["name"], "Relocated");
    assert_eq!(summary["imageDirectory"], "media/images");
    assert_eq!(
        summary["root"],
        json!(fs::canonicalize(&workspace.outside).unwrap())
    );
    let tree = request(&client, &alice, "default", "GET", "/api/tree", None).json();
    let paths = tree["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"new-only.md"));
    assert!(!paths.contains(&"old-only.md"));
    assert_eq!(
        resource_id(&client, &alice, "default", "note.md", "document"),
        id
    );
    let document = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={id}"),
        None,
    )
    .json();
    assert_eq!(document["content"], "# Replacement\n");
    request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":id, "content":"Stale editor", "version":original["version"]})),
    )
    .error(409);
    let saved = request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":id, "content":"# Updated replacement\n", "version":document["version"]})),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    assert_eq!(
        fs::read_to_string(workspace.root.join("note.md")).unwrap(),
        "# Original\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.root.join("old-only.md")).unwrap(),
        "# Old directory\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.outside.join("note.md")).unwrap(),
        "# Updated replacement\n"
    );
    server.stop().unwrap();
    let restarted = start_with_users(&workspace.root, 0, users).unwrap();
    let client = Client::new(&restarted);
    let alice = login(&client, "alice");
    let session = request(&client, &alice, "default", "POST", "/api/session", None).json();
    assert_eq!(session["project"]["root"], summary["root"]);
    assert_eq!(session["project"]["name"], "Relocated");
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "GET",
            &format!("/api/document?id={id}"),
            None
        )
        .json()["content"],
        "# Updated replacement\n"
    );
}

#[test]
fn project_directory_updates_require_an_admin_owner_and_validate_atomically() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Original\n");
    fs::create_dir_all(workspace.outside.join("nested")).unwrap();
    let users = users(&workspace);
    let server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let other = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(
            json!({"action":"create", "name":"Other", "kind":"folder", "source":workspace.outside}),
        ),
    );
    assert_eq!(other.status, 200, "{}", other.text());
    let original = request(&client, &alice, "default", "POST", "/api/session", None).json();
    let invalid = vec![
        (json!("relative/folder"), 400),
        (json!(""), 400),
        (json!(workspace.base.join("missing")), 404),
        (json!(users.path().parent().unwrap()), 403),
        (json!(workspace.outside), 409),
        (json!(workspace.outside.join("nested")), 409),
    ];
    #[cfg(unix)]
    let invalid = {
        let mut invalid = invalid;
        let alias = workspace.base.join("other-alias");
        std::os::unix::fs::symlink(&workspace.outside, &alias).unwrap();
        invalid.push((json!(alias), 409));
        invalid
    };
    for (root, status) in invalid {
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(json!({
                "action":"share", "id":"default", "shared":"edit",
                "name":"Should not persist", "imageDirectory":"changed/images", "root":root
            })),
        )
        .error(status);
        assert_eq!(
            request(&client, &alice, "default", "POST", "/api/session", None).json()["project"],
            original["project"]
        );
    }
    let replacement = workspace.base.join("replacement");
    fs::create_dir(&replacement).unwrap();
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"share", "id":"default", "name":"", "shared":"edit", "root":replacement})),
    )
    .error(400);
    assert_eq!(
        request(&client, &alice, "default", "POST", "/api/session", None).json()["project"],
        original["project"]
    );
    let note = resource_id(&client, &alice, "default", "note.md", "document");
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"share", "id":"default", "shared":"read", "document":note, "root":replacement
        })),
    )
    .error(400);
    let personal = request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"create", "kind":"new", "name":"Personal"})),
    )
    .json();
    let id = personal["id"].as_str().unwrap();
    for (cookie, project) in [(&bob, "default"), (&bob, id), (&alice, id)] {
        request(
            &client,
            cookie,
            project,
            "POST",
            "/api/projects",
            Some(json!({"action":"share", "id":project, "shared":"private", "root":replacement})),
        )
        .error(403);
    }
    assert_eq!(
        request(&client, &bob, id, "POST", "/api/session", None).json()["project"],
        personal
    );
}
