use std::{
    borrow::Cow,
    io::{Cursor, Read},
    sync::Arc,
};

use axum::{
    Json,
    extract::{Extension, Query},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use calamine::{DataRef, DataType, Reader, Xlsx};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{BOM, read_limited, validate_content, validate_relative, version};
use crate::server::{ApiError, AppState, MAX_DOCUMENT_BYTES, Work, routes::blocking};

pub(in crate::server) mod actions;
mod cache;
mod dimensions;
mod table;
use table::{Page, table_page};
pub(in crate::server) mod pdf;
#[cfg(test)]
mod tests;

pub(in crate::server) fn kind(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next()?;
    if name.starts_with(['.', '~']) {
        return None;
    }
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => "pdf",
        "xlsx" => "xlsx",
        "rs" | "py" | "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "css" | "scss" | "html"
        | "htm" | "vue" | "svelte" | "c" | "h" | "cpp" | "cxx" | "cc" | "hpp" | "go" | "java"
        | "kt" | "kts" | "swift" | "cs" | "rb" | "php" | "r" | "sql" | "sh" | "bash" | "ps1"
        | "lua" | "scala" | "dart" | "json" | "toml" | "xml" | "yaml" | "yml" => "code",
        _ => return None,
    })
}

pub(in crate::server) fn share_kind(
    path: &str,
) -> Result<crate::server::state_store::resources::ResourceKind, ApiError> {
    super::validate_relative(path)?;
    if super::is_markdown(path) {
        Ok(crate::server::state_store::resources::ResourceKind::Document)
    } else if kind(path).is_some() {
        Ok(crate::server::state_store::resources::ResourceKind::Asset)
    } else {
        Err(ApiError::bad_request("Choose a supported workspace file."))
    }
}

