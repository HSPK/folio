use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Extension, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::appearance::Appearance;

use super::{
    ApiError, AppState, MAX_JSON_BYTES, Work, accounts, authentication, collaboration, files,
    preferences, previews, security,
};

pub(super) fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/share", get(index))
        .route("/s/{id}", get(index))
        .route("/n/{id}", get(index))
        .route("/p/{id}", get(index))
        .route(
            "/mermaid-renderer.html",
            get(|| async {
                embedded(
                    "text/html; charset=utf-8",
                    include_bytes!("../../../../web/public/mermaid-renderer.html"),
                )
            }),
        )
        .route("/favicon.ico", get(app_icon))
        .route("/icon.svg", get(vector_icon))
        .route("/app.mjs", get(app_script))
        .route("/input-latency.mjs", get(input_latency_script))
        .route("/model.mjs", get(model_script))
        .route("/workspace-model.mjs", get(workspace_model))
        .route("/styles.css", get(styles))
        .route("/workspace.css", get(workspace_styles))
        .route("/editor.bundle.mjs", get(editor_script))
        .route("/formula.mjs", get(formula_script))
        .route("/code-syntax.mjs", get(code_syntax))
        .route("/math-fonts/{name}", get(math_font))
        .route("/editor.bundle.css", get(editor_styles))
        .route("/editor-helpers.mjs", get(editor_helpers))
        .route("/THIRD-PARTY-LICENSES.txt", get(editor_licenses))
        .route("/api/auth/status", get(authentication::status))
        .route("/api/auth/setup", post(authentication::setup))
        .route("/api/auth/register", post(accounts::register))
        .route(
            "/api/admin/accounts",
            get(accounts::list).post(accounts::manage),
        )
        .route("/api/auth/login", post(authentication::login))
        .route("/api/auth/logout", post(authentication::logout))
        .route("/api/session", post(session))
        .route(
            "/api/projects",
            get(super::projects::api::list).post(super::projects::api::manage),
        )
        .route("/api/collaboration/join", post(collaboration::join))
        .route(
            "/api/collaboration/presence",
            post(collaboration::participation::presence),
        )
        .route("/api/collaboration/socket", get(collaboration::socket))
        .route("/api/resource", get(super::resources::get))
        .route("/api/resources/resolve", post(super::resources::resolve))
        .route(
            "/api/public/session",
            post(super::projects::public::session).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/api/public/document",
            get(super::permissions::document).put(save_document),
        )
        .route("/api/public/preview", post(preview))
        .route("/api/public/panel-file", get(files::panels::open))
        .route("/api/public/resource", get(super::resources::get))
        .route(
            "/api/public/resources/resolve",
            post(super::resources::resolve),
        )
        .route("/api/public/assets", get(super::resources::asset))
        .route("/api/public/images", post(super::images::upload))
        .route("/api/public/collaboration/join", post(collaboration::join))
        .route(
            "/api/public/collaboration/presence",
            post(collaboration::participation::presence),
        )
        .route(
            "/api/public/collaboration/socket",
            get(collaboration::socket),
        )
        .route("/api/appearance", get(appearance))
        .route(
            "/api/preferences",
            get(preferences::get).put(preferences::put),
        )
        .route("/api/tree", get(tree))
        .route(
            "/api/panel-file",
            get(files::panels::open)
                .put(files::panels::save)
                .post(files::panels::actions::duplicate),
        )
        .route(
            "/api/file-properties",
            get(files::panels::actions::properties).put(files::panels::actions::save_properties),
        )
        .route("/api/search", post(super::search::search))
        .route(
            "/api/workspace",
            get(super::workspaces::get).post(super::workspaces::change),
        )
        .route("/api/history", get(super::history::list))
        .route("/api/shares", get(super::projects::shares::list))
        .route("/api/backlinks", get(super::links::backlinks))
        .route(
            "/api/attachments",
            get(super::attachments::list).post(super::attachments::recycle),
        )
        .route("/api/history/content", get(super::history::content))
        .route("/api/history/restore", post(super::history::restore))
        .route("/api/trash", get(super::history::trash_list))
        .route("/api/trash/restore", post(super::history::restore_trash))
        .route(
            "/api/document",
            get(super::permissions::document)
                .put(save_document)
                .post(create_document)
                .delete(super::history::trash_document),
        )
        .route("/api/directory", post(create_directory))
        .route(
            "/api/entry",
            get(entry_details)
                .patch(move_entry)
                .delete(super::recycle::delete),
        )
        .route("/api/preview", post(preview))
        .route("/api/images", post(super::images::upload))
        .route("/assets", get(super::resources::asset))
        .route("/assets/pdf", get(files::panels::native_pdf))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security::guard,
        ))
        .with_state(state)
}

