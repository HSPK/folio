use super::{ApiError, ProjectStore, db_error};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::server) struct Properties {
    pub title: String,
    pub tags: Vec<String>,
    pub description: String,
}

#[derive(Serialize)]
pub(in crate::server) struct Snapshot {
    pub revision: i64,
    pub properties: Properties,
}

impl ProjectStore {
    pub(in crate::server) fn file_properties(&self, id: &str) -> Result<Snapshot, ApiError> {
        let connection = self
            .store
            .connection
            .lock()
            .map_err(|_| ApiError::internal("Storage unavailable."))?;
        let stored: Option<(i64, String)> = connection
            .query_row(
                "SELECT revision,data FROM file_properties WHERE resource=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        match stored {
            Some((revision, data)) => Ok(Snapshot {
                revision,
                properties: serde_json::from_str(&data)
                    .map_err(|_| ApiError::internal("Invalid stored properties."))?,
            }),
            None => Ok(Snapshot {
                revision: 0,
                properties: Properties::default(),
            }),
        }
    }

    pub(in crate::server) fn save_file_properties(
        &self,
        id: &str,
        expected: i64,
        data: Properties,
    ) -> Result<Snapshot, ApiError> {
        if data.title.len() > 512
            || data.description.len() > 8192
            || data.tags.len() > 64
            || data.tags.iter().any(|t| t.len() > 128)
            || expected < 0
            || expected == i64::MAX
        {
            return Err(ApiError::bad_request("File properties are too long."));
        }
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| ApiError::internal("Storage unavailable."))?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let revision: Option<i64> = tx
            .query_row(
                "SELECT revision FROM file_properties WHERE resource=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if revision.unwrap_or(0) != expected {
            return Err(ApiError::conflict(
                "Properties changed. Reopen them before saving.",
            ));
        }
        tx.execute(
            "INSERT INTO file_properties(resource,revision,data) VALUES (?1,?2,?3)
            ON CONFLICT(resource) DO UPDATE SET revision=excluded.revision,data=excluded.data",
            params![
                id,
                expected + 1,
                serde_json::to_string(&data)
                    .map_err(|_| ApiError::internal("Invalid properties."))?
            ],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(Snapshot {
            revision: expected + 1,
            properties: data,
        })
    }
}
