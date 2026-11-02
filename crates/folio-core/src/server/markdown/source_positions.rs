use pulldown_cmark::{Event, Tag};
use std::ops::Range;

pub(super) fn events<'a>(
    source: &'a str,
    prefix: usize,
    events: impl Iterator<Item = (Event<'a>, Range<usize>)>,
) -> impl Iterator<Item = Event<'a>> {
    let mut previous = 0;
    let mut offset = prefix;
    events.flat_map(move |(event, range)| {
        let block = matches!(&event, Event::Start(Tag::Paragraph | Tag::Heading { .. }
            | Tag::CodeBlock(_) | Tag::Table(_) | Tag::Item));
        let marker = if block {
            offset += source[previous..range.start].encode_utf16().count();
            previous = range.start;
            Some(Event::Html(format!(
                "<span class=\"preview-source-anchor\" data-source-offset=\"{offset}\" aria-hidden=\"true\"></span>"
            ).into()))
        } else { None };
        match marker {
            Some(marker) if matches!(&event, Event::Start(Tag::Item)) => vec![event, marker],
            Some(marker) => vec![marker, event],
            None => vec![event],
        }
    })
}
