use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{
        Extension, Query, WebSocketUpgrade,
        rejection::JsonRejection,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use yrs::{StickyIndex, updates::decoder::Decode};

use super::{
    ApiError, AppState, Work, files, hex,
    routes::{blocking, json_error},
    security,
};

mod disk;
mod format;
mod lease;
pub(super) mod participation;
mod recovery;
mod room;
mod transport;
pub(super) use recovery::archive_pending;
pub(super) use recovery::has_pending;
use room::{Cursor, Event, MAX_PEERS, MAX_STATE, Peer, Room};
use transport::connected;

const MAX_ROOMS: usize = 16;
const MAX_TICKETS: usize = 128;

#[derive(Default)]
pub(super) struct Hub {
    rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    participation: Mutex<participation::Participation>,
}

#[derive(Clone)]
struct Ticket {
    room: Arc<Mutex<Room>>,
    name: String,
    credential: Option<String>,
    expires: Instant,
    principal: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Join {
    document: String,
    room_id: Option<String>,
    participant: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Joined {
    ticket: String,
    room_id: String,
}

#[derive(Deserialize)]
pub(super) struct SocketQuery {
    ticket: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Incoming {
    Cursor { cursor: Option<Cursor> },
    Save,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Outgoing {
    Welcome {
        me: Peer,
        room: String,
        users: Vec<Peer>,
        saved: Arc<files::Document>,
        blocked: bool,
        writable: bool,
    },
    Presence {
        users: Vec<Peer>,
    },
    Ack {
        sequence: u32,
    },
    Saved {
        document: Arc<files::Document>,
    },
    Error {
        message: String,
    },
    Reset {
        message: String,
    },
}

fn random_id() -> Result<String, ApiError> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(hex(&bytes))
}

impl Hub {
    fn expire_tickets(&self) -> Result<(), ApiError> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| ApiError::internal("Collaboration tickets are unavailable."))?;
        tickets.retain(|_, ticket| ticket.expires > Instant::now());
        if tickets.len() >= MAX_TICKETS {
            return Err(ApiError::conflict(
                "Too many pending collaboration connections.",
            ));
        }
        Ok(())
    }

    pub(super) fn ensure_solo(&self, path: &str) -> Result<(), ApiError> {
        self.participation
            .lock()
            .map_err(|_| ApiError::internal("Document presence is unavailable."))?
            .ensure_solo(path)
    }

    fn room(&self, state: &AppState, path: &str) -> Result<Arc<Mutex<Room>>, ApiError> {
        files::validate_document_path(path)?;
        let mut rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        if let Some(room) = rooms.get(path) {
            let mut current = room
                .lock()
                .map_err(|_| ApiError::internal("The room is unavailable."))?;
            let saved = state.root.document(path)?;
            if saved.version != current.saved.version || saved.id != current.saved.id {
                if Arc::strong_count(room) == 1 && current.peers.is_empty() && !current.dirty {
                    current.saved = Arc::new(saved);
                    current.doc = room::document();
                    {
                        use yrs::{Text, Transact};
                        current.doc.get_or_insert_text("markdown").insert(
                            &mut current.doc.transact_mut(),
                            0,
                            &room::normalize(&current.saved.content),
                        );
                    }
                    current.id = random_id()?;
                    current.checkpoint()?;
                } else {
                    return Err(ApiError::conflict(
                        "This note changed elsewhere. Copy your edits before reloading.",
                    ));
                }
            }
            drop(current);
            return Ok(room.clone());
        }
        if rooms.len() >= MAX_ROOMS {
            let mut remove = None;
            for (path, room) in rooms.iter() {
                if Arc::strong_count(room) != 1 {
                    continue;
                }
                let room = room
                    .lock()
                    .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
                if room.peers.is_empty() && !room.dirty {
                    remove = Some(path.clone());
                    break;
                }
            }
            if let Some(path) = remove {
                rooms.remove(&path);
            }
        }
        if rooms.len() >= MAX_ROOMS {
            return Err(ApiError::conflict(
                "Too many collaborative documents are open. Close a saved document first.",
            ));
        }
        let room = Arc::new(Mutex::new(Room::open(
            state.root.document(path)?,
            state.store.clone(),
        )?));
        rooms.insert(path.into(), room.clone());
        Ok(room)
    }

    pub(super) fn ensure_inactive(&self, path: &str) -> Result<(), ApiError> {
        let rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        for (name, room) in rooms.iter() {
            if path.is_empty() || name == path || name.starts_with(&format!("{path}/")) {
                let room = room
                    .lock()
                    .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
                if !room.peers.is_empty() || room.dirty {
                    return Err(ApiError::conflict(
                        "This note is in a collaborative session. Use collaborative save; close the session before moving it.",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn replace_document<T>(
        &self,
        path: &str,
        operation: impl FnOnce(bool) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        self.replace_rooms(path, false, |active| operation(active.contains(path)))
    }

    pub(super) fn replace_rooms<T>(
        &self,
        path: &str,
        descendants: bool,
        operation: impl FnOnce(&std::collections::BTreeSet<String>) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        let prefix = format!("{path}/");
        let active = rooms
            .keys()
            .filter(|name| *name == path || descendants && name.starts_with(&prefix))
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let mut current = active
            .iter()
            .map(|name| {
                let room = &rooms[name];
                room.lock()
                    .map_err(|_| ApiError::internal("The room is unavailable."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if current.iter().any(|room| room.dirty) {
            return Err(ApiError::conflict(
                "Wait until all shared changes are saved before restoring or deleting this document.",
            ));
        }
        let result = operation(&active)?;
        for room in &mut current {
            room.stopped = true;
            room.lease = None;
            let _ = room.events.send(Event::Reset("The owner restored or removed this document. Reopen it to continue; unsynced local text is kept.".into()));
        }
        drop(current);
        for name in active {
            rooms.remove(&name);
        }
        Ok(result)
    }
}

pub(super) async fn join(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
    body: Result<Json<Join>, JsonRejection>,
) -> Result<Json<Joined>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    let (name, credential) = if state
        .access
        .as_ref()
        .is_some_and(|access| access.is_public())
    {
        (
            state
                .access
                .as_ref()
                .and_then(|access| access.visitor_name())
                .map(str::to_owned)
                .unwrap_or(format!("Guest {}", &random_id()?[..6])),
            None,
        )
    } else if state.shared.user_auth.is_some() {
        let user = security::authenticated_user(&headers, &state)
            .ok_or_else(|| ApiError::forbidden("Log in before joining a collaborative note."))?;
        (
            user.username,
            security::cookie_value(&headers, &state.shared.user_cookie_name).map(str::to_owned),
        )
    } else {
        ("Local user".into(), None)
    };
    let principal = state
        .access
        .as_ref()
        .map(|access| access.connection_identity().to_owned())
        .unwrap_or_default();
    blocking(state, work, move |state, _| {
        let _saves = state.saves.lock().map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let path = state.document_path(&body.document)?;
        state.authorize_collaboration(&path)?;
        let path = state.root.canonical_document_path(&path)?;
        if state.access.is_some() && body.room_id.is_none() {
            state.collaboration.participation.lock().map_err(|_| ApiError::internal("Document presence is unavailable."))?
                .authorize_join(&path, &principal, body.participant.as_deref())?;
        }

        if let Some(expected) = body.room_id.as_deref() {
            state.collaboration.verify_resume(state, &path, expected)?;
        }
        state.collaboration.expire_tickets()?;
        let room = state.collaboration.room(state, &path)?;
        let room_id = room.lock().map_err(|_| ApiError::internal("The room is unavailable."))?.id.clone();
        if body.room_id.is_some_and(|expected| expected != room_id) {
            return Err(ApiError::conflict("The collaborative session restarted. Your local edits are kept; copy them before reopening the note."));
        }
        let ticket = random_id()?;
        let mut tickets = state.collaboration.tickets.lock().map_err(|_| ApiError::internal("Collaboration tickets are unavailable."))?;
        tickets.insert(ticket.clone(), Ticket { room, name, credential, principal, expires: Instant::now() + Duration::from_secs(30) });
        Ok(Joined { ticket, room_id })
    }).await.map(Json)
}

pub(super) async fn socket(
    Extension(state): Extension<Arc<AppState>>,
    axum::extract::ConnectInfo(connection): axum::extract::ConnectInfo<super::net::ConnectionInfo>,
    Query(query): Query<SocketQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !headers.contains_key("origin") {
        return Err(ApiError::forbidden("A same-origin WebSocket is required."));
    }
    let ticket = state
        .collaboration
        .tickets
        .lock()
        .map_err(|_| ApiError::internal("Collaboration tickets are unavailable."))?
        .remove(&query.ticket)
        .filter(|ticket| ticket.expires > Instant::now())
        .ok_or_else(|| ApiError::forbidden("The collaboration ticket is invalid or expired."))?;
    connection.websocket();
    Ok(upgrade
        .max_message_size(MAX_STATE + 4)
        .max_frame_size(MAX_STATE + 4)
        .on_upgrade(move |socket| connected(socket, state, ticket)))
}

#[cfg(test)]
mod recycle_room_tests {
    use super::*;

    #[test]
    fn dirty_descendant_blocks_the_whole_move_and_clean_rooms_reset_only_in_scope() {
        let hub = Hub::default();
        let add = |path: &str, dirty: bool| {
            let saved = files::document_from_bytes(path, b"disk").unwrap();
            let mut room = Room::new(saved).unwrap();
            room.dirty = dirty;
            let room = Arc::new(Mutex::new(room));
            hub.rooms.lock().unwrap().insert(path.into(), room.clone());
            room
        };
        let first = add("folder/one.md", false);
        let nested = add("folder/sub/two.md", true);
        let sibling = add("folder-old/one.md", true);
        let blocked = hub.replace_rooms("folder", true, |_| -> Result<(), ApiError> {
            panic!("a dirty descendant must block the mutation")
        });
        assert_eq!(blocked.unwrap_err().status.as_u16(), 409);
        assert!(!first.lock().unwrap().stopped);
        nested.lock().unwrap().dirty = false;
        hub.replace_rooms("folder", true, |rooms| {
            assert_eq!(rooms.len(), 2);
            Ok(())
        })
        .unwrap();
        assert!(first.lock().unwrap().stopped && nested.lock().unwrap().stopped);
        assert!(!sibling.lock().unwrap().stopped);
    }
}
