use std::{collections::BTreeMap, ops::Range};

pub(in crate::server) struct ImageHtml {
    pub src: String,
    pub alt: String,
    title: Option<String>,
    width: Option<String>,
    height: Option<String>,
    layout: &'static str,
    explicit_inline: bool,
    pub source_range: Range<usize>,
}

pub(in crate::server) fn escape_attribute(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '\'' => output.push_str("&#39;"),
            '\t' => output.push_str("&#9;"),
            '\n' => output.push_str("&#10;"),
            '\r' => output.push_str("&#13;"),
            other => output.push(other),
        }
    }
    output
}

fn decode(value: &str) -> Option<String> {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(position) = rest.find('&') {
        output.push_str(&rest[..position]);
        rest = &rest[position + 1..];
        let end = rest.find(';')?;
        output.push(match &rest[..end] {
            "amp" => '&',
            "quot" => '"',
            "lt" => '<',
            "gt" => '>',
            "#39" => '\'',
            "#9" => '\t',
            "#10" => '\n',
            "#13" => '\r',
            _ => return None,
        });
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    Some(output)
}

fn dimension(value: Option<&String>) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    let value = value.trim();
    if value.is_empty() || value == "auto" {
        return Some(None);
    }
    let percent = value.ends_with('%');
    let number = value
        .strip_suffix('%')
        .or_else(|| value.strip_suffix("px"))
        .unwrap_or(value);
    if number.is_empty()
        || number.len() > 5
        || number.starts_with('0')
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let number: u32 = number.parse().ok()?;
    if number == 0 || number > if percent { 100 } else { 16384 } {
        return None;
    }
    Some(Some(format!("{number}{}", if percent { "%" } else { "" })))
}

pub(in crate::server) fn parse(source: &str) -> Option<ImageHtml> {
    let text = source.trim();
    if !text.get(..4)?.eq_ignore_ascii_case("<img") {
        return None;
    }
    let attributes = text.strip_suffix('>')?.get(4..)?.trim_end();
    let attributes = attributes
        .strip_suffix('/')
        .unwrap_or(attributes)
        .trim_end();
    let leading = source.len() - source.trim_start().len() + 4;
    let mut values = BTreeMap::new();
    let mut source_range = None;
    let mut cursor = 0;
    while cursor < attributes.len() {
        let start = cursor;
        while attributes
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        if cursor == start {
            return None;
        }
        let start = cursor;
        while attributes
            .as_bytes()
            .get(cursor)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            cursor += 1;
        }
        let name = attributes[start..cursor].to_ascii_lowercase();
        if !matches!(
            name.as_str(),
            "src" | "alt" | "title" | "width" | "height" | "style"
        ) || values.contains_key(&name)
        {
            return None;
        }
        while attributes
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        if attributes.as_bytes().get(cursor) != Some(&b'=') {
            return None;
        }
        cursor += 1;
        while attributes
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        let quote = *attributes.as_bytes().get(cursor)?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        cursor += 1;
        let start = cursor;
        cursor += attributes[cursor..].find(char::from(quote))?;
        let value = decode(&attributes[start..cursor])?;
        if name == "src" {
            source_range = Some(leading + start..leading + cursor);
        }
        values.insert(name, value);
        cursor += 1;
    }
    let mut styles = BTreeMap::new();
    if let Some(style) = values.get("style") {
        for declaration in style.split(';').filter(|value| !value.trim().is_empty()) {
            let (name, value) = declaration.split_once(':')?;
            let name = name.trim().to_ascii_lowercase();
            if !matches!(
                name.as_str(),
                "width" | "height" | "display" | "margin-left" | "margin-right"
            ) || styles.insert(name, value.trim().to_owned()).is_some()
            {
                return None;
            }
        }
    }
    let explicit_inline = styles.get("display").map(String::as_str) == Some("inline");
    let layout = if explicit_inline {
        if styles.contains_key("margin-left") || styles.contains_key("margin-right") {
            return None;
        }
        "inline"
    } else if ["display", "margin-left", "margin-right"]
        .iter()
        .any(|name| styles.contains_key(*name))
    {
        if styles.get("display").map(String::as_str) != Some("block") {
            return None;
        }
        match (
            styles.get("margin-left").map(String::as_str),
            styles.get("margin-right").map(String::as_str),
        ) {
            (Some("0"), Some("auto")) => "left",
            (Some("auto"), Some("auto")) => "center",
            (Some("auto"), Some("0")) => "right",
            _ => return None,
        }
    } else {
        "inline"
    };
    let width = dimension(styles.get("width").or_else(|| values.get("width")))?;
    let height = dimension(styles.get("height").or_else(|| values.get("height")))?;
    for (name, expected) in [("width", &width), ("height", &height)] {
        if styles.contains_key(name)
            && values.contains_key(name)
            && &dimension(values.get(name))? != expected
        {
            return None;
        }
    }
    Some(ImageHtml {
        src: values.remove("src")?,
        alt: values.remove("alt").unwrap_or_default(),
        title: values.remove("title"),
        width,
        height,
        layout,
        explicit_inline,
        source_range: source_range?,
    })
}

