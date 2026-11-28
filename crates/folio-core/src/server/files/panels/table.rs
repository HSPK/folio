use super::*;
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap, HashMap, HashSet},
    ops::Range,
};

#[derive(Default)]
pub(super) struct Page {
    pub(super) height: u32,
    pub(super) width: u32,
    pub(super) cells: Vec<(u32, u32, String)>,
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

pub(super) struct TableFields {
    pub(super) headers: Vec<String>,
    pub(super) numbers: Vec<u32>,
    pub(super) facets: Option<Vec<(String, u32)>>,
}

pub(super) fn table_page(
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

    pub(super) fn push(&mut self, r: u32, c: u32, value: &DataRef<'_>) -> Result<(), ApiError> {
        if self.cells.len() >= (ROWS * COLS) as usize {
            return Err(too_large());
        }
        let text = self.text(value)?;
        self.cells.push((r, c, text));
        Ok(())
    }
}
