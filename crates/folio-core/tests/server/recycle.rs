use super::projects::{login, request, resource_id, users};
use super::*;

fn ok(reply: Reply) -> Value {
    assert_eq!(reply.status, 200, "{}", reply.text());
    reply.json()
}

#[test]
fn local_folder_round_trip_after_restart_preserves_every_member_and_identity() {
    let w = Workspace::new();
    let path = "plans_%/week";
    let note = "plans_%/week/topic.md";
    let asset = "plans_%/week/files/data.bin";
    let empty = "plans_%/week/empty";
    let text = "\u{feff}# Notes\r\n";
    w.write(note, text);
    w.write(asset, [0, 255, 2]);
    w.write("plans_%/weekly/keep.md", "keep");
    fs::create_dir_all(w.root.join(empty)).unwrap();
    let server = start(&w.root, 0).unwrap();
    let c = Client::new(&server);
    let ids = [
        (path, "directory"),
        (note, "document"),
        (asset, "asset"),
        (empty, "directory"),
    ]
    .map(|(path, kind)| (path, kind, c.resource_id(path, kind)));
    let keep = c.resource_id("plans_%/weekly/keep.md", "document");
    c.api("DELETE", "/api/entry", Some(json!({"id":ids[2].2})))
        .error(400);
    let deleted = ok(c.api("DELETE", "/api/entry", Some(json!({"id":ids[0].2}))));
    let entries = ok(c.api("GET", "/api/trash", None));
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["id"], deleted["id"]);
    assert_eq!(entries[0]["kind"], "directory");
    assert_eq!(entries[0]["path"], path);
    assert_eq!(entries[0]["size"], text.len() + 3);
    assert_eq!(entries[0]["resourceId"], ids[0].2);
    assert!(!w.root.join(path).exists());
    assert_eq!(
        fs::read_dir(w.root.join(".folio-trash")).unwrap().count(),
        1
    );
    assert!(
        !ok(c.api("GET", "/api/tree", None))
            .to_string()
            .contains(".folio-trash")
    );
    for (_, _, id) in &ids {
        c.api("GET", &format!("/api/resource?id={id}"), None)
            .error(404);
    }
    assert_eq!(c.resource_id("plans_%/weekly/keep.md", "document"), keep);
    drop(server);
    let server = start(&w.root, 0).unwrap();
    let c = Client::new(&server);
    assert_eq!(ok(c.api("GET", "/api/trash", None)), entries);
    let restore = || {
        c.api(
            "POST",
            "/api/trash/restore",
            Some(json!({"id":deleted["id"]})),
        )
    };
    w.write(&format!("{path}/replacement"), "do not replace");
    restore().error(409);
    assert_eq!(
        fs::read_to_string(w.root.join(path).join("replacement")).unwrap(),
        "do not replace"
    );
    fs::rename(w.root.join(path), w.root.join("replacement")).unwrap();
    assert_eq!(ok(restore()), json!({"path":path,"id":ids[0].2}));
    assert_eq!(ok(c.api("GET", "/api/trash", None)), json!([]));
    for (path, kind, id) in ids {
        assert_eq!(c.resource_id(path, kind), id);
    }
    assert_eq!(fs::read(w.root.join(note)).unwrap(), text.as_bytes());
    assert_eq!(fs::read(w.root.join(asset)).unwrap(), [0, 255, 2]);
    assert!(w.root.join(empty).is_dir());
}

