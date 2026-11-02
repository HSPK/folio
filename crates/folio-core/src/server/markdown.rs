use std::collections::{HashMap, HashSet, VecDeque};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use pulldown_cmark::{CowStr, Event, LinkType, Options, Tag, TagEnd, html};

use super::{files, frontmatter};

#[path = "markdown/auto_links.rs"]
mod auto_links;
#[path = "markdown/image_html.rs"]
pub(super) mod image_html;
#[path = "markdown/image_source.rs"]
pub(super) mod image_source;
#[path = "markdown/source_positions.rs"]
mod source_positions;

#[cfg(test)]
#[path = "markdown/render_tests.rs"]
mod render_tests;

const URL_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_WIKILINKS
}

pub(super) fn resource_paths(
    path: &str,
    content: &str,
) -> std::collections::BTreeMap<String, bool> {
    let mut paths = std::collections::BTreeMap::new();
    let source = image_source::prepare(body_after_frontmatter(content), options());
    for event in source.events() {
        let (target, image, wiki) = match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            }) => (
                dest_url,
                false,
                matches!(link_type, LinkType::WikiLink { .. }),
            ),
            Event::Start(Tag::Image { dest_url, .. }) => (dest_url, true, false),
            Event::Html(text) | Event::InlineHtml(text) => {
                let Some(image) = image_html::parse(&text) else {
                    continue;
                };
                (image.src.into(), true, false)
            }
            _ => continue,
        };
        if let Some(target) = local_reference(path, &target, image, wiki) {
            paths
                .entry(target)
                .and_modify(|only_images| *only_images &= image)
                .or_insert(image);
        }
    }
    paths
}

pub(super) fn render(path: &str, content: &str) -> String {
    render_with_urls(path, content, |url, _| Some(url))
}

pub(super) fn render_with_urls(
    path: &str,
    content: &str,
    mut resolve: impl FnMut(String, bool) -> Option<String>,
) -> String {
    let prefix = content[..content.len() - body_after_frontmatter(content).len()]
        .encode_utf16()
        .count();
    let content = body_after_frontmatter(content);
    let options = options();
    let mut links = Vec::new();
    let mut images = Vec::new();
    let source = image_source::prepare(content, options);
    let events =
        heading_events(auto_links::events(source.offset_events())).filter_map(|(event, range)| {
            let block_html = matches!(&event, Event::Html(_));
            let event = match event {
                Event::Html(text) | Event::InlineHtml(text) => {
                    if let Some(image) = image_html::parse(&text) {
                        match rewrite_url(path, &image.src, true).and_then(|url| resolve(url, true))
                        {
                            Some(destination) => {
                                let markup = image.render(&destination);
                                Event::Html(
                                    if block_html {
                                        format!("<p>{markup}</p>\n")
                                    } else {
                                        markup
                                    }
                                    .into(),
                                )
                            }
                            None => Event::Text(image.alt.into()),
                        }
                    } else {
                        Event::Text(text)
                    }
                }
                Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                }) => {
                    let destination = if matches!(link_type, LinkType::WikiLink { .. }) {
                        wiki_destination(&dest_url)
                            .and_then(|target| rewrite_url(path, &target, false))
                    } else {
                        rewrite_url(path, &dest_url, false)
                    }
                    .and_then(|url| resolve(url, false));
                    links.push(destination.is_some());
                    let destination = destination?;
                    Event::Start(Tag::Link {
                        link_type,
                        dest_url: destination.into(),
                        title,
                        id,
                    })
                }
                Event::End(TagEnd::Link) => {
                    if !links.pop().unwrap_or(false) {
                        return None;
                    }
                    Event::End(TagEnd::Link)
                }
                Event::Start(Tag::Image {
                    link_type,
                    dest_url,
                    title,
                    id,
                }) => {
                    let destination =
                        rewrite_url(path, &dest_url, true).and_then(|url| resolve(url, true));
                    images.push(destination.is_some());
                    let destination = destination?;
                    Event::Start(Tag::Image {
                        link_type,
                        dest_url: destination.into(),
                        title,
                        id,
                    })
                }
                Event::End(TagEnd::Image) => {
                    if !images.pop().unwrap_or(false) {
                        return None;
                    }
                    Event::End(TagEnd::Image)
                }
                other => other,
            };
            Some((event, range))
        });
    let mut output = String::with_capacity(content.len());
    html::push_html(
        &mut output,
        source_positions::events(content, prefix, events),
    );
    output
}

fn body_after_frontmatter(content: &str) -> &str {
    frontmatter::body(content)
}

