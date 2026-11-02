use super::image_html;
use pulldown_cmark::{CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    ops::Range,
};

struct Entry {
    raw: String,
    source: Range<usize>,
    processed: Range<usize>,
}

pub(in crate::server) struct ImageSource<'a> {
    source: Cow<'a, str>,
    options: Options,
    entries: Vec<Entry>,
    tokens: HashMap<String, usize>,
    prefix: String,
}

pub(in crate::server) fn image_spans(
    source: &str,
    options: Options,
) -> Vec<(Range<usize>, image_html::ImageHtml)> {
    if !source
        .as_bytes()
        .windows(4)
        .any(|part| part.eq_ignore_ascii_case(b"<img"))
    {
        return Vec::new();
    }
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        if !matches!(event, Event::Html(_) | Event::InlineHtml(_)) {
            continue;
        }
        if let Some(previous) = ranges.last_mut() {
            if previous.end <= range.start && source[previous.end..range.start].trim().is_empty() {
                previous.end = range.end;
                continue;
            }
        }
        ranges.push(range);
    }
    ranges
        .into_iter()
        .flat_map(|range| {
            image_html::spans(&source[range.clone()])
                .into_iter()
                .map(move |(span, image)| (range.start + span.start..range.start + span.end, image))
        })
        .collect()
}

pub(in crate::server) fn prepare(source: &str, options: Options) -> ImageSource<'_> {
    let spans = image_spans(source, options);
    let mut result = ImageSource {
        source: Cow::Borrowed(source),
        options,
        entries: Vec::new(),
        tokens: HashMap::new(),
        prefix: String::new(),
    };
    if spans.is_empty() {
        return result;
    }
    let occupied = source
        .match_indices("folio-image-")
        .filter_map(|(index, _)| {
            let tail = &source[index + "folio-image-".len()..];
            let end = tail.bytes().take_while(u8::is_ascii_digit).count();
            (tail.as_bytes().get(end) == Some(&b'-'))
                .then(|| tail[..end].parse::<usize>().ok())
                .flatten()
        })
        .collect::<HashSet<_>>();
    let mut seed = 0;
    while occupied.contains(&seed) {
        seed += 1;
    }
    result.prefix = format!("folio-image-{seed}-");
    let mut prepared = String::with_capacity(source.len());
    let mut end = 0;
    for (index, (range, _)) in spans.into_iter().enumerate() {
        prepared.push_str(&source[end..range.start]);
        let token = format!("{}{index}", result.prefix);
        let start = prepared.len();
        prepared.push_str(&format!("![]({token})"));
        result.tokens.insert(token, index);
        result.entries.push(Entry {
            raw: source[range.clone()].into(),
            source: range.clone(),
            processed: start..prepared.len(),
        });
        end = range.end;
    }
    prepared.push_str(&source[end..]);
    result.source = Cow::Owned(prepared);
    result
}

impl ImageSource<'_> {
    fn restore<'a>(&self, text: CowStr<'a>) -> CowStr<'a> {
        if self.entries.is_empty() || !text.contains(&self.prefix) {
            return text;
        }
        let marker = format!("![]({}", self.prefix);
        let mut output = String::with_capacity(text.len());
        let mut rest = text.as_ref();
        while let Some(start) = rest.find(&marker) {
            output.push_str(&rest[..start]);
            let tail = &rest[start + marker.len()..];
            let Some(end) = tail.find(')') else {
                output.push_str(&rest[start..]);
                rest = "";
                break;
            };
            if let Some(entry) = tail[..end]
                .parse::<usize>()
                .ok()
                .and_then(|index| self.entries.get(index))
            {
                output.push_str(&entry.raw);
            } else {
                output.push_str(&rest[start..start + marker.len() + end + 1]);
            }
            rest = &tail[end + 1..];
        }
        output.push_str(rest);
        output.into()
    }

    fn offset(&self, offset: usize, ending: bool) -> usize {
        let index = self
            .entries
            .partition_point(|entry| entry.processed.end <= offset);
        if let Some(entry) = self.entries.get(index) {
            if offset == entry.processed.start {
                return entry.source.start;
            }
            if offset > entry.processed.start {
                return if ending {
                    entry.source.end
                } else {
                    entry.source.start
                };
            }
        }
        if index == 0 {
            offset
        } else {
            let previous = &self.entries[index - 1];
            offset - previous.processed.end + previous.source.end
        }
    }

    pub(in crate::server) fn events(&self) -> impl Iterator<Item = Event<'_>> {
        self.offset_events().map(|(event, _)| event)
    }

    pub(in crate::server) fn offset_events(
        &self,
    ) -> impl Iterator<Item = (Event<'_>, Range<usize>)> {
        let mut parser = Parser::new_ext(&self.source, self.options).into_offset_iter();
        let mut skip_end = false;
        std::iter::from_fn(move || {
            loop {
                let (event, range) = parser.next()?;
                if skip_end && matches!(event, Event::End(TagEnd::Image)) {
                    skip_end = false;
                    continue;
                }
                let original = self.offset(range.start, false)..self.offset(range.end, true);
                return Some((
                    match event {
                        Event::Start(Tag::Image {
                            link_type,
                            dest_url,
                            title,
                            id,
                        }) => {
                            if let Some(index) = self.tokens.get(dest_url.as_ref()) {
                                skip_end = true;
                                Event::InlineHtml(self.entries[*index].raw.as_str().into())
                            } else {
                                Event::Start(Tag::Image {
                                    link_type,
                                    dest_url: self.restore(dest_url),
                                    title: self.restore(title),
                                    id,
                                })
                            }
                        }
                        Event::Start(Tag::Link {
                            link_type,
                            dest_url,
                            title,
                            id,
                        }) => Event::Start(Tag::Link {
                            link_type,
                            dest_url: self.restore(dest_url),
                            title: self.restore(title),
                            id,
                        }),
                        Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(self.restore(info))))
                        }
                        Event::Text(text) => Event::Text(self.restore(text)),
                        Event::Code(text) => Event::Code(self.restore(text)),
                        Event::Html(text) => Event::Html(self.restore(text)),
                        Event::InlineHtml(text) => Event::InlineHtml(self.restore(text)),
                        other => other,
                    },
                    original,
                ));
            }
        })
    }
}
