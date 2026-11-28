use super::*;
use std::{
    fmt::Write as _,
    io::Write as _,
    time::{Duration, Instant},
};

// Exercise both passes through Calamine using an in-memory XLSX, not a
// materialized grid (which can't distinguish sparse rows or typed cells).
fn xlsx(rows: &str) -> Vec<u8> {
    xlsx_layout(rows, "")
}

fn xlsx_layout(rows: &str, layout: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let sheet = format!(
        r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{layout}<sheetData>{rows}</sheetData></worksheet>"#
    );
    for (path, xml) in [
        (
            "_rels/.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="w" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        ),
        (
            "xl/workbook.xml",
            r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="s"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/></Relationships>"#,
        ),
        ("xl/worksheets/data.xml", &sheet),
    ] {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn column_values_compose_with_other_filters_and_include_sparse_blanks() {
    let bytes = xlsx(
        r#"
        <row r="1"><c r="A1" t="str"><v>Group</v></c><c r="B1" t="str"><v>Count</v></c></row>
        <row r="2"><c r="A2" t="str"><v>North</v></c><c r="B2"><v>2</v></c></row>
        <row r="3"><c r="A3" t="str"><v>South</v></c><c r="B3"><v>2</v></c></row>
        <row r="4"><c r="A4" t="str"><v>North</v></c><c r="B4"><v>3</v></c></row>
        <row r="5"><c r="B5"><v>2</v></c></row>"#,
    );
    let filters =
        r#"[{"col":0,"values":["North"],"exclude":false},{"col":1,"values":["3"],"exclude":true}]"#;
    let encoded =
        percent_encoding::utf8_percent_encode(filters, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    let page = preview(&bytes, &format!("view=table&facetCol=0&filters={encoded}")).unwrap();
    assert_eq!(page["rowNumbers"], json!([2]));
    assert_eq!(page["values"], json!([["", 1], ["North", 1], ["South", 1]]));
    let values = preview(
        &bytes,
        &format!("view=values&facetCol=0&sortCol=1&row=100&filters={encoded}"),
    )
    .unwrap();
    assert_eq!(
        values,
        json!({"values":[["", 1], ["North", 1], ["South", 1]]})
    );
    let page = preview(
        &bytes,
        "view=table&filters=%5B%7B%22col%22%3A0%2C%22values%22%3A%5B%22%22%5D%7D%5D",
    )
    .unwrap();
    assert_eq!(page["rowNumbers"], json!([5]));
    assert_eq!(
        preview(&bytes, "view=table&filters=invalid")
            .unwrap_err()
            .status,
        400
    );
}

#[test]
fn all_32_column_filters_preserve_sparse_defaults_and_ignore_only_their_own_facet() {
    let bytes = xlsx(
        r#"<row r="1"><c r="A1" t="str"><v>First</v></c><c r="AF1" t="str"><v>Last</v></c></row>
        <row r="2"><c r="A2" t="str"><v>keep</v></c><c r="AF2" t="str"><v>yes</v></c></row>
        <row r="3"><c r="A3" t="str"><v>keep</v></c><c r="AF3" t="str"><v>no</v></c></row>
        <row r="4"><c r="AF4" t="str"><v>yes</v></c></row>
        <row r="5"><c r="A5" t="str"><v>keep</v></c><c r="B5"><v>1</v></c><c r="AF5" t="str"><v>yes</v></c></row>
        <row r="6"><c r="A6" t="str"><v>keep</v></c></row>"#,
    );
    let mut filters: Vec<_> = (0..32)
        .map(|col| json!({"col":col, "values":[""]}))
        .collect();
    filters[0]["values"] = json!(["keep"]);
    filters[31]["values"] = json!(["yes"]);
    let query = |filters: &[Value]| {
        percent_encoding::utf8_percent_encode(
            &serde_json::to_string(filters).unwrap(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string()
    };
    let page = preview(&bytes, &format!("view=table&filters={}", query(&filters))).unwrap();
    assert_eq!(page["rowNumbers"], json!([2]));
    let values = preview(
        &bytes,
        &format!("view=values&facetCol=31&filters={}", query(&filters)),
    )
    .unwrap();
    assert_eq!(values, json!({"values":[["",1],["no",1],["yes",1]]}));
    filters[31]["exclude"] = json!(true);
    let page = preview(&bytes, &format!("view=table&filters={}", query(&filters))).unwrap();
    assert_eq!(page["rowNumbers"], json!([3, 6]));
    filters[31]["col"] = json!(30);
    assert_eq!(
        preview(&bytes, &format!("view=table&filters={}", query(&filters)))
            .unwrap_err()
            .status,
        400
    );
    filters[31]["col"] = json!(31);
    filters.push(json!({"col":32,"values":[""]}));
    assert_eq!(
        preview(&bytes, &format!("view=table&filters={}", query(&filters)))
            .unwrap_err()
            .status,
        400
    );
}

#[test]
fn worksheet_dimensions_use_relationship_target_and_original_row_numbers() {
    let bytes = xlsx_layout(
        r#"<row r="1" ht="24"><c r="A1" t="str"><v>Header</v></c></row>
        <row r="2" ht="36"><c r="A2"><v>9</v></c></row>
        <row r="3" ht="18"><c r="A3"><v>1</v></c></row>"#,
        r#"<sheetFormatPr defaultColWidth="16" defaultRowHeight="15"/>
        <cols><col min="1" max="2" width="30"/><col min="3" max="3" width="0.5"/></cols>"#,
    );
    let page = preview(&bytes, "view=table&sortCol=0").unwrap();
    assert_eq!(page["rowNumbers"], json!([3, 2]));
    assert_eq!(
        page["layout"]["columnWidths"],
        json!([[0, 0, 215.0], [1, 1, 215.0], [2, 2, 24.0]])
    );
    assert_eq!(page["layout"]["rowHeights"], json!([[2, 48.0], [3, 24.0]]));
    assert_eq!(page["layout"]["defaultWidth"], 117.0);
    assert_eq!(page["layout"]["defaultHeight"], 20.0);
    assert_eq!(page["layout"]["headerHeight"], 32.0);
}

fn preview(bytes: &[u8], query: &str) -> Result<Value, ApiError> {
    let uri = format!("/api/panel-file?path=data.xlsx&{query}")
        .parse()
        .unwrap();
    let Query(query) = Query::<Open>::try_from_uri(&uri).unwrap();
    let work = Work {
        cancelled: false.into(),
        deadline: Instant::now() + Duration::from_secs(30),
        health: Arc::default(),
    };
    let cached = workbook(bytes, &query, &work)?;
    assert_eq!(cached, uncached_workbook(bytes, &query, &work)?);
    Ok(cached)
}

#[test]
fn filter_and_sort_precede_both_page_offsets() {
    let mut rows = String::from(
        r#"<row r="1"><c r="A1" t="str"><v>[É]</v></c><c r="AG1" t="str"><v>Item</v></c><c r="AI1" t="str"><v>Last</v></c></row>"#,
    );
    for r in 2..=225 {
        let label = if r % 2 == 0 {
            "some [é] suffix"
        } else {
            "É without brackets"
        };
        write!(rows, r#"<row r="{r}"><c r="A{r}" t="str"><v>{label}</v></c><c r="B{r}"><v>{}</v></c><c r="AG{r}"><v>{r}</v></c></row>"#, 226-r).unwrap();
    }
    let bytes = xlsx(&rows);
    let query = "view=table&filterCol=0&filter=%5B%C3%89%5D&sortCol=1&row=100&col=32";
    let page = preview(&bytes, query).unwrap();
    let expected: Vec<_> = (1..=12).rev().map(|n| n * 2).collect();
    assert_eq!(page["height"], 112);
    assert_eq!(page["width"], 35);
    assert_eq!(page["headers"], json!(["Item", "", "Last"]));
    assert_eq!(page["rowNumbers"], json!(expected));
    let cells: Vec<_> = expected
        .iter()
        .enumerate()
        .map(|(i, n)| (100 + i, 32, n.to_string()))
        .collect();
    assert_eq!(page["cells"], json!(cells));

    let no_sort = preview(&bytes, "view=table&filterCol=0&filter=%5B%C3%89%5D&row=100").unwrap();
    assert_eq!(no_sort["rowNumbers"][0], 202);
    let first = preview(&bytes, "view=table&sortCol=1").unwrap();
    assert_eq!(first["rowNumbers"][0], 225);
    assert_eq!(first["rowNumbers"][99], 126);
}

#[test]
fn typed_sort_keeps_ties_stable_and_blanks_last_on_sparse_sheet() {
    let bytes = xlsx(
        r#"
        <row r="1"><c r="A1" t="str"><v>Key</v></c></row>
        <row r="2"><c r="A2"><v>10</v></c></row>
        <row r="3"><c r="B3" t="str"><v>absent key</v></c></row>
        <row r="5"><c r="A5"><v>2</v></c></row>
        <row r="8"><c r="A8" t="str"><v>10</v></c></row>
        <row r="13"><c r="A13"><v>2.0</v></c></row>
        <row r="21"><c r="A21" t="str"><v></v></c><c r="B21"><v>1</v></c></row>
        <row r="30"><c r="A30"/></row>
        <row r="1048576"><c r="A1048576"><v>-0.5</v></c></row>"#,
    );
    let asc = preview(&bytes, "view=table&sortCol=0").unwrap();
    assert_eq!(asc["headers"], json!(["Key", ""]));
    assert_eq!(asc["height"], 7);
    assert_eq!(asc["rowNumbers"], json!([1048576, 5, 13, 2, 8, 3, 21]));
    assert_eq!(asc["cells"][0], json!([0, 0, "-0.5"]));
    let desc = preview(&bytes, "view=table&sortCol=0&desc=true").unwrap();
    assert_eq!(desc["rowNumbers"], json!([8, 2, 5, 13, 1048576, 3, 21]));
    let plain = preview(&bytes, "view=table&row=4").unwrap();
    assert_eq!(plain["rowNumbers"], json!([13, 21, 1048576]));
    assert_eq!(plain["cells"][0], json!([4, 0, "2"]));
    let raw = preview(&bytes, "row=1048575").unwrap();
    assert_eq!(
        raw,
        json!({"sheets":["Data"], "height":1048576, "width":2,
        "row":1048575, "col":0, "rows":100, "cols":32, "cells":[[1048575,0,"-0.5"]]})
    );
}

#[test]
fn missing_first_row_and_empty_result_preserve_columns() {
    let bytes = xlsx(r#"<row r="50"><c r="C50" t="str"><v>First data</v></c></row>"#);
    let plain = preview(&bytes, "view=table").unwrap();
    assert_eq!(plain["headers"], json!(["", "", ""]));
    assert_eq!(plain["rowNumbers"], json!([50]));
    assert_eq!(plain["cells"], json!([[0, 2, "First data"]]));
    let empty = preview(&bytes, "view=table&filterCol=1&filter=no").unwrap();
    assert_eq!(empty["height"], 0);
    assert_eq!(empty["rowNumbers"], json!([]));
    assert_eq!(empty["cells"], json!([]));
    assert_eq!(empty["headers"], plain["headers"]);
    for query in [
        "view=table&filter=text",
        "view=table&sortCol=16384",
        "view=unknown",
    ] {
        assert_eq!(preview(&bytes, query).unwrap_err().status, 400);
    }
}

#[test]
fn oversized_sort_and_combined_header_body_text_fail_clearly() {
    let text = "x".repeat(1 << 20);
    let rows: String = (1..=10)
        .map(|r| format!(r#"<row r="{r}"><c r="A{r}" t="str"><v>{text}</v></c></row>"#))
        .collect();
    let bytes = xlsx(&rows);
    let err = preview(&bytes, "view=table&sortCol=0&col=1").unwrap_err();
    assert_eq!(err.status, 413);
    assert!(err.message.contains("sort"));
    let values = preview(&bytes, "view=values&sortCol=0&facetCol=1&col=1").unwrap();
    assert_eq!(values, json!({"values":[["", 9]]}));
    let err = preview(&bytes, "view=table&row=7").unwrap_err();
    assert_eq!(err.status, 413);
    assert!(err.message.contains("preview limit"));
    let header = xlsx(&format!(
        r#"<row r="1"><c r="A1" t="str"><v>{text}{text}x</v></c></row>
        <row r="2"><c r="B2"><v>1</v></c></row>"#
    ));
    assert_eq!(
        preview(&header, "view=values&facetCol=1").unwrap(),
        json!({"values":[["1",1]]})
    );
}