pub(in crate::server) fn access(state: &AppState, path: &str, write: bool) -> Result<(), ApiError> {
    validate_relative(path)?;
    let ty = kind(path).ok_or_else(|| ApiError::bad_request("Unsupported file type."))?;
    if write && ty != "code" {
        return Err(ApiError::forbidden("This file is read-only."));
    }
    state.authorize(Some(path), write)?;
    if let Some(access) = &state.access {
        if access.is_public() {
            if write {
                return Err(ApiError::forbidden("Shared files are read-only."));
            }
            return Ok(());
        }
        access.asset(path, None)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct Open {
    path: String,
    sheet: Option<usize>,
    row: Option<u32>,
    col: Option<u32>,
    view: Option<String>,
    filter_col: Option<u32>,
    filter: Option<String>,
    filters: Option<String>,
    facet_col: Option<u32>,
    sort_col: Option<u32>,
    #[serde(default)]
    desc: bool,
    #[serde(default)]
    download: bool,
    #[serde(default)]
    meta: bool,
}

pub(in crate::server) async fn native_pdf(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(mut q): Query<Open>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    q.view = Some("pdf".into());
    pdf::open(state, work, q, headers).await
}

pub(in crate::server) async fn open(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(q): Query<Open>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if q.view.as_deref() == Some("pdf") {
        return pdf::open(state, work, q, headers).await;
    }
    blocking(state, work, move |state, work| {
        access(state, &q.path, false)?;
        let ty = kind(&q.path).unwrap();
        let resolved = state.root.resolve(&q.path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        if ty == "xlsx" && !q.download {
            return Ok(Json(cache::preview(state, &mut file, &q, work)?).into_response());
        }
        let bytes = read_limited(
            &mut file,
            if ty == "code" {
                MAX_DOCUMENT_BYTES
            } else {
                16 << 20
            },
            "Workspace files",
        )?;
        if q.download {
            return Ok((
                [
                    (header::CONTENT_TYPE, "application/octet-stream"),
                    (header::CONTENT_DISPOSITION, "attachment"),
                ],
                bytes,
            )
                .into_response());
        }
        match ty {
            "code" => {
                validate_content(&bytes)?;
                let content =
                    std::str::from_utf8(bytes.strip_prefix(BOM).unwrap_or(&bytes)).unwrap();
                let writable = !file
                    .metadata()
                    .map_err(|e| ApiError::io("Could not inspect source file", e))?
                    .permissions()
                    .readonly()
                    && !state
                        .access
                        .as_ref()
                        .is_some_and(|access| access.is_public())
                    && state.authorize(Some(&q.path), true).is_ok();
                Ok(
                    Json(
                        json!({"content":content, "version":version(&bytes), "writable":writable}),
                    )
                    .into_response(),
                )
            }
            "pdf" if bytes.starts_with(b"%PDF-") => Ok((
                [
                    (header::CONTENT_TYPE, "application/octet-stream"),
                    (header::CONTENT_DISPOSITION, "attachment"),
                ],
                bytes,
            )
                .into_response()),
            "pdf" => Err(ApiError::bad_request("Not a PDF document.")),
            _ => Err(ApiError::bad_request("Unsupported workspace file.")),
        }
    })
    .await
}

#[derive(Deserialize)]
pub(in crate::server) struct Edit {
    path: String,
    content: String,
    version: String,
}
pub(in crate::server) async fn save(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Json(edit): Json<Edit>,
) -> Result<Json<Value>, ApiError> {
    blocking(state, work, move |state, work| {
        let _guard = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("Save unavailable."))?;
        let check = || {
            work.check()?;
            access(state, &edit.path, true)
        };
        check()?;
        let bytes =
            state
                .root
                .replace_text(&edit.path, &edit.content, &edit.version, check, true)?;
        Ok(Json(json!({"version":version(&bytes)})))
    })
    .await
}

const ROWS: u32 = 100;
const COLS: u32 = 32;
const XLSX_ROWS: u32 = 1_048_576;
const XLSX_COLS: u32 = 16_384;

fn invalid_xlsx() -> ApiError {
    ApiError::bad_request("Invalid, encrypted or unsupported XLSX workbook.")
}

fn too_large() -> ApiError {
    ApiError::too_large("Workbook exceeds the preview limit.")
}

fn validated_archive<'a>(
    bytes: &'a [u8],
    work: &Work,
) -> Result<zip::ZipArchive<Cursor<&'a [u8]>>, ApiError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid_xlsx())?;
    if archive.len() > 2048 {
        return Err(too_large());
    }
    let mut remaining = 48u64 << 20;
    for i in 0..archive.len() {
        work.check()?;
        let entry = archive.by_index(i).map_err(|_| invalid_xlsx())?;
        let size = entry.size();
        if size > remaining {
            return Err(too_large());
        }
        if std::io::copy(&mut entry.take(size + 1), &mut std::io::sink())
            .map_err(|_| invalid_xlsx())?
            != size
        {
            return Err(invalid_xlsx());
        }
        remaining -= size;
    }
    Ok(archive)
}

#[cfg(test)]
fn workbook(bytes: &[u8], query: &Open, work: &Work) -> Result<Value, ApiError> {
    match cache::parse(bytes, query.sheet.unwrap_or(0), work)? {
        Some(sheet) => cache::render(&sheet, query, work),
        None => uncached_workbook(bytes, query, work),
    }
}

fn uncached_workbook(bytes: &[u8], query: &Open, work: &Work) -> Result<Value, ApiError> {
    let mut archive = validated_archive(bytes, work)?;
    let mut book = Xlsx::new(Cursor::new(bytes)).map_err(|_| invalid_xlsx())?;
    let names = book.sheet_names().to_vec();
    let (mut result, rows) = render_sheet(&mut Book::Stream(&mut book), &names, query, work)?;
    if let Some(rows) = rows {
        result["layout"] = dimensions::read(
            &mut archive,
            query.sheet.unwrap_or(0),
            &rows,
            query.col.unwrap_or(0).min(XLSX_COLS - 1),
            work,
        )?;
    }
    Ok(result)
}

