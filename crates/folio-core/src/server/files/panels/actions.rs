use super::{ApiError, AppState, Work, access};
use crate::server::{
    routes::blocking,
    state_store::{
        file_properties::{Properties, Snapshot},
        resources::ResourceKind,
    },
};
use axum::{
    Json,
    extract::{Extension, Query},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize)]
pub(in crate::server) struct Path {
    path: String,
}

pub(in crate::server) async fn properties(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(q): Query<Path>,
) -> Result<Json<Value>, ApiError> {
    blocking(state, work, move |state, _| {
        access(state, &q.path, false)?;
        let path = state.root.canonical_file_path(&q.path)?;
        let store = state.root.resource_store()?;
        let entry = store.identify(&path, ResourceKind::Asset)?;
        let snapshot = store.file_properties(&entry.id)?;
        let writable = state.authorize(None, true).is_ok() && state.authorize(Some(&path), true).is_ok();
        Ok(json!({"entry":entry, "details":state.root.details(&path)?, "snapshot":snapshot, "writable":writable}))
    }).await.map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::server) struct Edit {
    path: String,
    id: String,
    revision: i64,
    properties: Properties,
}

pub(in crate::server) async fn save_properties(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Json(edit): Json<Edit>,
) -> Result<Json<Snapshot>, ApiError> {
    blocking(state, work, move |state, _| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("Save unavailable."))?;
        access(state, &edit.path, false)?;
        state.authorize(None, true)?;
        state.authorize(Some(&edit.path), true)?;
        let path = state.root.canonical_file_path(&edit.path)?;
        let store = state.root.resource_store()?;
        let entry = store.resource(&edit.id, false)?;
        if entry.path != path || entry.kind != ResourceKind::Asset {
            return Err(ApiError::conflict("File changed. Reopen its properties."));
        }
        store.save_file_properties(&entry.id, edit.revision, edit.properties)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::server) struct Duplicate {
    path: String,
    destination: String,
}

pub(in crate::server) async fn duplicate(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Json(q): Json<Duplicate>,
) -> Result<Json<Value>, ApiError> {
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("Save unavailable."))?;
        access(state, &q.path, false)?;
        access(state, &q.destination, false)?;
        state.authorize(None, true)?;
        state.authorize(Some(&q.destination), true)?;
        if super::kind(&q.path) != super::kind(&q.destination)
            || std::path::Path::new(&q.path).extension()
                != std::path::Path::new(&q.destination).extension()
        {
            return Err(ApiError::bad_request("Keep the file's original extension."));
        }
        let source = state.root.resolve(&q.path)?;
        let store = state.root.resource_store()?;
        let source_path = state.root.canonical_file_path(&q.path)?;
        let source_id = store.identify(&source_path, ResourceKind::Asset)?.id;
        let properties = store.file_properties(&source_id)?;
        let mut file = source.parent.open_regular(&source.name)?;
        let bytes = super::super::read_limited(&mut file, 16 << 20, "Workspace files")?;
        let target = state.root.resolve(&q.destination)?;
        let mut staged = super::super::StagedFile::write(&target.parent, &bytes, None)?;
        staged.commit(&target.name, false, || work.check())?;
        drop(staged);
        target.parent.sync()?;
        let path = state.root.canonical_file_path(&q.destination)?;
        store.retire_resource(&path)?;
        let resource = store.identify(&path, ResourceKind::Asset)?;
        if properties.revision > 0 {
            store.save_file_properties(&resource.id, 0, properties.properties)?;
        }
        Ok(json!({"id":resource.id, "path":path}))
    })
    .await
    .map(Json)
}