#[derive(Clone)]
pub(super) struct StartPagePolicy(pub HeaderValue);

fn startup_element(
    src: &'static str,
    slot: &'static std::sync::OnceLock<(String, String)>,
    attr: &str,
    policy: &HeaderValue,
) -> (String, Option<StartPagePolicy>) {
    let (script, hash) = slot.get_or_init(|| {
        let script = src.replace("\r\n", "\n");
        let hash = STANDARD.encode(Sha256::digest(script.as_bytes()));
        (script, hash)
    });
    let csp = format!(
        "{}; script-src-elem 'self' 'sha256-{hash}'",
        policy.to_str().unwrap().trim_end_matches(';')
    );
    (
        format!("<script{attr}>{script}</script>"),
        Some(StartPagePolicy(HeaderValue::from_str(&csp).unwrap())),
    )
}

async fn index(
    State(state): State<Arc<AppState>>,
    user: Option<Extension<crate::auth::AuthenticatedUser>>,
    uri: axum::http::Uri,
) -> Response {
    let public = uri.path() == "/share" || uri.path().starts_with("/s/");
    let (start, policy) = if public {
        static SHARE: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
        startup_element(
            include_str!("../../../../web/public/start-share.js"),
            &SHARE,
            "",
            &state.shared.content_policy,
        )
    } else if state.shared.user_auth.is_some() {
        // Account names are normalized ASCII. No cookie or document data is embedded.
        let reader = user
            .map(|Extension(user)| format!(" data-reader=\"{}\"", user.username))
            .unwrap_or_default();
        static START: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
        startup_element(
            include_str!("../../../../web/public/start-session.js"),
            &START,
            &reader,
            &state.shared.content_policy,
        )
    } else {
        (String::new(), None)
    };
    let page = include_str!(concat!(env!("OUT_DIR"), "/index.html"))
        .replace(
            "__FOLIO_LAYOUT__",
            if public {
                "data-sidebar=\"closed\" data-share-page"
            } else {
                "data-sidebar=\"open\""
            },
        )
        .replace("__STYLE_NONCE__", &state.shared.style_nonce)
        .replace("<!--FOLIO_START_SESSION-->", &start);
    let mut response = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response();
    if let Some(policy) = policy {
        response.extensions_mut().insert(policy);
    }
    response
}

fn not_modified(headers: &HeaderMap, tag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|v| v == "*" || v.trim_start_matches("W/") == tag.trim_start_matches("W/"))
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let mut wildcard = false;
    for entry in headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
    {
        let (coding, quality) = entry.split_once(';').unwrap_or((entry, "q=1"));
        let allowed = quality.trim().split_once('=').is_some_and(|(name, q)| {
            name.trim().eq_ignore_ascii_case("q")
                && q.trim().parse::<f32>().is_ok_and(|q| q > 0.0 && q <= 1.0)
        });
        if coding.trim().eq_ignore_ascii_case("gzip") {
            return allowed;
        }
        if coding.trim() == "*" {
            wildcard = allowed;
        }
    }
    wildcard
}