pub(in crate::server) fn spans(source: &str) -> Vec<(Range<usize>, ImageHtml)> {
    let mut output = Vec::new();
    let lower = source.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(next) = source[cursor..].find('<') {
        let start = cursor + next;
        if source[start..].starts_with("<!--") {
            cursor = source[start + 4..]
                .find("-->")
                .map_or(source.len(), |end| start + 4 + end + 3);
            continue;
        }
        let mut quote = None;
        let mut end = start + 1;
        while let Some(byte) = source.as_bytes().get(end) {
            if let Some(expected) = quote {
                if *byte == expected {
                    quote = None;
                }
            } else if *byte == b'\'' || *byte == b'"' {
                quote = Some(*byte);
            } else if *byte == b'>' {
                break;
            }
            end += 1;
        }
        if end == source.len() {
            break;
        }
        cursor = end + 1;
        let raw = &source[start..cursor];
        if let Some(image) = parse(raw) {
            output.push((start..cursor, image));
            continue;
        }
        let name = raw[1..]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            .count();
        let name = raw[1..1 + name].to_ascii_lowercase();
        if !name.is_empty()
            && !matches!(
                name.as_str(),
                "img" | "br" | "hr" | "input" | "source" | "wbr"
            )
            && !raw.ends_with("/>")
        {
            cursor = lower[cursor..]
                .find(&format!("</{name}"))
                .and_then(|closing| {
                    source[cursor + closing..]
                        .find('>')
                        .map(|end| cursor + closing + end + 1)
                })
                .unwrap_or(source.len());
        }
    }
    output
}

impl ImageHtml {
    pub fn render(&self, destination: &str) -> String {
        let mut output = format!(
            "<img src=\"{}\" alt=\"{}\"",
            escape_attribute(destination),
            escape_attribute(&self.alt)
        );
        if let Some(title) = &self.title {
            output.push_str(&format!(" title=\"{}\"", escape_attribute(title)));
        }

        let mut styles = Vec::new();
        for (name, value) in [("width", &self.width), ("height", &self.height)] {
            if let Some(value) = value {
                styles.push(format!(
                    "{name}:{value}{}",
                    if value.ends_with('%') { "" } else { "px" }
                ));
            }
        }
        if self.explicit_inline {
            styles.push("display:inline".into());
        } else if self.layout != "inline" {
            styles.push("display:block".into());
            styles.push(format!(
                "margin-left:{}",
                if self.layout == "left" { "0" } else { "auto" }
            ));
            styles.push(format!(
                "margin-right:{}",
                if self.layout == "right" { "0" } else { "auto" }
            ));
        }
        if !styles.is_empty() {
            output.push_str(&format!(" style=\"{}\"", styles.join(";")));
        }
        output.push('>');
        output
    }
}
