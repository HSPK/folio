use linkify::{LinkFinder, LinkKind};
use pulldown_cmark::{Event, LinkType, Tag, TagEnd};
use std::ops::Range;

pub(super) fn events<'a>(
    events: impl Iterator<Item = (Event<'a>, Range<usize>)>,
) -> impl Iterator<Item = (Event<'a>, Range<usize>)> {
    let mut input = events.peekable();
    let events = std::iter::from_fn(move || {
        let (event, mut range) = input.next()?;
        if matches!(&event, Event::Text(_)) && matches!(input.peek(), Some((Event::Text(_), _))) {
            let Event::Text(text) = event else {
                unreachable!()
            };
            let mut text = text.into_string();
            while matches!(input.peek(), Some((Event::Text(_), _))) {
                let Some((Event::Text(next), next_range)) = input.next() else {
                    unreachable!()
                };
                text.push_str(&next);
                range.end = next_range.end;
            }
            Some((Event::Text(text.into()), range))
        } else {
            Some((event, range))
        }
    });
    let mut finder = LinkFinder::new();
    finder.url_must_have_scheme(false);
    let mut excluded = 0usize;
    events.flat_map(move |(event, range)| {
        match &event {
            Event::Start(Tag::Link { .. } | Tag::Image { .. } | Tag::CodeBlock(_)) => excluded += 1,
            Event::End(TagEnd::Link | TagEnd::Image | TagEnd::CodeBlock) => {
                excluded = excluded.saturating_sub(1)
            }

            _ => {}
        }
        let Event::Text(text) = &event else {
            return vec![(event, range)];
        };
        if excluded > 0 {
            return vec![(event, range)];
        }
        let mut output = Vec::new();
        let mut from = 0;
        let mut base = 0;
        for chunk in text.split_inclusive(['，', '。', '！', '？', '；', '、']) {
            for link in finder.links(chunk) {
                let raw = link.as_str();
                let end = raw
                    .find(['，', '。', '！', '？', '；', '、'])
                    .unwrap_or(raw.len());
                let value = &raw[..end];
                let lower = value.to_ascii_lowercase();
                let href = match link.kind() {
                    LinkKind::Email => format!("mailto:{value}"),
                    LinkKind::Url
                        if lower.starts_with("https://") || lower.starts_with("http://") =>
                    {
                        value.to_owned()
                    }
                    LinkKind::Url if lower.starts_with("www.") => format!("http://{value}"),
                    _ => continue,
                };
                let start = base + link.start();
                if from < start {
                    output.push((
                        Event::Text(text[from..start].to_owned().into()),
                        range.clone(),
                    ));
                }
                output.push((
                    Event::Start(Tag::Link {
                        link_type: LinkType::Autolink,
                        dest_url: href.into(),
                        title: "".into(),
                        id: "".into(),
                    }),
                    range.clone(),
                ));
                output.push((Event::Text(value.to_owned().into()), range.clone()));
                output.push((Event::End(TagEnd::Link), range.clone()));
                from = start + end;
            }
            base += chunk.len();
        }
        if output.is_empty() {
            return vec![(event, range)];
        }
        if from < text.len() {
            output.push((Event::Text(text[from..].to_owned().into()), range));
        }
        output
    })
}

#[cfg(test)]
mod tests {
    use super::super::render;

    #[test]
    fn bare_links_are_readable_and_code_and_existing_targets_are_preserved() {
        let html = render(
            "Note.md",
            "https://example.com/a_(b), www.example.org person@example.com.\n\n\
            `https://code.example`\n\n```text\nwww.code.example\n```\n\n\
            [chosen](https://kept.example)\n",
        );
        assert!(
            html.contains("href=\"https://example.com/a_(b)\""),
            "{html}"
        );
        assert!(html.contains("href=\"http://www.example.org\""));
        assert!(html.contains("href=\"mailto:person@example.com\""));
        assert!(html.contains("href=\"https://kept.example\""));
        assert_eq!(html.matches("<a ").count(), 4);
        assert!(!html.contains("href=\"https://code.example\""));
        let chinese = render("Note.md", "访问 https://example.com，继续写作。");
        assert!(
            chinese.contains("href=\"https://example.com\">https://example.com</a>，继续写作。")
        );
    }

    #[test]
    fn source_markers_preserve_unicode_offsets_and_never_trust_raw_html() {
        let source = "---\ntitle: 😀\n---\n\n# Title\n\nParagraph.\n";
        let html = render("Note.md", source);
        let offset = source[..source.find("Paragraph.").unwrap()]
            .encode_utf16()
            .count();
        assert!(html.contains(&format!("data-source-offset=\"{offset}\"")));
        let html = render(
            "Note.md",
            "<span class=\"preview-source-anchor\" data-source-offset=\"0\" onclick=\"alert(1)\">raw</span>",
        );
        assert!(html.contains("&lt;span"));
        assert!(
            !html
                .contains("<span class=\"preview-source-anchor\" data-source-offset=\"0\" onclick")
        );
    }
}
