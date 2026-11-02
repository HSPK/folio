use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
};
use serde::Deserialize;
use std::{fs, path::PathBuf, sync::Arc};

use super::{Project, Registry, Sharing, Summary, private_directory, validate_name};
use crate::{
    auth::{AuthenticatedUser, Role},
    server::{
        ApiError, AppState, Work, files, hex,
        routes::{blocking, json_error},
    },
};

pub(in crate::server) async fn scope(
    state: Arc<AppState>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    user: Option<AuthenticatedUser>,
) -> Result<Arc<AppState>, ApiError> {
    if super::public::endpoint(uri.path()) {
        return super::public::scope(state, uri, headers).await;
    }
    let scoped = matches!(
        uri.path(),
        "/api/session"
            | "/api/tree"
            | "/api/document"
            | "/api/entry"
            | "/api/directory"
            | "/api/preview"
            | "/assets"
            | "/api/images"
            | "/api/history"
            | "/api/backlinks"
            | "/api/attachments"
            | "/api/history/content"
            | "/api/history/restore"
            | "/api/trash"
            | "/api/trash/restore"
            | "/api/collaboration/join"
            | "/api/collaboration/presence"
            | "/api/collaboration/socket"
            | "/api/resource"
            | "/api/resources/resolve"
    );
    if !scoped || state.projects.is_none() {
        return Ok(state);
    }
    let user = user.ok_or_else(|| ApiError::forbidden("Log in to access projects."))?;
    #[derive(Deserialize)]
    struct Query {
        project: Option<String>,
        id: Option<String>,
        document: Option<String>,
    }
    let query = axum::extract::Query::<Query>::try_from_uri(&uri)
        .map_err(|_| ApiError::bad_request("Invalid project query."))?;
    if headers.get_all("x-folio-project").iter().count() > 1 {
        return Err(ApiError::bad_request("Choose one project."));
    }
    let selected = headers
        .get("x-folio-project")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| ApiError::bad_request("Invalid project header."))?
        .map(str::to_owned)
        .or(query.project.clone());
    let resource_id = match uri.path() {
        "/api/resource" | "/api/document" | "/api/entry" | "/assets" => query.id.clone(),
        "/api/history" | "/api/history/content" | "/api/backlinks" | "/api/images" => {
            query.document.clone()
        }
        _ => None,
    };
    let historical_resource = matches!(uri.path(), "/api/history" | "/api/history/content");
    tokio::task::spawn_blocking(move || {
        let mut scoped = (*state).clone();
        let registry = state
            .projects
            .as_ref()
            .ok_or_else(|| ApiError::internal("Projects are unavailable."))?;
        let id = if let Some(resource) = resource_id {
            let project = registry
                .storage()?
                .resource(&resource, historical_resource)?
                .project;
            if selected
                .as_ref()
                .is_some_and(|selected| selected != &project)
            {
                return Err(ApiError::forbidden(
                    "The resource and selected project do not match.",
                ));
            }
            project
        } else {
            selected.unwrap_or_else(|| "default".into())
        };
        let access = registry.resolve(&id, &user)?;
        scoped.library = access.library.clone();
        scoped.access = Some(access);
        Ok(Arc::new(scoped))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Project lookup failed: {error}")))?
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(in crate::server) enum Action {
    Create {
        name: String,
        kind: String,
        source: Option<String>,
    },
    Share {
        id: String,
        name: Option<String>,
        document: Option<String>,
        shared: Option<Sharing>,
        image_directory: Option<String>,
        root: Option<String>,
    },
    Document {
        id: String,
        document: String,
        permission: super::public::DocumentPermission,
        #[serde(default)]
        reset_link: bool,
        public_options: Option<super::shares::PublicOptions>,
    },
    PublicOptions {
        id: String,
        document: String,
        expires_at: Option<i64>,
        password: Option<String>,
        #[serde(default)]
        clear_password: bool,
    },
    RevokePublic {
        id: String,
        document: String,
    },
}

pub(in crate::server) async fn list(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
) -> Result<Json<Vec<Summary>>, ApiError> {
    let Extension(user) =
        user.ok_or_else(|| ApiError::forbidden("Projects require user accounts."))?;
    blocking(state, work, move |state, _| registry(state)?.list(&user))
        .await
        .map(Json)
}

pub(in crate::server) async fn manage(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
    body: Result<Json<Action>, JsonRejection>,
) -> Result<Json<Summary>, ApiError> {
    let Json(action) = body.map_err(json_error)?;
    let Extension(user) =
        user.ok_or_else(|| ApiError::forbidden("Projects require user accounts."))?;
    blocking(state, work, move |state, work| {
        let registry = registry(state)?;
        match action {
            Action::RevokePublic { id, document } => {
                registry.revoke_public(&id, &user.username, &document)
            }
            Action::PublicOptions {
                id,
                document,
                expires_at,
                password,
                clear_password,
            } => registry.public_options(
                &id,
                &user.username,
                &document,
                expires_at,
                password,
                clear_password,
            ),
            Action::Document {
                id,
                document,
                permission,
                reset_link,
                public_options,
            } => registry.document_permission(
                &id,
                &user.username,
                document,
                permission,
                reset_link,
                public_options,
            ),
            Action::Create { name, kind, source } => {
                create(registry, &user, name, &kind, source, work)
            }
            Action::Share {
                id,
                name,
                document,
                shared,
                image_directory,
                root,
            } => {
                let path = document
                    .as_deref()
                    .map(|document| registry.permission_path(&id, document))
                    .transpose()?;
                registry.manage(
                    &id,
                    &user,
                    super::SettingsUpdate {
                        name,
                        path,
                        shared,
                        image_directory,
                        root,
                    },
                )
            }
        }
    })
    .await
    .map(Json)
}

fn registry(state: &AppState) -> Result<&Registry, ApiError> {
    state
        .projects
        .as_deref()
        .ok_or_else(|| ApiError::forbidden("Projects require user accounts."))
}

fn create(
    registry: &Registry,
    user: &AuthenticatedUser,
    name: String,
    kind: &str,
    source: Option<String>,
    work: &Work,
) -> Result<Summary, ApiError> {
    let name = validate_name(name)?;
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|error| ApiError::internal(error.to_string()))?;
    let id = hex(&bytes);
    let mut created = None;
    let result = (|| {
        let root = match kind {
            "folder" => {
                if user.role != Role::Admin {
                    return Err(ApiError::forbidden(
                        "Only administrators can attach existing server folders.",
                    ));
                }
                let path = PathBuf::from(source.as_deref().unwrap_or(""));
                registry.folder_root(&path)?
            }
            "new" => {
                if !registry.managed.exists() {
                    private_directory(&registry.managed)?;
                }
                let root = registry.managed.join(&id);
                private_directory(&root)?;
                created = Some(root.clone());
                root
            }
            _ => {
                return Err(ApiError::bad_request(
                    "Choose new or folder as the project source.",
                ));
            }
        };
        work.check()?;
        let root = files::Root::open(&root)?.path().to_owned();
        registry.insert(
            user,
            id,
            Project {
                name,
                owner: Some(user.username.clone()),
                owner_id: Some(
                    registry
                        .users
                        .account_id(&user.username)
                        .map_err(ApiError::internal)?,
                ),
                root,
                shared: Sharing::Private,
                pages: Default::default(),
                attachments: Default::default(),
                image_directory: super::default_image_directory(),
                public_links: Default::default(),
            },
        )
    })();
    if result.is_err() {
        if let Some(path) = created {
            if let Err(error) = fs::remove_dir_all(&path) {
                eprintln!(
                    "Could not clean up failed project {}: {error}",
                    path.display()
                );
            }
        }
    }
    result
}
