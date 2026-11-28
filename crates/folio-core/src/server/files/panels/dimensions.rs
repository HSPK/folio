use super::{ApiError, Work, invalid_xlsx};
use quick_xml::{Reader, events::Event};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
};

fn xml(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    path: &str,
    work: &Work,
    mut visit: impl FnMut(&[u8], BTreeMap<String, String>),
) -> Result<(), ApiError> {
    let mut bytes = Vec::new();
    zip.by_name(path)
        .map_err(|_| invalid_xlsx())?
        .take((48 << 20) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid_xlsx())?;
    if bytes.len() > 48 << 20 {
        return Err(super::too_large());
    }
    let mut reader = Reader::from_reader(bytes.as_slice());
    loop {
        work.check()?;
        match reader.read_event().map_err(|_| invalid_xlsx())? {
            Event::Start(e) | Event::Empty(e) => {
                let name = e.local_name();
                if !matches!(
                    name.as_ref(),
                    b"sheet" | b"Relationship" | b"sheetFormatPr" | b"col" | b"row"
                ) {
                    continue;
                }
                let attrs = e
                    .attributes()
                    .map(|a| {
                        let a = a.map_err(|_| invalid_xlsx())?;
                        Ok((
                            String::from_utf8_lossy(a.key.as_ref()).into_owned(),
                            a.decode_and_unescape_value(reader.decoder())
                                .map_err(|_| invalid_xlsx())?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_, ApiError>>()?;
                visit(name.as_ref(), attrs);
            }
            Event::Eof => break,
            _ => (),
        }
    }
    Ok(())
}

pub(super) struct Layout {
    widths: BTreeMap<u32, f64>,
    heights: BTreeMap<u32, f64>,
    default_width: Option<f64>,
    default_height: Option<f64>,
    header_height: Option<f64>,
}

impl Layout {
    pub(super) fn bytes(&self) -> usize {
        (self.widths.len() + self.heights.len()) * 64
    }
    pub(super) fn page(&self, rows: &[u32], col: u32) -> Value {
        let widths: Vec<_> = self
            .widths
            .range(col..col + super::COLS)
            .map(|(&c, &w)| (c, c, w))
            .collect();
        let heights: BTreeMap<_, _> = rows
            .iter()
            .filter_map(|r| self.heights.get(r).map(|h| (*r, *h)))
            .collect();
        json!({"columnWidths":widths, "rowHeights":heights.into_iter().collect::<Vec<_>>(),
            "defaultWidth":self.default_width, "defaultHeight":self.default_height, "headerHeight":self.header_height})
    }
}

pub(super) fn read(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    index: usize,
    rows: &[u32],
    col: u32,
    work: &Work,
) -> Result<Value, ApiError> {
    Ok(parse(zip, index, Some(rows), Some(col), work)?.page(rows, col))
}

pub(super) fn parse(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    index: usize,
    rows: Option<&[u32]>,
    col: Option<u32>,
    work: &Work,
) -> Result<Layout, ApiError> {
    let mut id = None;
    let mut count = 0;
    xml(zip, "xl/workbook.xml", work, |name, attrs| {
        if name == b"sheet" {
            if count == index {
                id = attrs.get("r:id").cloned();
            }
            count += 1;
        }
    })?;
    let mut target = None;
    xml(zip, "xl/_rels/workbook.xml.rels", work, |name, attrs| {
        if name == b"Relationship"
            && attrs.get("Id") == id.as_ref()
            && !attrs.get("TargetMode").is_some_and(|s| s == "External")
        {
            target = attrs.get("Target").cloned();
        }
    })?;
    let target = target.ok_or_else(invalid_xlsx)?;
    let mut parts = if target.starts_with('/') {
        vec![]
    } else {
        vec!["xl"]
    };
    for part in target.trim_start_matches('/').split('/') {
        match part {
            "." | "" => (),
            ".." => {
                parts.pop().ok_or_else(invalid_xlsx)?;
            }
            s => parts.push(s),
        }
    }
    let mut widths = BTreeMap::<u32, f64>::new();
    let mut heights = BTreeMap::<u32, f64>::new();
    let mut default_width = None;
    let mut default_height = None;
    let mut header_height = None;
    let number = |a: &BTreeMap<String, String>, k: &str| {
        a.get(k)?
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n > 0.0)
    };
    // OOXML column widths are character units (7px for the default font);
    // row heights are points. Keep the original dimensions, with bounded UI sizes.
    let column_px = |n: f64| {
        (if n < 1.0 { n * 12.0 } else { n * 7.0 + 5.0 })
            .round()
            .clamp(24.0, 1200.0)
    };
    let row_px = |n: f64| (n * 96.0 / 72.0).round().clamp(20.0, 480.0);
    xml(zip, &parts.join("/"), work, |name, a| match name {
        b"sheetFormatPr" => {
            default_width = number(&a, "defaultColWidth").map(column_px);
            default_height = number(&a, "defaultRowHeight").map(row_px);
        }
        b"col" => {
            if let (Some(min), Some(max), Some(w)) =
                (number(&a, "min"), number(&a, "max"), number(&a, "width"))
            {
                if min.fract() == 0.0
                    && max.fract() == 0.0
                    && min <= max
                    && max <= 16384.0
                    && max > col.unwrap_or(0) as f64
                    && min <= col.map_or(16384, |c| c + super::COLS) as f64
                {
                    for c in col.unwrap_or(0).max(min as u32 - 1)
                        ..col.map_or(16384, |c| c + super::COLS).min(max as u32)
                    {
                        widths.insert(c, column_px(w));
                    }
                }
            }
        }
        b"row" => {
            if let (Some(r), Some(h)) = (number(&a, "r"), number(&a, "ht")) {
                if r.fract() == 0.0 && r <= 1048576.0 {
                    if r == 1.0 {
                        header_height = Some(row_px(h));
                    }
                    if rows.is_none_or(|rows| rows.contains(&(r as u32))) {
                        heights.insert(r as u32, row_px(h));
                    }
                }
            }
        }
        _ => (),
    })?;
    Ok(Layout {
        widths,
        heights,
        default_width,
        default_height,
        header_height,
    })
}