fn bundle(
    headers: HeaderMap,
    query: Option<&str>,
    mime: &'static str,
    plain: &'static [u8],
    gzip: &'static [u8],
    tag: &'static str,
) -> Response {
    let mut response = if not_modified(&headers, tag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else if accepts_gzip(&headers) {
        let mut response = embedded(mime, gzip);
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        response
    } else {
        embedded(mime, plain)
    };
    let headers = response.headers_mut();
    let version = tag
        .strip_prefix("W/\"")
        .and_then(|tag| tag.strip_suffix('"'));
    let versioned = version.is_some() && query.and_then(|q| q.strip_prefix("v=")) == version;
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if versioned {
            "private, max-age=31536000, immutable"
        } else {
            "private, no-cache"
        }),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    headers.insert(header::ETAG, HeaderValue::from_static(tag));
    response
}

macro_rules! web_bundle {
    ($handler:ident, $name:literal, $mime:literal) => {
        async fn $handler(headers: HeaderMap, uri: axum::http::Uri) -> Response {
            bundle(
                headers,
                uri.query(),
                concat!($mime, "; charset=utf-8"),
                include_bytes!(concat!("../../../../web/public/", $name)),
                include_bytes!(concat!(env!("OUT_DIR"), "/", $name, ".gz")),
                include_str!(concat!(env!("OUT_DIR"), "/", $name, ".etag")),
            )
        }
    };
}
web_bundle!(workspace_styles, "workspace.css", "text/css");
web_bundle!(workspace_model, "workspace-model.mjs", "text/javascript");
web_bundle!(app_script, "app.mjs", "text/javascript");
web_bundle!(input_latency_script, "input-latency.mjs", "text/javascript");
web_bundle!(model_script, "model.mjs", "text/javascript");
web_bundle!(styles, "styles.css", "text/css");
web_bundle!(editor_script, "editor.bundle.mjs", "text/javascript");
web_bundle!(formula_script, "formula.mjs", "text/javascript");
web_bundle!(code_syntax, "code-syntax.mjs", "text/javascript");
web_bundle!(editor_styles, "editor.bundle.css", "text/css");
web_bundle!(editor_helpers, "editor-helpers.mjs", "text/javascript");

