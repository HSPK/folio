use super::*;
use pulldown_cmark::Parser;

#[test]
fn sized_images_keep_adjacent_markdown_and_literal_image_code_intact() {
    let source = "<img src=\"first.png\" alt=\"First\" style=\"width:50%\"> and **bold** ![Second](second.png) `<img src=\"literal.png\">`\n";
    let output = render("note.md", source);
    assert!(output.contains("style=\"width:50%\""));
    assert!(output.contains("<strong>bold</strong>"));
    assert!(output.contains("src=\"/second.png\""));
    assert!(output.contains("<code>&lt;img src=\"literal.png\"&gt;</code>"));
    assert!(!output.contains("src=\"/literal.png\""));
    assert_eq!(
        referenced_assets("note.md", source),
        std::collections::BTreeSet::from(["first.png".into(), "second.png".into()])
    );
}

#[test]
fn markdown_features_and_heading_anchors_work() {
    let output = render(
        "readme.md",
        "\
# Hello world

# Hello world

## 你好 世界

| Name | Value |
| --- | --- |
| **bold** | ~~old~~ |

- [x] done
- [ ] todo

Reference[^one].

[^one]: footnote text
",
    );
    for expected in [
        "<h1 id=\"hello-world\">",
        "<h1 id=\"hello-world-2\">",
        "<h2 id=\"你好-世界\">",
        "<table>",
        "<strong>bold</strong>",
        "<del>old</del>",
        "type=\"checkbox\"",
        "checked",
        "footnote",
    ] {
        assert!(output.contains(expected), "missing {expected:?}: {output}");
    }
}