fn heading_events<'a>(
    mut events: impl Iterator<Item = (Event<'a>, std::ops::Range<usize>)>,
) -> impl Iterator<Item = (Event<'a>, std::ops::Range<usize>)> {
    let mut pending = VecDeque::new();
    let mut counts = HashMap::<String, usize>::new();
    let mut used = HashSet::new();
    std::iter::from_fn(move || {
        if let Some(event) = pending.pop_front() {
            return Some(event);
        }
        let (event, range) = events.next()?;
        let Event::Start(Tag::Heading { level, .. }) = event else {
            return Some((event, range));
        };
        // Only the current heading is buffered: its ID precedes its inline text in HTML.
        let mut heading = String::new();
        let mut characters = 0;
        for (event, position) in events.by_ref() {
            let end = matches!(event, Event::End(TagEnd::Heading(_)));
            match &event {
                Event::Text(text) | Event::Code(text) => {
                    for character in text.chars().take(160 - characters) {
                        heading.push(character);
                        characters += 1;
                    }
                }
                Event::SoftBreak | Event::HardBreak => {
                    if heading.len() < 160 {
                        heading.push(' ');
                        characters += 1;
                    }
                }
                Event::Html(text) | Event::InlineHtml(text) => {
                    if let Some(image) = image_html::parse(text) {
                        for character in image.alt.chars().take(160 - characters) {
                            heading.push(character);
                            characters += 1;
                        }
                    }
                }
                _ => {}
            }
            pending.push_back((event, position));
            if end {
                break;
            }
        }
        let slug = slug(&heading);
        let count = counts.entry(slug.clone()).or_default();
        let id = loop {
            *count += 1;
            let candidate = if *count == 1 {
                slug.clone()
            } else {
                format!("{slug}-{count}")
            };
            if used.insert(candidate.clone()) {
                break candidate;
            }
        };
        Some((
            Event::Start(Tag::Heading {
                level,
                id: Some(CowStr::from(id)),
                classes: Vec::new(),
                attrs: Vec::new(),
            }),
            range,
        ))
    })
}

fn slug(text: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for character in text.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() || character == '_' {
            if separator && !output.is_empty() {
                output.push('-');
            }
            separator = false;
            output.push(character);
        } else if character.is_whitespace() || character == '-' {
            separator = true;
        }
    }
    if output.is_empty() {
        "section".into()
    } else {
        output
    }
}

pub(super) fn rewrite_url(document: &str, destination: &str, image: bool) -> Option<String> {
    if destination.is_empty()
        || destination.trim() != destination
        || destination.chars().any(char::is_control)
    {
        return None;
    }
    if destination.starts_with('#') {
        return if image {
            None
        } else {
            Some(destination.to_owned())
        };
    }
    if destination.starts_with("//") || destination.starts_with("\\\\") {
        return None;
    }
    let first_part = destination.split(['/', '?', '#']).next().unwrap_or("");
    if let Some((scheme, _)) = first_part.split_once(':') {
        return match scheme.to_ascii_lowercase().as_str() {
            "https" | "http" if !image => Some(destination.to_owned()),
            "mailto" | "tel" if !image => Some(destination.to_owned()),
            _ => None,
        };
    }
    let (without_fragment, fragment) = match destination.split_once('#') {
        Some((path, fragment)) => (path, Some(fragment)),
        None => (destination, None),
    };
    let path = without_fragment.split('?').next().unwrap_or("");
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if decoded.contains(':') || decoded.chars().any(char::is_control) {
        return None;
    }
    let path = decoded.replace('\\', "/");
    if path.starts_with("//") {
        return None;
    }
    let mut components = if path.starts_with('/') {
        Vec::new()
    } else {
        document.split('/').collect::<Vec<_>>()
    };
    if !path.starts_with('/') {
        components.pop();
    }
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            name => components.push(name),
        }
    }
    let relative = components.join("/");
    files::validate_relative(&relative).ok()?;
    let mut target = format!(
        "/{}",
        relative
            .split('/')
            .map(encode)
            .collect::<Vec<_>>()
            .join("/")
    );
    if !image {
        if let Some(fragment) = fragment {
            let fragment = percent_decode_str(fragment).decode_utf8().ok()?;
            if !fragment.is_empty() {
                target.push('#');
                target.push_str(&encode(&fragment));
            }
        }
    }
    Some(target)
}

pub(super) fn wiki_destination(value: &str) -> Option<String> {
    if value.is_empty()
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '?' | '\\'))
    {
        return None;
    }
    let (path, fragment) = value
        .trim()
        .split_once('#')
        .map(|(path, fragment)| (path, Some(fragment)))
        .unwrap_or((value.trim(), None));
    let mut target = if path.is_empty() || files::is_markdown(path) {
        path.into()
    } else {
        format!("{path}.md")
    };
    if let Some(fragment) = fragment {
        target.push('#');
        if !fragment.is_empty() {
            target.push_str(&slug(&fragment.chars().take(160).collect::<String>()));
        }
    }
    Some(target)
}

pub(super) fn local_reference(
    document: &str,
    destination: &str,
    image: bool,
    wiki: bool,
) -> Option<String> {
    let target = if wiki && !image {
        wiki_destination(destination)?
    } else {
        destination.into()
    };
    let rewritten = rewrite_url(document, &target, image)?;
    if rewritten.starts_with('#') {
        return Some(document.into());
    }
    let path = rewritten.strip_prefix('/')?;
    percent_decode_str(path.split('#').next()?)
        .decode_utf8()
        .ok()
        .map(|path| path.into_owned())
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, URL_COMPONENT).to_string()
}

