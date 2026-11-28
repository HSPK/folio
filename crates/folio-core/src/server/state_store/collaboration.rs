use fs2::FileExt;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::{ApiError, ProjectStore, compress, db_error, decompress, now};

pub(in crate::server) struct StoredRoom {
    pub resource: String,
    pub id: String,
    pub state: Vec<u8>,
    pub saved: String,
    pub version: String,
    pub updates: Vec<(Vec<u8>, String)>,
    pub actor: String,
}

impl ProjectStore {
    pub(in crate::server) fn room_paths(&self) -> Result<Vec<String>, ApiError> {
        self.store.with(|connection| {
            let mut statement = connection
                .prepare("SELECT path FROM rooms WHERE project=?1")
                .map_err(db_error)?;
            statement
                .query_map([&self.project], |row| row.get(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)
        })
    }

    pub(in crate::server) fn room_lease(&self, path: &str) -> Result<std::fs::File, ApiError> {
        let resource = match self.resource_at_path(path, true)? {
            Some(resource) => resource,
            None => self.identify(
                path,
                if crate::server::files::is_markdown(path) {
                    super::resources::ResourceKind::Document
                } else {
                    super::resources::ResourceKind::Asset
                },
            )?,
        };
        self.resource_lease(&resource.id)
    }

    pub(in crate::server) fn resource_lease(&self, id: &str) -> Result<std::fs::File, ApiError> {
        self.resource(id, true)?;
        let key = crate::server::hex(&Sha256::digest(
            format!("{}\0{id}", self.project).as_bytes(),
        ));
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(self.store.directory.join(format!("room-{key}.lock")))
            .map_err(|error| ApiError::io("Could not open the collaboration lease", error))?;
        file.try_lock_exclusive().map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock { ApiError::conflict(
                "This document is open in another Folio service. Use that service or stop it before editing here.") }
            else { ApiError::io("Could not acquire the collaboration lease", error) }
        })?;
        Ok(file)
    }

    pub(in crate::server) fn load_room(&self, path: &str) -> Result<Option<StoredRoom>, ApiError> {
        self.store.with_read(|reader| {
            // The checkpoint and its following updates must come from one SQLite snapshot.
            let connection = reader.unchecked_transaction().map_err(db_error)?;
            let stored = connection.query_row(
                "SELECT room_id,state,saved,version,actor,resource_id FROM rooms WHERE project=?1 AND path=?2",
                params![self.project, path], |row| Ok((StoredRoom {
                    id: row.get(0)?, state: row.get(1)?, saved: String::new(),
                    version: row.get(3)?, actor: row.get(4)?, resource: row.get(5)?, updates: Vec::new(),
                }, row.get::<_, Vec<u8>>(2)?)))
                .optional().map_err(db_error)?;
            let Some((mut room, saved)) = stored else { return Ok(None); };
            let (bytes, count): (usize, usize) = connection.query_row(
                "SELECT COALESCE(SUM(length(data)),0),COUNT(*) FROM room_updates WHERE project=?1 AND path=?2",
                params![self.project, path], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
            if bytes > super::MAX_STORED_BYTES { return Err(ApiError::too_large("The collaboration recovery log exceeds the supported size.")); }
            if count > 4096 { return Err(ApiError::too_large("The collaboration recovery log contains too many updates.")); }
            let mut query = connection.prepare("SELECT data,actor FROM room_updates WHERE project=?1 AND path=?2 ORDER BY id").map_err(db_error)?;
            room.updates = query.query_map(params![self.project, path], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
            room.state = decompress(&room.state)?;
            room.saved = String::from_utf8(decompress(&saved)?).map_err(|_| ApiError::internal("The recovered Markdown is invalid."))?;
            Ok(Some(room))
        })
    }

    pub(in crate::server) fn checkpoint_room(
        &self,
        id: &str,
        state: &[u8],
        document: &crate::server::files::Document,
        actor: &str,
    ) -> Result<(), ApiError> {
        let path = &document.path;
        let resource = document.id.as_deref().ok_or_else(|| {
            ApiError::internal("The collaborative document has no resource identity.")
        })?;
        let state = compress(state)?;
        let saved = compress(document.raw_content().as_bytes())?;
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction.execute("INSERT INTO rooms(project,path,room_id,state,saved,version,actor,resource_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                ON CONFLICT(project,path) DO UPDATE SET room_id=excluded.room_id,state=excluded.state,saved=excluded.saved,version=excluded.version,actor=excluded.actor,resource_id=excluded.resource_id",
                params![self.project, path, id, state, saved, document.version, actor,resource]).map_err(db_error)?;
            transaction.execute("DELETE FROM room_updates WHERE project=?1 AND path=?2", params![self.project, path]).map_err(db_error)?;
            transaction.commit().map_err(db_error)
        })
    }

    pub(in crate::server) fn append_update(
        &self,
        path: &str,
        id: &str,
        update: &[u8],
        actor: &str,
    ) -> Result<(), ApiError> {
        self.store.with(|connection| {
            let count = connection.execute("INSERT INTO room_updates(project,path,data,actor,created)
                SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (SELECT 1 FROM rooms WHERE project=?1 AND path=?2 AND room_id=?6)",
                params![self.project, path, update, actor, now()?, id]).map_err(db_error)?;
            if count != 1 { return Err(ApiError::conflict("The durable collaborative room changed. Reconnect before editing.")); }
            Ok(())
        })
    }

    pub(in crate::server) fn clear_room(&self, path: &str) -> Result<(), ApiError> {
        self.store.with(|connection| {
            connection
                .execute(
                    "DELETE FROM rooms WHERE project=?1 AND path=?2",
                    params![self.project, path],
                )
                .map_err(db_error)?;
            Ok(())
        })
    }
}
