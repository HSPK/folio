use std::{
    borrow::Cow,
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap, HashMap, HashSet},
    io::{Cursor, Read},
    ops::Range,
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

#[derive(Default)]
struct Page {
    height: u32,
    width: u32,
    cells: Vec<(u32, u32, String)>,
    text_bytes: usize,
}

const MAX_SORT_ROWS: usize = 131_072;
const MAX_SORT_TEXT: usize = 8 << 20;

fn sort_limit() -> ApiError {
    ApiError::too_large(
        "Worksheet sort exceeds the preview limit. Filter the rows or choose an earlier page.",
    )
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
enum SortValue {
    Number(i64),
    DateTime(i64, u32),
    Duration(i64),
    Text(String),
    Bool(bool),
    Error(String),
}

// Variant order puts blanks last in both directions. The heap's secondary key
// is always the ascending physical row, even when the sort value is reversed.
#[derive(Default, Eq, Ord, PartialEq, PartialOrd)]
enum SortKey {
    Asc(SortValue),
    Desc(Reverse<SortValue>),
    #[default]
    Blank,
}

impl SortKey {
    fn new(value: &DataRef<'_>, desc: bool) -> Result<Self, ApiError> {
        use SortValue::*;
        let typed = match value {
            DataRef::Int(_) | DataRef::Float(_) => {
                let n = value.as_f64().unwrap();
                // Signed-integer ordering of IEEE bits, as in f64::total_cmp,
                // with the two zeros normalized so ties retain worksheet order.
                let bits = if n == 0.0 { 0 } else { n.to_bits() as i64 };
                Some(Number(bits ^ ((bits >> 63) as u64 >> 1) as i64))
            }
            DataRef::Bool(b) => Some(Bool(*b)),
            DataRef::Error(e) => Some(Error(e.to_string())),
            DataRef::DateTime(dt) if !convertible_date(dt) => None,
            DataRef::DateTime(dt) if dt.is_duration() => {
                value.as_duration().map(|d| Duration(d.num_milliseconds()))
            }
            DataRef::DurationIso(_) => value.as_duration().map(|d| Duration(d.num_milliseconds())),
            DataRef::DateTime(_) | DataRef::DateTimeIso(_) => value
                .as_datetime()
                .or_else(|| value.as_date()?.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc())
                .map(|d| DateTime(d.timestamp(), d.timestamp_subsec_nanos())),
            _ => None,
        };
        let key = if let Some(key) = typed {
            key
        } else {
            let text = display(value);
            if text.is_empty() {
                return Ok(Self::Blank);
            }
            if text.len() > MAX_SORT_TEXT {
                return Err(sort_limit());
            }
            Text(text.to_lowercase())
        };
        Ok(if desc {
            Self::Desc(Reverse(key))
        } else {
            Self::Asc(key)
        })
    }

    fn text_bytes(&self) -> usize {
        match self {
            Self::Asc(v) | Self::Desc(Reverse(v)) => match v {
                SortValue::Text(s) | SortValue::Error(s) => s.capacity(),
                _ => 0,
            },
            Self::Blank => 0,
        }
    }
}

#[derive(Default)]
struct SortWindow {
    heap: BinaryHeap<(SortKey, u32)>,
    text_bytes: usize,
}

impl SortWindow {
    // Only keep the best offset + page-size rows, not whole worksheet rows.
    fn consider(&mut self, key: SortKey, r: u32, end: usize) -> Result<(), ApiError> {
        let candidate = (key, r);
        if self.heap.len() == end {
            let worst = self.heap.peek().unwrap();
            if candidate >= *worst {
                return Ok(());
            }
            self.text_bytes -= worst.0.text_bytes();
            self.heap.pop();
        }
        self.text_bytes += candidate.0.text_bytes();
        if self.heap.len() >= MAX_SORT_ROWS || self.text_bytes > MAX_SORT_TEXT {
            return Err(sort_limit());
        }
        self.heap.push(candidate);
        Ok(())
    }
}

struct TableRow {
    physical: u32,
    matches: bool,
    columns: u32,
    facet: String,
    key: Result<SortKey, ApiError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ColumnFilter {
    col: u32,
    values: HashSet<String>,
    #[serde(default)]
    exclude: bool,
}

impl ColumnFilter {
    fn matches(&self, value: &str) -> bool {
        self.values.contains(value) != self.exclude
    }
}

struct TableFields {
    headers: Vec<String>,
    numbers: Vec<u32>,
    facets: Option<Vec<(String, u32)>>,
}

fn table_page(
    book: &mut Book<'_>,
    name: &str,
    query: &Open,
    work: &Work,
    rows: Range<u32>,
    cols: Range<u32>,
    page: &mut Page,
) -> Result<TableFields, ApiError> {
    let facet_only = query.view.as_deref() == Some("values");
    if facet_only && query.facet_col.is_none() {
        return Err(ApiError::bad_request("Choose a column."));
    }
    if [query.sort_col, query.filter_col, query.facet_col]
        .into_iter()
        .flatten()
        .any(|col| col >= XLSX_COLS)
    {
        return Err(ApiError::bad_request("Worksheet column is out of range."));
    }
    let filter = query
        .filter
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| {
            let col = query
                .filter_col
                .ok_or_else(|| ApiError::bad_request("filterCol is required with filter."))?;
            let pattern = regex::RegexBuilder::new(&regex::escape(s))
                .case_insensitive(true)
                .build()
                .map_err(|_| ApiError::bad_request("Worksheet filter is too long."))?;
            Ok::<_, ApiError>((col, pattern))
        })
        .transpose()?;
    let filters: Vec<ColumnFilter> = match query.filters.as_deref() {
        Some(s) if s.len() > 64 * 1024 => return Err(too_large()),
        Some(s) => serde_json::from_str(s)
            .map_err(|_| ApiError::bad_request("Invalid worksheet filters."))?,
        None => Vec::new(),
    };
    if filters.len() > 32
        || filters
            .iter()
            .any(|f| f.col >= XLSX_COLS || f.values.len() > 2000)
    {
        return Err(ApiError::bad_request("Invalid worksheet filters."));
    }
    let columns: HashMap<_, _> = filters
        .iter()
        .enumerate()
        .map(|(i, f)| (f.col, (1u32 << i, f)))
        .collect();
    if columns.len() != filters.len() {
        return Err(ApiError::bad_request("Invalid worksheet filters."));
    }
    let required = ((1u64 << filters.len()) - 1) as u32;
    let empty = columns.values().fold(
        0,
        |mask, (bit, f)| {
            if f.matches("") { mask | bit } else { mask }
        },
    );
    let facet_required = required
        & !query
            .facet_col
            .and_then(|c| columns.get(&c))
            .map_or(0, |(bit, _)| *bit);
    let sort_col = if facet_only { None } else { query.sort_col };
    let plain = !facet_only && filter.is_none() && columns.is_empty() && sort_col.is_none();
    let mut facets = BTreeMap::<String, u32>::new();
    let mut facet_bytes = 0;
    let mut headers = if facet_only {
        Vec::new()
    } else {
        vec![String::new(); COLS as usize]
    };
    let mut numbers = Vec::new();
    let mut sorted = SortWindow::default();
    let mut current: Option<TableRow> = None;
    let mut finish = |row: TableRow, page: &mut Page| -> Result<(), ApiError> {
        if query.facet_col.is_some()
            && row.matches
            && row.columns & facet_required == facet_required
        {
            if !facets.contains_key(&row.facet) {
                facet_bytes += row.facet.len();
                if facets.len() >= 2000 || facet_bytes > 2 << 20 {
                    return Err(ApiError::too_large(
                        "Too many distinct values for this column.",
                    ));
                }
            }
            *facets.entry(row.facet).or_default() += 1;
        }
        if !facet_only && row.matches && row.columns == required {
            if sort_col.is_some() {
                sorted.consider(row.key?, row.physical, rows.end as usize)?;
            } else if rows.contains(&page.height) {
                numbers.push(row.physical + 1);
            }
            page.height += 1;
        }
        Ok(())
    };
    scan(book, name, work, XLSX_ROWS - 1, |r, c, value| {
        page.width = page.width.max(c + 1);
        if current.as_ref().is_some_and(|row| r < row.physical) {
            return Err(invalid_xlsx());
        }
        if r == 0 {
            if !facet_only && cols.contains(&c) {
                headers[(c - cols.start) as usize] = page.text(value)?;
            }
            return Ok(());
        }
        if current.as_ref().is_none_or(|row| row.physical != r) {
            if let Some(row) = current.take() {
                finish(row, page)?;
            }
            current = Some(TableRow {
                physical: r,
                matches: filter.is_none(),
                columns: empty,
                facet: String::new(),
                key: Ok(SortKey::Blank),
            });
        }
        let row = current.as_mut().unwrap();
        let column = columns.get(&c);
        if column.is_some()
            || query.facet_col == Some(c)
            || filter.as_ref().is_some_and(|(col, _)| *col == c)
        {
            let text = display(value);
            if let Some((col, pattern)) = &filter {
                if c == *col {
                    row.matches = pattern.is_match(&text);
                }
            }
            if let Some((bit, f)) = column {
                if f.matches(&text) {
                    row.columns |= bit;
                } else {
                    row.columns &= !bit;
                }
            }
            if query.facet_col == Some(c) {
                if text.len() > 2 << 20 {
                    return Err(too_large());
                }
                row.facet = text.into_owned();
            }
        }
        if sort_col == Some(c) {
            row.key = SortKey::new(value, query.desc);
        }
        if plain && rows.contains(&page.height) && cols.contains(&c) {
            page.push(page.height, c, value)?;
        }
        Ok(())
    })?;
    if let Some(row) = current {
        finish(row, page)?;
    }
    if sort_col.is_some() {
        while sorted.heap.len() > rows.start as usize {
            numbers.push(sorted.heap.pop().unwrap().1 + 1);
        }
        numbers.reverse();
    }
    drop(sorted);

    if !plain && !numbers.is_empty() {
        match book {
            Book::Cached(cells) => {
                for (offset, number) in numbers.iter().enumerate() {
                    let start = cells.partition_point(|cell| cell.row < number - 1);
                    for cell in &cells[start..] {
                        work.check()?;
                        if cell.row != number - 1 {
                            break;
                        }
                        if cols.contains(&cell.col) {
                            page.push(rows.start + offset as u32, cell.col, &cell.value)?;
                        }
                    }
                }
            }
            Book::Stream(_) => {
                let offsets: HashMap<_, _> = numbers
                    .iter()
                    .enumerate()
                    .map(|(i, n)| (n - 1, rows.start + i as u32))
                    .collect();
                let last_row = *offsets.keys().max().unwrap();
                scan(book, name, work, last_row, |r, c, value| {
                    if cols.contains(&c) {
                        if let Some(display_row) = offsets.get(&r) {
                            page.push(*display_row, c, value)?;
                        }
                    }
                    Ok(())
                })?;
            }
        }
        page.cells.sort_unstable_by_key(|(r, c, _)| (*r, *c));
    }
    headers.truncate(page.width.saturating_sub(cols.start) as usize);
    Ok(TableFields {
        headers,
        numbers,
        facets: query.facet_col.map(|_| facets.into_iter().collect()),
    })
}

impl Page {
    fn text(&mut self, value: &DataRef<'_>) -> Result<String, ApiError> {
        let text = display(value);
        self.text_bytes += text.len();
        if self.text_bytes > 2 << 20 {
            return Err(too_large());
        }

        Ok(text.into_owned())
    }

    fn push(&mut self, r: u32, c: u32, value: &DataRef<'_>) -> Result<(), ApiError> {
        if self.cells.len() >= (ROWS * COLS) as usize {
            return Err(too_large());
        }
        let text = self.text(value)?;
        self.cells.push((r, c, text));
        Ok(())
    }
}
