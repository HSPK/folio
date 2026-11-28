//! Sidebar recycle items keep the original directory entry on disk. Legacy
//! document/attachment trash remains byte-backed and uses its existing restore path.
use super::{
    ApiError, AppState, Work, collaboration, files, markdown,
    routes::{blocking, json_error},
    state_store::resources::{Resource, ResourceKind},
};
use axum::{
    Json,
    extract::{Extension, rejection::JsonRejection},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, atomic::Ordering},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Delete {
    id: String,
    version: Option<String>,
}

pub(super) async fn delete(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Delete>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        state.owner()?;
        let store = state.root.resource_store()?;
        store.require_durable_trash()?;
        let root = store.resource(&body.id, false)?;
        if body.version.is_some() && root.kind != ResourceKind::Document {
            return Err(ApiError::bad_request(
                "A version is only supported for Markdown files.",
            ));
        }
        let movement = state.root.recycle_move(&root, false)?;
        let inventory = movement.inspect(false, &|| work.check())?;
        let members = store.identify_many(
            &inventory
                .entries
                .iter()
                .map(|(p, k)| (p.clone(), *k))
                .collect::<Vec<_>>(),
        )?;
        if !members
            .iter()
            .any(|m| m.id == root.id && m.path == root.path)
        {
            return Err(ApiError::conflict("The resource changed before deletion."));
        }
        let id = with_rooms(state, work, &root, &members, || {
            let mut documents = BTreeMap::new();
            let mut version = String::new();
            for member in members.iter().filter(|m| m.kind == ResourceKind::Document) {
                work.check()?;
                let doc = state.root.source_document(&member.path)?;
                if doc.id.as_ref() != Some(&member.id) {
                    return Err(ApiError::conflict("The note's identity changed."));
                }
                if member.id == root.id {
                    if body.version.as_ref().is_some_and(|v| v != &doc.version) {
                        return Err(ApiError::conflict("The note changed before deletion."));
                    }
                    version = doc.version.clone();
                }
                if let Some(store) = &state.store {
                    documents.insert(
                        member.path.clone(),
                        markdown::referenced_assets(&member.path, &doc.content),
                    );
                    store.record(&doc, state.actor(), "delete")?;
                }
            }
            if let Some(access) = &state.access {
                access.privatize_recycled(&root.path, &documents)?;
            }
            work.check()?;
            store.recycle_entry(
                &members,
                inventory.size,
                &version,
                state.actor(),
                &movement,
                || {
                    verify(&movement, true, &inventory, work)?;
                    if root.kind == ResourceKind::Document {
                        movement.check_version(true, &version)?;
                    }
                    Ok(())
                },
            )
        })?;
        invalidate(state, &root.path)?;
        Ok(json!({"id":id, "path":root.path, "resourceId":root.id}))
    })
    .await
    .map(Json)
}

pub(super) fn restore(
    state: &AppState,
    work: &Work,
    id: i64,
    resource: &str,
    path: &str,
    bytes: &[u8],
) -> Result<Value, ApiError> {
    state.owner()?;
    let store = state.root.resource_store()?;
    let root = store.resource(resource, true)?;
    if !root.deleted || root.path != path {
        return Err(ApiError::conflict(
            "This recycled identity is no longer available.",
        ));
    }
    let movement = state.root.recycle_move(&root, true)?;
    let inventory = movement.inspect(true, &|| work.check())?;
    let members: Vec<Resource> = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::internal("Invalid recycle manifest."))?;
    if members.len() != inventory.entries.len()
        || !members.iter().zip(&inventory.entries).all(|(m, (p, k))| {
            m.path == *p
                && m.kind == *k
                && m.project == root.project
                && (p != path || m.id == root.id)
        })
    {
        return Err(ApiError::conflict(
            "The recycled tree no longer matches the original.",
        ));
    }
    with_rooms(state, work, &root, &members, || {
        // Another note may have occupied (and shared) the same path since
        // deletion. Do not allow a replacement's grants to attach to this tree.
        if let Some(access) = &state.access {
            let documents = members
                .iter()
                .filter(|m| m.kind == ResourceKind::Document)
                .map(|m| (m.path.clone(), BTreeSet::new()))
                .collect();
            access.privatize_recycled(path, &documents)?;
        }
        work.check()?;
        store.recover_entry(id, &members, &movement, || {
            verify(&movement, false, &inventory, work)
        })
    })?;
    invalidate(state, path)?;
    Ok(json!({"id":resource, "path":path}))
}

fn verify(
    movement: &files::RecycleMove,
    hidden: bool,
    expected: &files::Inventory,
    work: &Work,
) -> Result<(), ApiError> {
    if &movement.inspect(hidden, &|| work.check())? != expected {
        return Err(ApiError::conflict("The contents changed during the move."));
    }
    Ok(())
}

fn with_rooms<T>(
    state: &AppState,
    work: &Work,
    root: &Resource,
    members: &[Resource],
    action: impl FnOnce() -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    state
        .collaboration
        .replace_rooms(&root.path, root.kind == ResourceKind::Directory, |active| {
            let mut leases = Vec::new();
            if let Some(store) = &state.store {
                let prefix = format!("{}/", root.path);
                let stored = store
                    .room_paths()?
                    .into_iter()
                    .filter(|p| p == &root.path || p.starts_with(&prefix));
                let mut ids = members
                    .iter()
                    .filter(|m| m.kind == ResourceKind::Document && !active.contains(&m.path))
                    .map(|m| m.id.clone())
                    .collect::<BTreeSet<_>>();
                let mut archive = Vec::new();
                for path in stored.filter(|p| !active.contains(p)) {
                    if let Some(room) = store.load_room(&path)? {
                        ids.insert(room.resource);
                        archive.push(path);
                    }
                }
                for id in ids {
                    work.check()?;
                    leases.push(store.resource_lease(&id)?);
                }
                for path in archive {
                    work.check()?;
                    collaboration::archive_pending(store, &path)?;
                }
            }
            action()
        })
}

fn invalidate(state: &AppState, path: &str) -> Result<(), ApiError> {
    state.index_dirty.store(true, Ordering::Release);
    state.root.resource_revision()?;
    state.collaboration.forget(path)
}
