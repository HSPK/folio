use super::room::{Event, MAX_STATE, Room, document, normalize};
use crate::server::{ApiError, AppState};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use yrs::{ReadTxn, StateVector, Text, Transact, Update, updates::decoder::Decode};

impl Room {
    /// Import external writes once per clean room, not once per connected peer.
    pub(super) fn follow_disk(&mut self, state: &AppState) -> Result<(), ApiError> {
        if self
            .last_disk_check
            .is_some_and(|at| at.elapsed() < Duration::from_secs(1))
        {
            return Ok(());
        }
        self.last_disk_check = Some(Instant::now());
        let stamp = state.root.document_stamp(&self.path)?;
        if self.disk_stamp.as_ref() == Some(&stamp) {
            return Ok(());
        }
        let disk = state.root.document(&self.path)?;
        if disk.id != self.saved.id {
            return Err(ApiError::conflict("Document identity changed."));
        }
        if disk.version != self.saved.version {
            // Keep unchanged Y.Text items (and relative cursors) on either side of the edit.
            let old = normalize(&self.saved.content);
            let new = normalize(&disk.content);
            let changed = old != new;
            let candidate = document();
            candidate
                .transact_mut()
                .apply_update(
                    Update::decode_v1(&self.snapshot())
                        .map_err(|e| ApiError::internal(e.to_string()))?,
                )
                .map_err(|e| ApiError::internal(e.to_string()))?;
            let vector = candidate.transact().state_vector();
            let shared = candidate.get_or_insert_text("markdown");
            let start: usize = old
                .chars()
                .zip(new.chars())
                .take_while(|(a, b)| a == b)
                .map(|(c, _)| c.len_utf8())
                .sum();
            let suffix: usize = old[start..]
                .chars()
                .rev()
                .zip(new[start..].chars().rev())
                .take_while(|(a, b)| a == b)
                .map(|(c, _)| c.len_utf8())
                .sum();
            let pos = old[..start].encode_utf16().count() as u32;
            let remove = old[start..old.len() - suffix].encode_utf16().count() as u32;
            let insert = &new[start..new.len() - suffix];
            {
                let mut txn = candidate.transact_mut();
                if remove > 0 {
                    shared.remove_range(&mut txn, pos, remove);
                }
                if !insert.is_empty() {
                    shared.insert(&mut txn, pos, insert);
                }
            }
            let snapshot = candidate
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            if snapshot.len() > MAX_STATE {
                return Err(ApiError::too_large("Collaborative history limit reached."));
            }
            if let Some(store) = &self.store {
                store.checkpoint_room(&self.id, &snapshot, &disk, "")?;
            }
            let update = candidate.transact().encode_state_as_update_v1(&vector);
            self.doc = candidate;
            self.saved = Arc::new(disk);
            self.failed = false;
            self.pending_bytes = 0;
            self.pending_updates = 0;
            self.actors.clear();
            if changed {
                let _ = self.events.send(Event::Update(Arc::from(update)));
            }
            let _ = self.events.send(Event::Saved(self.saved.clone()));
        }
        self.disk_stamp = Some(stamp);
        Ok(())
    }
}
