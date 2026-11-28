use super::*;

#[test]
fn bundles_revalidate_and_negotiate_compression_but_html_is_not_cached() {
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let identity = client.request(
        "GET",
        "/app.mjs",
        &[("Accept-Encoding", "*;q=1, gzip;q=0")],
        b"",
    );
    let gzip = client.request("GET", "/app.mjs", &[("Accept-Encoding", "br, gzip")], b"");
    assert_eq!(gzip.status, 200);
    assert_eq!(gzip.headers["content-encoding"], "gzip");
    assert_eq!(gzip.headers["vary"], "Accept-Encoding");
    assert!(!identity.headers.contains_key("content-encoding"));
    assert!(gzip.body.len() < identity.body.len());
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(&gzip.body[..])
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(decoded, identity.body);
    let tag = &gzip.headers["etag"];
    assert_eq!(identity.headers["etag"], *tag);
    let warm = client.request("GET", "/app.mjs", &[("If-None-Match", tag)], b"");
    assert_eq!(warm.status, 304);
    assert!(warm.body.is_empty());
    assert_eq!(warm.headers["cache-control"], "private, no-cache");
    let other = client.request("GET", "/model.mjs", &[("If-None-Match", tag)], b"");
    assert_eq!(other.status, 200);
    let html = client.request("GET", "/", &[("If-None-Match", "*")], b"");
    assert_eq!(html.status, 200);
    assert_eq!(html.headers["cache-control"], "no-store");
    let html = html.text();
    let app = html
        .split_once("src=\"")
        .unwrap()
        .1
        .split('"')
        .next()
        .unwrap();
    let versioned = client.request("GET", app, &[], b"");
    assert_eq!(versioned.body, identity.body);
    assert!(versioned.headers["cache-control"].contains("immutable"));
    let stale = client.request("GET", "/app.mjs?v=old", &[], b"");
    assert_eq!(stale.headers["cache-control"], "private, no-cache");
}

#[test]
fn tree_revalidation_still_checks_auth_disk_and_resource_replacement() {
    let workspace = Workspace::new();
    workspace.write("one.md", "---\ntitle: Original\n---\n");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.api("GET", "/api/tree", None);
    let tag = &original.headers["etag"];
    let auth = format!("Bearer {}", client.token);
    let headers = [
        ("Authorization", auth.as_str()),
        ("If-None-Match", tag.as_str()),
    ];
    let unchanged = client.request("GET", "/api/tree", &headers, b"");
    assert_eq!(unchanged.status, 304);
    assert!(unchanged.body.is_empty());
    assert_eq!(unchanged.headers["cache-control"], "no-store");
    assert_ne!(
        client
            .request("GET", "/api/tree", &[("If-None-Match", tag)], b"")
            .status,
        304
    );
    workspace.write("one.md", "---\ntitle: External edit\n---\n");
    let changed = client.request("GET", "/api/tree", &headers, b"");
    assert_eq!(changed.status, 200);
    assert_eq!(changed.json()["files"][0]["title"], "External edit");
    let old_id = changed.json()["files"][0]["id"].clone();
    let removed = client.api("DELETE", "/api/entry", Some(json!({ "id": old_id })));
    assert_eq!(removed.status, 200, "{}", removed.text());
    workspace.write("one.md", "---\ntitle: External edit\n---\n");
    let fresh = client.api("GET", "/api/tree", None).json();
    assert_ne!(fresh["files"][0]["id"], old_id);
}

#[test]
fn cached_images_follow_external_file_changes() {
    let workspace = Workspace::new();
    workspace.write("image.png", vec![0x11; 64 * 1024]);
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let cookie = client.session_cookie();
    let image = client.resource_id("image.png", "asset");
    let get = || {
        client.request(
            "GET",
            &format!("/assets?id={image}"),
            &[("Cookie", &cookie)],
            b"",
        )
    };
    assert_eq!(get().body, vec![0x11; 64 * 1024]);
    assert_eq!(get().body, vec![0x11; 64 * 1024]);
    workspace.write("image.png", vec![0x22; 64 * 1024 + 1]);
    let changed = get();
    assert_eq!(changed.body, vec![0x22; 64 * 1024 + 1]);
    assert_eq!(changed.headers["cache-control"], "no-store");
}

#[test]
fn cached_documents_follow_external_file_changes() {
    let workspace = Workspace::new();
    workspace.write(
        "note.md",
        "---\ntitle: Original\n---\n\n# Original\n\ncontent\n",
    );
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.get_document("note.md");
    assert_eq!(original.status, 200);
    let original_version = original.json()["version"].clone();
    assert_eq!(client.get_document("note.md").json()["title"], "Original");

    workspace.write(
        "note.md",
        "---\ntitle: Changed\n---\n\n# Changed\n\nexternal content\n",
    );
    let changed = client.get_document("note.md");
    assert_eq!(changed.status, 200);
    assert_eq!(changed.json()["title"], "Changed");
    assert_eq!(
        changed.json()["content"],
        "---\ntitle: Changed\n---\n\n# Changed\n\nexternal content\n"
    );
    assert!(
        changed.json()["html"]
            .as_str()
            .unwrap()
            .contains(">Changed</h1>")
    );
    assert_ne!(changed.json()["version"], original_version);
}
