use super::{ApiError, AppState, Open, Work, access, blocking};
use axum::{
    Json,
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::{
    io::{Read, Seek, SeekFrom},
    sync::Arc,
    time::UNIX_EPOCH,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[derive(Clone)]
pub(in crate::server) struct Preview;

fn range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (from, to) = value.strip_prefix("bytes=")?.split_once('-')?;
    if size == 0 {
        return None;
    }
    if from.is_empty() {
        let length = to.parse::<u64>().ok()?.min(size);
        return (length > 0).then_some((size - length, size - 1));
    }
    let start = from.parse::<u64>().ok()?;
    let end = if to.is_empty() {
        size - 1
    } else {
        to.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end && start < size).then_some((start, end))
}

pub(super) async fn open(
    state: Arc<AppState>,
    work: Arc<Work>,
    query: Open,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let path = query.path;
    let (file, size, tag) = blocking(state, work, move |state, _| {
        access(state, &path, false)?;
        if super::kind(&path) != Some("pdf") {
            return Err(ApiError::bad_request("Choose a PDF file."));
        }
        let resolved = state.root.resolve(&path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        let mut magic = [0; 5];
        if file.read_exact(&mut magic).is_err() || &magic != b"%PDF-" {
            return Err(ApiError::bad_request("Not a PDF document."));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|e| ApiError::io("Could not read the PDF", e))?;
        let meta = file
            .metadata()
            .map_err(|e| ApiError::io("Could not inspect the PDF", e))?;
        let stamp = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos())
            .unwrap_or_default();
        #[cfg(unix)]
        let stamp = {
            use std::os::unix::fs::MetadataExt;
            format!(
                "{stamp:x}-{:x}-{:x}-{:x}",
                meta.ino(),
                meta.ctime(),
                meta.ctime_nsec()
            )
        };
        #[cfg(not(unix))]
        let stamp = format!("{stamp:x}");
        let tag = format!("\"pdf-{:x}-{stamp}\"", meta.len());
        Ok((file, meta.len(), tag))
    })
    .await?;
    if query.meta {
        return Ok(Json(serde_json::json!({"size":size, "version":tag})).into_response());
    }
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response_headers.insert(header::ETAG, HeaderValue::from_str(&tag).unwrap());
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static(if query.download {
            "attachment"
        } else {
            "inline"
        }),
    );
    let mut response = if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(tag.as_str())
    {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let requested = headers.get(header::RANGE).filter(|_| {
            headers
                .get(header::IF_RANGE)
                .is_none_or(|value| value.as_bytes() == tag.as_bytes())
        });
        let bounds = requested.map(|value| value.to_str().ok().and_then(|v| range(v, size)));
        let (start, end, status) = match bounds {
            Some(None) => {
                response_headers.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}")).unwrap(),
                );
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, response_headers).into_response());
            }
            Some(Some((start, end))) => (start, end, StatusCode::PARTIAL_CONTENT),
            None => (0, size - 1, StatusCode::OK),
        };
        let length = end - start + 1;
        if status == StatusCode::PARTIAL_CONTENT {
            response_headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")).unwrap(),
            );
        }
        response_headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&length.to_string()).unwrap(),
        );
        let mut file = tokio::fs::File::from_std(file);
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(|e| ApiError::io("Could not read the PDF", e))?;
        let stream =
            futures_util::stream::try_unfold((file, length), |(mut file, remaining)| async move {
                if remaining == 0 {
                    return Ok::<_, std::io::Error>(None);
                }
                let mut chunk = vec![0; remaining.min(64 * 1024) as usize];
                let length = file.read(&mut chunk).await?;
                if length == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "The PDF changed while reading.",
                    ));
                }
                chunk.truncate(length);
                Ok(Some((chunk, (file, remaining - length as u64))))
            });
        (status, Body::from_stream(stream)).into_response()
    };
    response.headers_mut().extend(response_headers);
    response.extensions_mut().insert(Preview);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pdf_ranges_cover_partial_suffix_and_invalid_requests() {
        for (request, expected) in [
            ("bytes=0-4", Some((0, 4))),
            ("bytes=5-", Some((5, 9))),
            ("bytes=-3", Some((7, 9))),
            ("bytes=-30", Some((0, 9))),
            ("bytes=0-100", Some((0, 9))),
            ("bytes=10-", None),
            ("bytes=4-2", None),
            ("bytes=-0", None),
            ("bytes=0-1,4-5", None),
            ("items=0-1", None),
        ] {
            assert_eq!(range(request, 10), expected, "{request}");
        }
        assert_eq!(range("bytes=0-", 0), None);
    }
}