async fn math_font(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let bytes = include!(concat!(env!("OUT_DIR"), "/math_fonts.rs"));
    let mut response = embedded("font/woff2", bytes);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

async fn editor_licenses() -> Response {
    embedded(
        "text/plain; charset=utf-8",
        include_bytes!("../../../../web/public/THIRD-PARTY-LICENSES.txt"),
    )
}

async fn app_icon() -> Response {
    embedded(
        "image/x-icon",
        include_bytes!("../../../../Shared/Resources/Folio.ico"),
    )
}

async fn vector_icon() -> Response {
    embedded(
        "image/svg+xml",
        include_bytes!("../../../../Shared/Resources/FolioIcon.svg"),
    )
}

fn embedded(content_type: &'static str, bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}

#[derive(Serialize)]
struct Session {
    root: String,
    port: u16,
    project: Option<super::projects::Summary>,
}

async fn session(Extension(state): Extension<Arc<AppState>>) -> Result<Response, ApiError> {
    let mut response = Json(Session {
        root: state
            .access
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_else(|| state.root.path().to_string_lossy().into_owned()),
        port: state.shared.port,
        project: state
            .access
            .as_ref()
            .map(|access| access.summary())
            .transpose()?,
    })
    .into_response();
    if state.shared.user_auth.is_some() {
        return Ok(response);
    }
    let cookie = format!(
        "{}={}; Path=/assets; HttpOnly; SameSite=Strict",
        state.shared.cookie_name, state.shared.token
    );
    match HeaderValue::from_str(&cookie) {
        Ok(cookie) => {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
            Ok(response)
        }
        Err(_) => Err(ApiError::internal(
            "Could not establish the browser session.",
        )),
    }
}

async fn tree(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    blocking(state, work, move |state, _| {
        // Compare only after scanning and filtering with this request's current permissions.
        let tree = match &state.access {
            Some(access) => access.tree()?,
            None => state.root.tree()?,
        };
        let bytes = serde_json::to_vec(&tree)
            .map_err(|_| ApiError::internal("Could not encode the file list."))?;
        let tag = format!("\"{:x}\"", Sha256::digest(&bytes));
        let mut response = if not_modified(&headers, &tag) {
            StatusCode::NOT_MODIFIED.into_response()
        } else {
            ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
        };
        response
            .headers_mut()
            .insert(header::ETAG, HeaderValue::from_str(&tag).unwrap());
        Ok(response)
    })
    .await
}

async fn appearance(State(state): State<Arc<AppState>>) -> Result<Json<Appearance>, ApiError> {
    state
        .shared
        .appearance
        .read()
        .map(|appearance| Json(appearance.clone()))
        .map_err(|_| ApiError::internal("The appearance settings are unavailable."))
}

#[derive(Deserialize)]
struct PathQuery {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveDocument {
    id: String,
    content: String,
    version: String,
}

async fn save_document(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<SaveDocument>, JsonRejection>,
) -> Result<Json<files::Document>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The document save lock was poisoned."))?;
        let path = state.document_path(&body.id)?;
        state.authorize(Some(&path), true)?;
        let path = state.root.canonical_document_path(&path).map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::conflict(
                    "This document was removed or moved. Your editor text was not saved.",
                )
            } else {
                error
            }
        })?;
        state.collaboration.ensure_solo(&path)?;
        state.collaboration.ensure_inactive(&path)?;
        state.collaboration.replace_document(&path, |active| {
            let _lease = if active {
                None
            } else {
                state
                    .store
                    .as_ref()
                    .map(|store| store.room_lease(&path))
                    .transpose()?
            };
            if !active {
                if let Some(store) = &state.store {
                    super::collaboration::archive_pending(store, &path)?;
                }
            }
            let saved = state.save_recorded(
                &path,
                &body.content,
                &body.version,
                state.actor(),
                "save",
                || work.check(),
            )?;
            if let Some(store) = &state.store {
                store.clear_room(&path)?;
            }
            Ok(saved)
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields, rename_all_fields = "camelCase")]
enum NewDocument {
    Content { path: String, content: String },
    Duplicate { path: String, duplicate_of: String },
}

async fn create_document(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<NewDocument>, JsonRejection>,
) -> Result<(StatusCode, Json<files::Document>), ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The document save lock was poisoned."))?;
        let path = match &body {
            NewDocument::Content { path, .. } | NewDocument::Duplicate { path, .. } => path,
        };
        state.authorize(None, true)?;
        state.authorize(Some(path), true)?;
        let content = match &body {
            NewDocument::Content { content, .. } => std::borrow::Cow::Borrowed(content.as_str()),
            NewDocument::Duplicate { duplicate_of, .. } => {
                state.duplicate_source(duplicate_of)?.into()
            }
        };
        let saved = state.root.create(path, &content, || work.check())?;
        Ok(state.record_saved(saved, state.actor(), "create"))
    })
    .await
    .map(|document| (StatusCode::CREATED, Json(document)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewDirectory {
    path: String,
}

#[derive(Serialize)]
struct CreatedDirectory {
    id: String,
    kind: super::state_store::resources::ResourceKind,
    path: String,
}

async fn create_directory(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<NewDirectory>, JsonRejection>,
) -> Result<(StatusCode, Json<CreatedDirectory>), ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, _| {
        state.authorize(None, true)?;
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The document save lock was poisoned."))?;
        let path = state.root.create_directory(&body.path)?;
        let resource = state.root.resource_store()?.identify(
            &path,
            super::state_store::resources::ResourceKind::Directory,
        )?;
        Ok(CreatedDirectory {
            id: resource.id,
            kind: resource.kind,
            path,
        })
    })
    .await
    .map(|directory| (StatusCode::CREATED, Json(directory)))
}

