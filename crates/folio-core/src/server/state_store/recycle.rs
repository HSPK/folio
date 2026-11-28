use super::{
    ApiError, ProjectStore, compress, db_error, now,
    resources::{Resource, ResourceKind},
};
use crate::server::files::RecycleMove;
use rusqlite::{Transaction, params};

impl ProjectStore {
    pub(in crate::server) fn require_durable_trash(&self) -> Result<(), ApiError> {
        if self.store.directory.as_os_str().is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "Recycle storage is unavailable. Restart with a writable Folio state directory (FOLIO_LOCAL_STATE_DIR).",
            ));
        }
        Ok(())
    }

    pub(in crate::server) fn recycle_entry(
        &self,
        members: &[Resource],
        size: u64,
        version: &str,
        actor: &str,
        movement: &RecycleMove,
        verify: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<i64, ApiError> {
        let root = &movement.resource;
        let manifest = compress(
            &serde_json::to_vec(members)
                .map_err(|_| ApiError::internal("Could not encode the recycle manifest."))?,
        )?;
        self.store.with(|conn| {
            let tx = conn.transaction().map_err(db_error)?;
            tx.execute("INSERT INTO trash(project,path,content,size,version,kind,actor,deleted,resource_id)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![self.project, root.path, manifest, size, version,
                    if root.kind == ResourceKind::Document {"entry-note"} else {"entry-directory"},actor,now()?,root.id]).map_err(db_error)?;
            let id = tx.last_insert_rowid();
            for member in members {
                let n = tx.execute("UPDATE resources SET deleted=1 WHERE project=?1 AND path=?2 AND id=?3 AND deleted=0",
                    params![self.project,member.path,member.id]).map_err(db_error)?;
                if n != 1 { return Err(ApiError::conflict("A resource identity changed during deletion.")); }
            }
            self.clear_subtree(&tx, &root.path)?;
            self.commit_move(tx, movement, true, verify)?;
            Ok(id)
        })
    }

    pub(in crate::server) fn recover_entry(
        &self,
        id: i64,
        members: &[Resource],
        movement: &RecycleMove,
        verify: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        let root = &movement.resource;
        self.store.with(|conn| {
            let tx = conn.transaction().map_err(db_error)?;
            if tx.execute("DELETE FROM trash WHERE project=?1 AND id=?2 AND resource_id=?3 AND kind IN ('entry-note','entry-directory')",
                params![self.project,id,root.id]).map_err(db_error)? != 1 {
                return Err(ApiError::conflict("This recycled item no longer exists."));
            }
            // Broken links and permission summaries can register placeholder
            // identities while the destination is absent. Never give one the
            // restored data; the no-replace rename arbitrates real collisions.
            self.clear_subtree(&tx, &root.path)?;
            for member in members {
                let n = tx.execute("UPDATE resources SET deleted=0 WHERE project=?1 AND path=?2 AND id=?3 AND deleted=1",
                    params![self.project,member.path,member.id]).map_err(db_error)?;
                if n != 1 { return Err(ApiError::conflict("A recycled identity is in use elsewhere.")); }
            }
            self.commit_move(tx, movement, false, verify)
        })
    }

    fn clear_subtree(&self, tx: &Transaction<'_>, path: &str) -> Result<(), ApiError> {
        tx.execute(
            "UPDATE resources SET deleted=1 WHERE project=?1 AND deleted=0 AND
            (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",
            params![self.project, path],
        )
        .map_err(db_error)?;
        tx.execute("DELETE FROM rooms WHERE project=?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",
            params![self.project,path]).map_err(db_error)?;
        Ok(())
    }

    fn commit_move(
        &self,
        tx: Transaction<'_>,
        movement: &RecycleMove,
        deleting: bool,
        verify: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        tx.execute(
            "INSERT INTO resource_epochs(project,revision) VALUES (?1,1)
            ON CONFLICT(project) DO UPDATE SET revision=revision+1",
            [&self.project],
        )
        .map_err(db_error)?;
        movement.rename(deleting)?;
        if let Err(error) = verify()
            .and_then(|()| movement.sync())
            .and_then(|()| tx.commit().map_err(db_error))
        {
            movement.rename(!deleting).and_then(|()| movement.sync()).map_err(|rollback| ApiError::internal(format!(
                "The recycle move failed and rollback needs manual recovery: {} / {}. Neither destination was overwritten.",
                error.message, rollback.message)))?;
            return Err(error);
        }
        Ok(())
    }
}