#[test]
fn owner_only_folder_delete_revokes_nested_shares_and_refuses_wrong_project() {
    let w = Workspace::new();
    w.write("dir/private.md", "# Private\n![pic](../pic.png)");
    w.write("pic.png", [1, 2, 3]);
    let server = start_with_users(&w.root, 0, users(&w)).unwrap();
    let c = Client::new(&server);
    let owner = login(&c, "alice");
    let bob = login(&c, "bob");
    let folder = resource_id(&c, &owner, "default", "dir", "directory");
    let note = resource_id(&c, &owner, "default", "dir/private.md", "document");
    let pic = resource_id(&c, &owner, "default", "pic.png", "asset");
    let req = |user: &str, method: &str, route: &str, body: Option<Value>| {
        request(&c, user, "default", method, route, body)
    };
    ok(req(
        &owner,
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":"default","shared":"edit"})),
    ));
    let shared = ok(req(
        &owner,
        "POST",
        "/api/projects",
        Some(json!({"action":"document","id":"default","document":note,"permission":"publicEdit"})),
    ));
    let token = shared["publicLinks"]["dir/private.md"]["token"]
        .as_str()
        .unwrap();
    let other = ok(req(
        &owner,
        "POST",
        "/api/projects",
        Some(json!({"action":"create","kind":"new","name":"Elsewhere"})),
    ));
    let del = Some(json!({"id":folder}));
    request(
        &c,
        &owner,
        other["id"].as_str().unwrap(),
        "DELETE",
        "/api/entry",
        del.clone(),
    )
    .error(403);
    req(&bob, "DELETE", "/api/entry", del.clone()).error(403);
    let id = ok(req(&owner, "DELETE", "/api/entry", del))["id"].clone();
    req(&bob, "GET", "/api/trash", None).error(403);
    let restore = Some(json!({"id":id}));
    req(&bob, "POST", "/api/trash/restore", restore.clone()).error(403);
    request(
        &c,
        &owner,
        other["id"].as_str().unwrap(),
        "POST",
        "/api/trash/restore",
        restore.clone(),
    )
    .error(400);
    req(&bob, "GET", &format!("/assets?id={pic}"), None).error(403);
    ok(req(&owner, "POST", "/api/trash/restore", restore));
    req(&bob, "GET", &format!("/api/document?id={note}"), None).error(403);
    c.request(
        "POST",
        "/api/public/session",
        &[("X-Folio-Share", token)],
        b"",
    )
    .error(403);
}

#[test]
fn note_version_and_replacement_identities_are_isolated_across_recycles() {
    let w = Workspace::new();
    w.write("n.md", "first");
    let server = start(&w.root, 0).unwrap();
    let c = Client::new(&server);
    let first = ok(c.get_document("n.md"));
    w.write("n.md", "changed");
    let delete = |body| c.api("DELETE", "/api/entry", Some(body));
    delete(json!({"id":first["id"],"version":first["version"]})).error(409);
    assert_eq!(ok(c.api("GET", "/api/trash", None)), json!([]));
    let old = ok(delete(json!({"id":first["id"]})));
    w.write("n.md", "replacement");
    let second = ok(c.get_document("n.md"));
    assert_ne!(second["id"], first["id"]);
    let new = ok(delete(
        json!({"id":second["id"], "version":second["version"]}),
    ));
    let restore = |row: &Value| c.api("POST", "/api/trash/restore", Some(json!({"id":row["id"]})));
    assert_eq!(ok(restore(&old))["id"], first["id"]);
    restore(&new).error(409);
    assert_eq!(fs::read_to_string(w.root.join("n.md")).unwrap(), "changed");
    assert_eq!(ok(c.get_document("n.md"))["id"], first["id"]);
}

#[cfg(unix)]
#[test]
fn rejects_symlink_bin_or_unsafe_member_without_partial_deletion() {
    use std::os::unix::fs::symlink;
    let w = Workspace::new();
    w.write("dir/n.md", "keep");
    let server = start(&w.root, 0).unwrap();
    let c = Client::new(&server);
    let id = c.resource_id("dir", "directory");
    let delete = || c.api("DELETE", "/api/entry", Some(json!({"id":id})));
    symlink(&w.outside, w.root.join(".folio-trash")).unwrap();
    delete().error(403);
    assert_eq!(fs::read_dir(&w.outside).unwrap().count(), 0);
    fs::remove_file(w.root.join(".folio-trash")).unwrap();
    symlink(&w.outside, w.root.join("dir/link")).unwrap();
    delete().error(403);
    fs::remove_file(w.root.join("dir/link")).unwrap();
    w.write("dir/.secret/file", "private");
    delete().error(403);
    assert!(w.root.join("dir/n.md").exists());
    assert_eq!(ok(c.api("GET", "/api/trash", None)), json!([]));
}
