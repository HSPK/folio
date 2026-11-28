use super::{ApiError, Store, db_error};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params};

pub(in crate::server) fn valid(value: &str) -> bool {
    value.len() == 8
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

// Never recycle a code: even an old bookmark to a revoked share must not open its replacement.
pub(super) fn assign(db: &Connection, kind: &str, id: &str) -> Result<String, ApiError> {
    let mut lookup = db
        .prepare_cached("SELECT code FROM page_codes WHERE kind=?1 AND identity=?2")
        .map_err(db_error)?;
    loop {
        if let Some(code) = lookup
            .query_row([kind, id], |row| row.get(0))
            .optional()
            .map_err(db_error)?
        {
            return Ok(code);
        }
        let mut bytes = [0; 6];
        getrandom::fill(&mut bytes).map_err(|e| ApiError::internal(e.to_string()))?;
        let code = URL_SAFE_NO_PAD.encode(bytes);
        if db
            .execute(
                "INSERT OR IGNORE INTO page_codes(kind,identity,code) VALUES (?1,?2,?3)",
                params![kind, id, code],
            )
            .map_err(db_error)?
            == 1
        {
            return Ok(code);
        }
    }
}

impl Store {
    pub(in crate::server) fn page_code(&self, kind: &str, id: &str) -> Result<String, ApiError> {
        self.with(|db| assign(db, kind, id))
    }

    pub(in crate::server) fn note_for_code(&self, code: &str) -> Result<String, ApiError> {
        self.with_read(|db| {
            db.query_row(
                "SELECT identity FROM page_codes WHERE kind='n' AND code=?1",
                [code],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "Note unavailable."))
        })
    }
}
