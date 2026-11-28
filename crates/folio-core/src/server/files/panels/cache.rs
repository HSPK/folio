use super::*;
use std::{
    collections::VecDeque,
    fs::File,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

const SHEET_BYTES: usize = 48 << 20;
const CACHE_BYTES: usize = 96 << 20;

pub(super) struct Cell {
    pub row: u32,
    pub col: u32,
    pub value: DataRef<'static>,
}

pub(super) struct Sheet {
    names: Vec<String>,
    pub cells: Vec<Cell>,
    layout: dimensions::Layout,
    bytes: usize,
}

#[derive(PartialEq, Eq)]
struct Stamp {
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

fn stamp(file: &File) -> Result<Stamp, ApiError> {
    let m = file
        .metadata()
        .map_err(|e| ApiError::io("Could not inspect the workbook", e))?;
    Ok(Stamp {
        length: m.len(),
        modified: m.modified().ok(),
        #[cfg(unix)]
        identity: {
            use std::os::unix::fs::MetadataExt;
            (m.dev(), m.ino(), m.ctime(), m.ctime_nsec())
        },
    })
}

#[derive(PartialEq, Eq)]
struct Key {
    root: PathBuf,
    path: String,
    sheet: usize,
    stamp: Stamp,
}
struct Entry {
    key: Key,
    sheet: Arc<Sheet>,
}
static CACHE: OnceLock<Mutex<VecDeque<Entry>>> = OnceLock::new();

pub(super) fn preview(
    state: &AppState,
    file: &mut File,
    query: &Open,
    work: &Work,
) -> Result<Value, ApiError> {
    let key = Key {
        root: state.root.path().to_owned(),
        path: query.path.clone(),
        sheet: query.sheet.unwrap_or(0),
        stamp: stamp(file)?,
    };
    let cache = CACHE.get_or_init(Default::default);
    let found = {
        let mut entries = cache
            .lock()
            .map_err(|_| ApiError::internal("Workbook cache unavailable."))?;
        entries
            .iter()
            .position(|entry| entry.key == key)
            .map(|index| {
                let entry = entries.remove(index).unwrap();
                let sheet = entry.sheet.clone();
                entries.push_back(entry);
                sheet
            })
    };
    if let Some(sheet) = found {
        return render(&sheet, query, work);
    }
    let bytes = read_limited(file, 16 << 20, "Workspace files")?;
    if stamp(file)? != key.stamp {
        return Err(ApiError::conflict("Workbook changed. Reload the file."));
    }
    let Some(sheet) = parse(&bytes, key.sheet, work)? else {
        return uncached_workbook(&bytes, query, work);
    };
    let sheet = Arc::new(sheet);
    {
        let mut entries = cache
            .lock()
            .map_err(|_| ApiError::internal("Workbook cache unavailable."))?;
        entries.retain(|entry| {
            !(entry.key.root == key.root
                && entry.key.path == key.path
                && entry.key.sheet == key.sheet)
        });
        while entries.len() >= 8
            || entries.iter().map(|entry| entry.sheet.bytes).sum::<usize>() + sheet.bytes
                > CACHE_BYTES
        {
            if entries.pop_front().is_none() {
                break;
            }
        }
        entries.push_back(Entry {
            key,
            sheet: sheet.clone(),
        });
    }
    render(&sheet, query, work)
}

pub(super) fn parse(bytes: &[u8], index: usize, work: &Work) -> Result<Option<Sheet>, ApiError> {
    let mut archive = validated_archive(bytes, work)?;
    let mut book = Xlsx::new(Cursor::new(bytes)).map_err(|_| invalid_xlsx())?;
    let names = book.sheet_names().to_vec();
    let name = names
        .get(index)
        .ok_or_else(|| ApiError::bad_request("Worksheet not found."))?;
    let mut source = Book::Stream(&mut book);
    let mut cells = Vec::new();
    let mut text_bytes = 0;
    let mut full = false;
    scan(&mut source, name, work, XLSX_ROWS - 1, |r, c, value| {
        if full {
            return Ok(());
        }
        text_bytes += match value {
            DataRef::String(s) | DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => s.capacity(),
            DataRef::SharedString(s) => s.len(),
            _ => 0,
        };
        if text_bytes + (cells.len() + 1) * std::mem::size_of::<Cell>() > SHEET_BYTES {
            cells.clear();
            full = true;
            return Ok(());
        }
        let value = match value {
            DataRef::SharedString(s) => DataRef::String(s.to_string()),
            DataRef::String(s) => DataRef::String(s.clone()),
            DataRef::Int(n) => DataRef::Int(*n),
            DataRef::Float(n) => DataRef::Float(*n),
            DataRef::Bool(b) => DataRef::Bool(*b),
            DataRef::DateTime(d) => DataRef::DateTime(*d),
            DataRef::DateTimeIso(s) => DataRef::DateTimeIso(s.clone()),
            DataRef::DurationIso(s) => DataRef::DurationIso(s.clone()),
            DataRef::Error(e) => DataRef::Error(e.clone()),
            DataRef::Empty => DataRef::Empty,
        };
        cells.push(Cell {
            row: r,
            col: c,
            value,
        });
        Ok(())
    })?;
    if full {
        return Ok(None);
    }
    let layout = dimensions::parse(&mut archive, index, None, None, work)?;
    let bytes = text_bytes + cells.capacity() * std::mem::size_of::<Cell>() + layout.bytes();
    if bytes > SHEET_BYTES {
        return Ok(None);
    }
    Ok(Some(Sheet {
        names,
        cells,
        layout,
        bytes,
    }))
}

pub(super) fn render(sheet: &Sheet, query: &Open, work: &Work) -> Result<Value, ApiError> {
    let (mut value, rows) =
        render_sheet(&mut Book::Cached(&sheet.cells), &sheet.names, query, work)?;
    if let Some(rows) = rows {
        value["layout"] = sheet
            .layout
            .page(&rows, query.col.unwrap_or(0).min(XLSX_COLS - 1));
    }
    Ok(value)
}