pub(super) fn referenced_assets(
    document: &str,
    content: &str,
) -> std::collections::BTreeSet<String> {
    let source = image_source::prepare(body_after_frontmatter(content), Options::all());
    source
        .events()
        .filter_map(|event| {
            let (url, image) = match event {
                Event::Start(Tag::Image { dest_url, .. }) => (dest_url, true),
                Event::Html(text) | Event::InlineHtml(text) => {
                    (image_html::parse(&text)?.src.into(), true)
                }
                Event::Start(Tag::Link {
                    dest_url,
                    link_type,
                    ..
                }) => {
                    let target = if matches!(link_type, LinkType::WikiLink { .. }) {
                        wiki_destination(&dest_url)?
                    } else {
                        dest_url.into_string()
                    };
                    let url = rewrite_url(document, &target, false)?;
                    let path = url.strip_prefix('/')?.split('#').next()?;
                    let path = percent_decode_str(path)
                        .decode_utf8()
                        .ok()
                        .map(|path| path.into_owned())?;
                    return (!files::is_markdown(&path)).then_some(path);
                }
                _ => return None,
            };
            let url = rewrite_url(document, &url, image)?;
            let path = url.strip_prefix('/')?.split('#').next()?;
            percent_decode_str(path)
                .decode_utf8()
                .ok()
                .map(|path| path.into_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mkdocs_yaml_header_is_not_a_body_heading_or_horizontal_rule() {
        let source = "---\n\
title: 'Metadata title'\n\
description: >-\n\
  A description\n\
  across lines.\n\
tags: [notes, writing]\n\
# Keep this comment\n\
custom:\n\
  enabled: true\n\
---\n\n\
# Actual heading\n\nA **formatted** paragraph.\n";
        let output = render("note.md", source);
        assert!(output.contains("<h1 id=\"actual-heading\">Actual heading</h1>"));
        assert!(output.contains("<strong>formatted</strong>"));
        for hidden in [
            "Metadata title",
            "description:",
            "tags:",
            "enabled:",
            "Keep this comment",
            "<hr",
            "<h2",
        ] {
            assert!(!output.contains(hidden), "leaked metadata: {output}");
        }
    }

    #[test]
    fn yaml_fence_boundaries_preserve_regular_markdown_and_support_line_endings() {
        for ending in ["\n", "\r\n", "\r"] {
            for closing in ["---", "...", "--- \t", "... \t"] {
                let source = format!(
                    "\u{feff}--- \t{ending}title: Example{ending}{closing}{ending}{ending}# Body{ending}"
                );
                assert_eq!(body_after_frontmatter(&source), format!("# Body{ending}"));
                assert!(render("note.md", &source).contains("<h1 id=\"body\">Body</h1>"));
            }
        }
        for source in [
            "# Heading\n\n---\n\nparagraph\n\n---\n",
            "Before\n\n---\ntitle: Not metadata\n---\n",
            "```yaml\n---\ntitle: Code example\n---\n```\n",
            "---\ntitle: No closing fence\n\n# Keep this body\n",
            " ---\ntitle: Indented opening\n---\n",
        ] {
            assert_eq!(body_after_frontmatter(source), source);
        }
        assert_eq!(
            body_after_frontmatter("---\n---\n# Empty header\n"),
            "# Empty header\n"
        );
        assert_eq!(body_after_frontmatter("---\ntitle: Only metadata\n..."), "");
        assert_eq!(
            body_after_frontmatter("---\ndescription: |\n  ---\n  ...\n---\n# Body"),
            "# Body"
        );
    }

    #[test]
    fn escaping_references_and_hidden_folders_are_not_linked() {
        for target in [
            "../../secret.md",
            "%2e%2e/%2e%2e/secret.md",
            "../.git/secret.md",
            "../node_modules/secret.md",
            "//evil.test/x",
            "C:%5csecret.md",
            "%252e%252e/secret.md",
        ] {
            let output = render("notes/page.md", &format!("[bad]({target})"));
            assert!(!output.contains("<a "), "linked {target:?}: {output}");
        }
        assert_eq!(
            rewrite_url("a/b.md", r"..\images\x.png", true),
            Some("/images/x.png".into())
        );
    }

    #[test]
    fn attributes_and_code_are_escaped() {
        let output = render(
            "readme.md",
            "[safe](https://example.test/ \"\\\" onmouseover=\\\"alert(1)\")\n\n```html\n<script>x</script>\n```",
        );
        assert!(!output.contains("<script>"));
        assert!(!output.contains("title=\"\" onmouseover="));
        assert!(output.contains("language-html"));
    }

    #[test]
    fn preview_does_not_load_remote_tracking_images() {
        let output = render(
            "readme.md",
            "![remote](https://example.test/pixel.png)\n\n[site](https://example.test/)",
        );
        assert!(!output.contains("<img"));
        assert!(output.contains("remote"));
        assert!(output.contains("href=\"https://example.test/\""));
    }
}
