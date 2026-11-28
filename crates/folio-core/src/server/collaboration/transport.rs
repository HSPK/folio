use super::*;

async fn json(socket: &mut WebSocket, value: &Outgoing) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|error| error.to_string())
}

fn packet(update: &[u8]) -> Message {
    let mut bytes = Vec::with_capacity(update.len() + 4);
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(update);
    Message::Binary(bytes.into())
}

fn session_valid(state: &AppState, ticket: &Ticket) -> bool {
    if state
        .access
        .as_ref()
        .map(|access| access.connection_identity())
        .unwrap_or("")
        != ticket.principal
    {
        return false;
    }
    if let Some(access) = &state.access {
        if access.is_public() {
            return ticket.credential.is_none() && access.public_valid();
        }
    }
    match (&state.shared.user_auth, &ticket.credential) {
        (Some(auth), Some(token)) => auth.authenticate(token).is_some(),
        (None, None) => true,
        _ => false,
    }
}

fn authorize_socket(state: &AppState, ticket: &Ticket, path: &str) -> Result<(), String> {
    if !session_valid(state, ticket) {
        return Err("Your login or public link expired. Your local edits are kept.".into());
    }
    state
        .authorize_collaboration(path)
        .map_err(|error| error.message)
}

pub(super) async fn connected(mut socket: WebSocket, state: Arc<AppState>, ticket: Ticket) {
    let id = match random_id() {
        Ok(id) => id,
        Err(error) => {
            let _ = json(
                &mut socket,
                &Outgoing::Error {
                    message: error.message,
                },
            )
            .await;
            return;
        }
    };
    let result = run_socket(&mut socket, &state, &ticket, &id).await;
    if let Err(message) = result {
        let changed = state
            .access
            .as_ref()
            .map(|access| access.directory_changed());
        let response = match changed.transpose() {
            Ok(Some(true)) => Outgoing::Reset { message },
            Ok(_) => Outgoing::Error { message },
            Err(error) => Outgoing::Error {
                message: error.message,
            },
        };
        let _ = json(&mut socket, &response).await;
    }
    let flush = match ticket.room.lock() {
        Ok(mut room) => {
            let joined = room.peers.remove(&id).is_some();
            room.publish_presence();
            joined && room.peers.is_empty() && room.dirty && !room.failed && !room.stopped
        }
        Err(_) => {
            eprintln!("Could not remove disconnected collaborator: room lock poisoned.");
            false
        }
    };
    if flush {
        if let Err(error) = room::save(state, ticket.room.clone(), false).await {
            eprintln!(
                "Could not save the last collaborator's changes: {}",
                error.message
            );
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

async fn run_socket(
    socket: &mut WebSocket,
    state: &Arc<AppState>,
    ticket: &Ticket,
    id: &str,
) -> Result<(), String> {
    if !session_valid(state, ticket) {
        return Err("Your login expired. Log in again; your local edits are kept.".into());
    }
    if state
        .access
        .as_ref()
        .is_some_and(|access| !access.is_public() && !access.is_user(&ticket.name))
    {
        return Err("This collaboration ticket belongs to a different account.".into());
    }
    let (welcome, snapshot, mut events, mut presence) = {
        let state = state.clone();
        let ticket = ticket.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let _save = state
                .saves
                .lock()
                .map_err(|_| "The save lock is unavailable.")?;
            if !session_valid(&state, &ticket) {
                return Err("The login or public link changed before joining.".into());
            }
            let mut room = ticket.room.lock().map_err(|_| "The room is unavailable.")?;
            if room.stopped {
                return Err(
                    "This document session changed. Reopen the note before joining.".into(),
                );
            }
            state
                .authorize_collaboration(&room.path)
                .map_err(|error| error.message)?;
            if room.peers.len() >= MAX_PEERS {
                return Err("This document already has 12 connected editors.".into());
            }
            let color = (0..MAX_PEERS)
                .find(|color| room.peers.values().all(|peer| peer.color != *color))
                .unwrap_or(0);
            let peer = Peer {
                id: id.clone(),
                name: ticket.name.clone(),
                color,
                cursor: None,
            };
            room.peers.insert(id, peer.clone());
            let events = room.events.subscribe();
            room.publish_presence();
            let writable = state.authorize(Some(&room.path), true).is_ok();
            Ok((
                Outgoing::Welcome {
                    me: peer,
                    room: room.id.clone(),
                    users: room.presence(),
                    saved: room.saved.clone(),
                    blocked: room.failed,
                    writable,
                },
                room.snapshot(),
                events,
                room.presence_changed.subscribe(),
            ))
        })
        .await
        .map_err(|error| error.to_string())??
    };
    json(socket, &welcome).await?;
    socket
        .send(packet(&snapshot))
        .await
        .map_err(|error| error.to_string())?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    let mut last_seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0;
    loop {
        tokio::select! {
            received = socket.recv() => {
                let Some(received) = received else { break; };
                let message = received.map_err(|error| error.to_string())?;
                let path = ticket.room.lock().map_err(|_| "The room is unavailable.")?.path.clone();
                authorize_socket(state, ticket, &path)?;
                last_seen = Instant::now();
                if window.elapsed() > Duration::from_secs(1) { count = 0; window = Instant::now(); }
                count += 1;
                if count > 120 { return Err("Collaboration is receiving updates too quickly. Your local edits are kept.".into()); }
                match message {
                    Message::Binary(bytes) => {
                        state.authorize(Some(&path), true).map_err(|error| error.message)?;
                        if bytes.len() < 5 { return Err("Invalid collaboration packet.".into()); }
                        let sequence = u32::from_le_bytes(bytes[..4].try_into().map_err(|_| "Invalid packet.")?);
                        let room = ticket.room.clone();
                        let actor = ticket.name.clone();
                        let update = bytes.slice(4..);
                        tokio::task::spawn_blocking(move || {
                            room.lock().map_err(|_| "The room is unavailable.".to_owned())?
                                .apply(&update, &actor).map_err(|error| error.message)
                        }).await.map_err(|error| error.to_string())??;
                        json(socket, &Outgoing::Ack { sequence }).await?;
                    }
                    Message::Text(text) => {
                        if text.len() > 4096 { return Err("Collaboration control message is too large.".into()); }
                        match serde_json::from_str::<Incoming>(&text).map_err(|error| error.to_string())? {
                            Incoming::Cursor { cursor } => {
                                if cursor.as_ref().is_some_and(|cursor| cursor.anchor.len() > 256 || cursor.head.len() > 256
                                    || StickyIndex::decode_v1(&cursor.anchor).is_err()
                                    || StickyIndex::decode_v1(&cursor.head).is_err()
                                    || !["rich", "editor", "split", "preview"].contains(&cursor.mode.as_str())) {
                                    return Err("Invalid collaborator cursor.".into());
                                }
                                let mut room = ticket.room.lock().map_err(|_| "The room is unavailable.")?;
                                if let Some(peer) = room.peers.get_mut(id) { peer.cursor = cursor; }
                                room.publish_presence();
                            }
                            Incoming::Save => {
                                state.authorize(Some(&path), true).map_err(|error| error.message)?;
                                match room::save(state.clone(), ticket.room.clone(), false).await {
                                    Ok(document) => json(socket, &Outgoing::Saved { document }).await?,
                                    Err(error) => json(socket, &Outgoing::Error { message: error.message }).await?,
                                }
                            }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
            }
            event = events.recv() => {
                let path = ticket.room.lock().map_err(|_| "The room is unavailable.")?.path.clone();
                authorize_socket(state, ticket, &path)?;
                match event {
                    Ok(Event::Update(update)) => socket.send(packet(&update)).await.map_err(|error| error.to_string())?,
                    Ok(Event::Saved(document)) => json(socket, &Outgoing::Saved { document }).await?,
                    Ok(Event::Error(message)) => json(socket, &Outgoing::Error { message }).await?,
                    Ok(Event::Reset(message)) => { json(socket, &Outgoing::Reset { message }).await?; break; }
                    Err(broadcast::error::RecvError::Lagged(_)) => return Err("Collaboration updates were missed. Reconnect to resynchronize.".into()),
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            changed = presence.changed() => {
                if changed.is_err() { break; }
                let (path, users) = {
                    let room = ticket.room.lock().map_err(|_| "The room is unavailable.")?;
                    (room.path.clone(), room.presence())
                };
                authorize_socket(state, ticket, &path)?;
                json(socket, &Outgoing::Presence { users }).await?;
            }
            _ = heartbeat.tick() => {
                let path = ticket.room.lock().map_err(|_| "The room is unavailable.")?.path.clone();
                authorize_socket(state, ticket, &path)?;
                if last_seen.elapsed() > Duration::from_secs(30) { return Err("The collaboration connection timed out.".into()); }
                if state.shared.health.stopping.load(std::sync::atomic::Ordering::Acquire) { break; }
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|error| error.to_string())?;
                if let Err(error) = room::save(state.clone(), ticket.room.clone(), true).await {
                    eprintln!("Collaborative save: {}", error.message);
                }
            }
        }
    }
    Ok(())
}