async fn entry_details(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    query: Result<Query<PathQuery>, QueryRejection>,
) -> Result<Json<files::EntryDetails>, ApiError> {
    let Query(query) = query.map_err(query_error)?;
    blocking(state, work, move |state, _| {
        let resource = state.root.resource_store()?.resource(&query.id, false)?;
        let path = resource.path;
        if resource.kind == super::state_store::resources::ResourceKind::Asset {
            files::panels::access(state, &path, false)?;
        } else {
            files::validate_document_path(&path)?;
        }
        state.authorize(Some(&path), false)?;
        state.root.details(&path)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MoveEntry {
    id: String,
    destination: String,
    #[serde(default = "default_update_links")]
    update_links: bool,
}
fn default_update_links() -> bool {
    true
}

async fn move_entry(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<MoveEntry>, JsonRejection>,
) -> Result<Json<super::refactor::Moved>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The document save lock was poisoned."))?;
        let source = state.root.resource_store()?.resource(&body.id, false)?;
        let destination = state.root.canonical_destination(&body.destination)?;
        state.authorize(None, true)?;
        if let Some(access) = &state.access {
            access.movable(&source.path, &destination)?;
        }
        state.collaboration.ensure_inactive(&source.path)?;
        state.collaboration.ensure_inactive(&destination)?;
        super::refactor::move_entry(state, work, &source.path, &destination, body.update_links)
    })
    .await
    .map(Json)
}

#[derive(Serialize)]
struct Preview {
    html: String,
    references: Vec<files::Reference>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewDocument {
    id: String,
    content: String,
}

async fn preview(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<PreviewDocument>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    let json = blocking(state, work, move |state, _| {
        let path = state.document_path(&body.id)?;
        state.authorize(Some(&path), false)?;
        files::validate_content(body.content.as_bytes())?;
        let content = body
            .content
            .strip_prefix('\u{feff}')
            .unwrap_or(&body.content);
        let epoch = state.root.resource_revision()?;
        let key = previews::Key::new(&format!("{path}\0{epoch}"), content);
        if let Ok(mut cache) = state.preview_cache.lock() {
            if let Some(json) = cache.get(&key) {
                return Ok(json);
            }
        }
        let (html, references) = state
            .root
            .render_resource_markdown(&path, &body.id, content)?;
        let json =
            axum::body::Bytes::from(serde_json::to_vec(&Preview { html, references }).map_err(
                |error| ApiError::internal(format!("Could not encode preview: {error}")),
            )?);
        if let Ok(mut cache) = state.preview_cache.lock() {
            cache.insert(key, json.clone());
        }
        Ok(json)
    })
    .await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], json).into_response())
}

pub(super) async fn blocking<T, F>(
    state: Arc<AppState>,
    work: Arc<Work>,
    operation: F,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&AppState, &Work) -> Result<T, ApiError> + Send + 'static,
{
    let permit = state
        .shared
        .workers
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "The document worker is busy. Please try again.",
            )
        })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work.check()?;
        let result = operation(&state, &work)?;
        work.check()?;
        Ok(result)
    })
    .await
    .map_err(|error| ApiError::internal(format!("The document worker failed: {error}")))?
}

pub(super) fn json_error(error: JsonRejection) -> ApiError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::too_large("The request body is too large.")
    } else {
        ApiError::bad_request(format!("Invalid JSON request: {}", error.body_text()))
    }
}

fn query_error(error: QueryRejection) -> ApiError {
    ApiError::bad_request(format!(
        "Invalid document path query: {}",
        error.body_text()
    ))
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "This endpoint does not exist.")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "This HTTP method is not allowed.",
    )
}
