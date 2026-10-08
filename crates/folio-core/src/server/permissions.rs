use super::{ApiError, AppState};
use axum::{
    extract::{Extension, Query, rejection::QueryRejection},
    http::{HeaderName, HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Copy, Serialize)]
pub(super) struct DocumentPermissions {
    pub writable: bool,
    pub collaborative: bool,
    pub owner: bool,
}

impl DocumentPermissions {
    fn header(self) -> HeaderValue {
        match (self.writable, self.collaborative, self.owner) {
            (false, false, false) => HeaderValue::from_static(
                r#"{"writable":false,"collaborative":false,"owner":false}"#,
            ),
            (false, false, true) => {
                HeaderValue::from_static(r#"{"writable":false,"collaborative":false,"owner":true}"#)
            }
            (false, true, false) => {
                HeaderValue::from_static(r#"{"writable":false,"collaborative":true,"owner":false}"#)
            }
            (false, true, true) => {
                HeaderValue::from_static(r#"{"writable":false,"collaborative":true,"owner":true}"#)
            }
            (true, false, false) => {
                HeaderValue::from_static(r#"{"writable":true,"collaborative":false,"owner":false}"#)
            }
            (true, false, true) => {
                HeaderValue::from_static(r#"{"writable":true,"collaborative":false,"owner":true}"#)
            }
            (true, true, false) => {
                HeaderValue::from_static(r#"{"writable":true,"collaborative":true,"owner":false}"#)
            }
            (true, true, true) => {
                HeaderValue::from_static(r#"{"writable":true,"collaborative":true,"owner":true}"#)
            }
        }
    }
}

impl AppState {
    pub(super) fn document_permissions(&self, path: &str) -> Result<DocumentPermissions, ApiError> {
        match &self.access {
            Some(access) => access.document_permissions(path),
            None if self.user_auth.is_none() => Ok(DocumentPermissions {
                writable: true,
                collaborative: true,
                owner: true,
            }),
            None => Err(ApiError::forbidden("Select an accessible project first.")),
        }
    }

    pub(super) fn authorize_collaboration(&self, path: &str) -> Result<(), ApiError> {
        if !self.document_permissions(path)?.collaborative {
            return Err(ApiError::forbidden(
                "Collaborative editing requires explicit shared editing permission.",
            ));
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
pub(super) struct DocumentQuery {
    id: String,
}

pub(super) async fn document(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<super::Work>>,
    query: Result<Query<DocumentQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(|error| ApiError::bad_request(error.body_text()))?;
    let (json, permissions) = super::routes::blocking(state, work, move |state, _| {
        let (path, revision) = state.document_path_with_revision(&query.id)?;
        let permissions = state.document_permissions(&path)?;
        let path = state.root.canonical_document_path(&path)?;
        let json = state.root.document_json_with_revision(&path, revision)?;
        if state.document_path(&query.id)? != path {
            return Err(ApiError::conflict(
                "This document moved while it was being read. Retry using the same document ID.",
            ));
        }
        Ok((json, permissions))
    })
    .await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (
                HeaderName::from_static("x-folio-document-permissions"),
                permissions.header(),
            ),
        ],
        json,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_permission_headers_match_serialized_permissions() {
        for writable in [false, true] {
            for collaborative in [false, true] {
                for owner in [false, true] {
                    let permissions = DocumentPermissions {
                        writable,
                        collaborative,
                        owner,
                    };
                    assert_eq!(
                        permissions.header().to_str().unwrap(),
                        serde_json::to_string(&permissions).unwrap()
                    );
                }
            }
        }
    }
}