#[test]
fn raw_html_and_script_schemes_cannot_execute() {
    let output = render(
        "readme.md",
        "\
<script>alert('bad')</script>

<img src=x onerror=alert(1)>

[run](javascript:alert%281%29)
[run](JaVaScRiPt:alert%281%29)
[run](vbscript:msgbox%281%29)
[run](data:text/html,evil)
[run](file:///C:/secret.txt)
[run](%6aavascript:alert%281%29)
![bad](data:image/svg+xml,evil)

`<script>not code</script>`
",
    );
    assert!(!output.contains("<script>"));
    assert!(!output.contains("<img "));
    for scheme in ["javascript:", "JaVaScRiPt:", "vbscript:", "data:", "file:"] {
        assert!(!output.contains(&format!("href=\"{scheme}")));
    }
    assert!(output.contains("&lt;script&gt;"));
    assert!(output.contains("&lt;img"));
}

#[test]
fn links_and_images_are_root_relative_and_encoded() {
    let output = render(
        "guides/nested/page.md",
        "\
[intro](../../介绍.md#你好-世界)
[same](#local)
[other](../overview.MARKDOWN#my-heading)
![image](../../images/a%20b.png)
[attachment](../../files/paper.pdf)
[site](https://example.com/path?q=1)
[email](mailto:person@example.com)
",
    );
    for expected in [
        "href=\"/%E4%BB%8B%E7%BB%8D.md#%E4%BD%A0%E5%A5%BD-%E4%B8%96%E7%95%8C\"",
        "href=\"#local\"",
        "href=\"/guides/overview.MARKDOWN#my-heading\"",
        "src=\"/images/a%20b.png\"",
        "href=\"/files/paper.pdf\"",
        "href=\"https://example.com/path?q=1\"",
        "href=\"mailto:person@example.com\"",
    ] {
        assert!(output.contains(expected), "missing {expected:?}: {output}");
    }
}

#[test]
fn sized_html_images_use_authorized_assets_and_keep_attachment_references() {
    let source = "<img src=\"../images/a%20b.png\" alt=\"A &amp; B\" style=\"width:50%;display:block;margin-left:auto;margin-right:auto\">";
    let output = render_with_urls("docs/note.md", source, |url, image| {
        assert!(image);
        assert_eq!(url, "/images/a%20b.png");
        Some("/assets?id=authorized".into())
    });
    assert!(output.contains("src=\"/assets?id=authorized\""));
    assert!(output.contains("alt=\"A &amp; B\""));
    assert!(
        output.contains("style=\"width:50%;display:block;margin-left:auto;margin-right:auto\"")
    );
    assert_eq!(
        resource_paths("docs/note.md", source),
        std::collections::BTreeMap::from([("images/a b.png".into(), true)])
    );
    assert_eq!(
        referenced_assets("docs/note.md", source),
        std::collections::BTreeSet::from(["images/a b.png".into()])
    );
    assert!(render("docs/note.md", &format!("# {source}")).contains("id=\"a-b\""));
}

#[test]
fn explicit_inline_images_keep_flow_and_authorized_attachment_urls() {
    let source =
        "<img src=\"../images/inline.png\" alt=\"Inline\" style=\"width:120px;display:inline\">";
    let output = render_with_urls("docs/note.md", source, |url, image| {
        assert!(image);
        assert_eq!(url, "/images/inline.png");
        Some("/assets?id=inline-authorized".into())
    });
    assert!(output.contains("src=\"/assets?id=inline-authorized\""));
    assert!(output.contains("style=\"width:120px;display:inline\""));
    assert_eq!(
        referenced_assets("docs/note.md", source),
        std::collections::BTreeSet::from(["images/inline.png".into()])
    );
    for style in [
        "display:inline;margin-left:auto",
        "display:flex",
        "display:inline;position:fixed",
    ] {
        let source = format!("<img src=\"local.png\" style=\"{style}\">");
        assert!(!render("note.md", &source).contains("<img "));
    }
}

#[test]
fn sized_html_images_cannot_enable_remote_requests_or_arbitrary_html() {
    for source in [
        "<img src=\"https://example.com/pixel.png\" alt=\"Remote\" style=\"width:50%\">",
        "<img src=\"data:image/svg+xml,bad\" style=\"width:50%\">",
        "<img src=\"javascript:alert(1)\" style=\"width:50%\">",
        "<img src=\"local.png\" onerror=\"alert(1)\" style=\"width:50%\">",
        "<img src=\"local.png\" style=\"width:50%;position:fixed\">",
        "<img src=\"local.png\" style=\"width:101%\">",
    ] {
        assert!(!render("note.md", source).contains("<img "), "{source}");
        assert!(resource_paths("note.md", source).is_empty(), "{source}");
    }
}

#[test]
fn heading_adapter_preserves_all_other_parser_events() {
    for source in [
        "> ## Quoted **heading**\n>\n> Body.\n\n- Item\n  ### Nested heading\n",
        "# ![image *caption*](img.png) [link](other.md) [^note]\n\n[^note]: Footnote body.\n",
        "Setext `code`\nwith a hard break  \nand more text\n=================\n\n# End\n",
        "# [[Other|Wiki alias]] &amp; <em>HTML</em>\n\n```md\n# Not a heading\n```\n",
        "| Cell | Value |\n| --- | --- |\n| # Text | Content |\n\n- [x] Done\n\n# Heading\n",
    ] {
        let options = Options::ENABLE_TABLES
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_WIKILINKS;
        let original: Vec<_> = Parser::new_ext(source, options)
            .into_offset_iter()
            .collect();
        let actual: Vec<_> = heading_events(original.clone().into_iter())
            .map(|(event, range)| {
                (
                    match event {
                        Event::Start(Tag::Heading {
                            level,
                            classes,
                            attrs,
                            ..
                        }) => Event::Start(Tag::Heading {
                            level,
                            id: None,
                            classes,
                            attrs,
                        }),
                        other => other,
                    },
                    range,
                )
            })
            .collect();
        assert_eq!(actual, original, "{source}");
    }
}

#[test]
fn streamed_headings_preserve_ids_inline_order_and_duplicate_collisions() {
    let output = render(
        "guide/note.md",
        "\
# Same
# Same-2
# Same
## **Bold** `code` [linked](Other.md) ![caption](image.png)
## <i>Literal</i> [unsafe](javascript:alert%281%29)

Title *across*
two lines
-------------
",
    );
    for expected in [
        "<h1 id=\"same\">Same</h1>",
        "<h1 id=\"same-2\">Same-2</h1>",
        "<h1 id=\"same-3\">Same</h1>",
        "<h2 id=\"bold-code-linked-caption\"><strong>Bold</strong> <code>code</code> <a href=\"/guide/Other.md\">linked</a> <img src=\"/guide/image.png\" alt=\"caption\" /></h2>",
        "<h2 id=\"literal-unsafe\">&lt;i&gt;Literal&lt;/i&gt; unsafe</h2>",
        "<h2 id=\"title-across-two-lines\">Title <em>across</em>\ntwo lines</h2>",
    ] {
        assert!(output.contains(expected), "missing {expected}: {output}");
    }
}

#[test]
fn heading_character_limit_keeps_full_body_and_unicode_anchor_compatibility() {
    let text = "中".repeat(159);
    let output = render("note.md", &format!("# {text} **文尾**\n\n# !!!\n# !!!\n"));
    assert!(output.contains(&format!("id=\"{text}\"")));
    assert!(output.contains("<strong>文尾</strong>"));
    assert!(output.contains("id=\"section\""));
    assert!(output.contains("id=\"section-2\""));
    let events = [
        Event::Start(Tag::Heading {
            level: pulldown_cmark::HeadingLevel::H2,
            id: None,
            classes: vec![],
            attrs: vec![],
        }),
        Event::Text("中".repeat(60).into()),
        Event::SoftBreak,
        Event::Text("Tail".into()),
        Event::End(TagEnd::Heading(pulldown_cmark::HeadingLevel::H2)),
    ];
    let streamed: Vec<_> = heading_events(events.clone().into_iter().map(|event| (event, 0..0)))
        .map(|(event, _)| event)
        .collect();
    assert_eq!(&streamed[1..], &events[1..]);
    assert!(
        matches!(&streamed[0], Event::Start(Tag::Heading { id: Some(id), .. })
        if id.as_ref() == format!("{}tail", "中".repeat(60)))
    );
}

#[test]
#[ignore = "performance benchmark"]
fn benchmark_markdown_render_pipeline() {
    let samples = [
        (
            "mixed",
            "## Measurement\n\nA paragraph with **formatted text**, [a local link](Other.md), and `inline code`.\n\n".repeat(2700),
        ),
        (
            "unicode-headings",
            format!("# {} `code`\n\nParagraph.\n\n", "中文".repeat(100)).repeat(1500),
        ),
    ];
    for (name, source) in samples {
        let expected = render("Bench.md", &source);
        let mut timings = Vec::new();
        for _ in 0..9 {
            let start = std::time::Instant::now();
            for _ in 0..4 {
                let actual = render(
                    std::hint::black_box("Bench.md"),
                    std::hint::black_box(&source),
                );
                assert_eq!(actual, expected);
                std::hint::black_box(actual);
            }
            timings.push(start.elapsed().as_secs_f64() * 1000.0 / 4.0);
        }
        timings.sort_by(f64::total_cmp);
        println!(
            "{{\"case\":\"{name}\",\"bytes\":{},\"medianMs\":{:.3},\"maxMs\":{:.3}}}",
            source.len(),
            timings[4],
            timings[8]
        );
    }
}