fn render_sheet(
    book: &mut Book<'_>,
    sheets: &[String],
    query: &Open,
    work: &Work,
) -> Result<(Value, Option<Vec<u32>>), ApiError> {
    let table = match query.view.as_deref() {
        None => false,
        Some("table" | "values") => true,
        _ => return Err(ApiError::bad_request("Unknown worksheet view.")),
    };
    let index = query.sheet.unwrap_or(0);
    let name = sheets
        .get(index)
        .ok_or_else(|| ApiError::bad_request("Worksheet not found."))?;
    let row = query.row.unwrap_or(0).min(XLSX_ROWS - 1);
    let col = query.col.unwrap_or(0).min(XLSX_COLS - 1);
    let mut page = Page::default();
    let table_fields = if table {
        let fields = table_page(
            book,
            name,
            query,
            work,
            row..row + ROWS,
            col..col + COLS,
            &mut page,
        )?;
        if query.view.as_deref() == Some("values") {
            return Ok((json!({"values":fields.facets.unwrap_or_default()}), None));
        }
        Some(fields)
    } else {
        scan(book, name, work, XLSX_ROWS - 1, |r, c, value| {
            page.height = page.height.max(r + 1);
            page.width = page.width.max(c + 1);
            if (row..row + ROWS).contains(&r) && (col..col + COLS).contains(&c) {
                page.push(r, c, value)?;
            }
            Ok(())
        })?;
        None
    };
    let mut result = json!({ "sheets":sheets, "cells":page.cells, "height":page.height, "width":page.width, "row":row, "col":col, "rows":ROWS, "cols":COLS });
    if let Some(fields) = table_fields {
        result["headers"] = json!(fields.headers);
        result["rowNumbers"] = json!(&fields.numbers);
        if let Some(facets) = fields.facets {
            result["values"] = json!(facets);
        }
        return Ok((result, Some(fields.numbers)));
    }
    Ok((result, None))
}

enum Book<'a> {
    Stream(&'a mut Xlsx<Cursor<&'a [u8]>>),
    Cached(&'a [cache::Cell]),
}

fn scan(
    book: &mut Book<'_>,
    name: &str,
    work: &Work,
    last_row: u32,
    mut visit: impl FnMut(u32, u32, &DataRef<'_>) -> Result<(), ApiError>,
) -> Result<(), ApiError> {
    let book = match book {
        Book::Cached(cells) => {
            for cell in cells.iter() {
                work.check()?;
                if cell.row > last_row {
                    break;
                }
                visit(cell.row, cell.col, &cell.value)?;
            }
            return Ok(());
        }
        Book::Stream(book) => book,
    };
    let mut reader = book
        .worksheet_cells_reader(name)
        .map_err(|_| invalid_xlsx())?;
    while let Some(cell) = reader.next_cell().map_err(|_| invalid_xlsx())? {
        work.check()?;
        if matches!(cell.get_value(), DataRef::Empty) {
            continue;
        }
        let (r, c) = cell.get_position();
        if r >= XLSX_ROWS || c >= XLSX_COLS {
            return Err(invalid_xlsx());
        }
        if r > last_row {
            break;
        }
        visit(r, c, cell.get_value())?;
    }
    Ok(())
}

fn convertible_date(dt: &calamine::ExcelDateTime) -> bool {
    // Beyond chrono's date range; don't pass an arbitrary float to its
    // milliseconds constructor (whose supported range is narrower than i64).
    dt.as_f64().abs() <= 100_000_000.0
}

fn display<'a>(value: &'a DataRef<'_>) -> Cow<'a, str> {
    if let Some(s) = value.get_string() {
        return Cow::Borrowed(s);
    }
    match value {
        DataRef::DateTime(dt) if convertible_date(dt) => {
            if let Some(date) = value.as_datetime() {
                return Cow::Owned(date.to_string());
            }
        }
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => return Cow::Borrowed(s),
        _ => (),
    }
    Cow::Owned(calamine::Data::from(value.clone()).to_string())
}
