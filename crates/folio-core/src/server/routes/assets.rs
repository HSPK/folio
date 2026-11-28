use super::*;

#[derive(Clone)]
pub(in crate::server) struct StartPagePolicy(pub HeaderValue);

fn startup_element(
    src: &'static str,
    slot: &'static std::sync::OnceLock<(String, String)>,
    attr: &str,
    policy: &HeaderValue,
) -> (String, Option<StartPagePolicy>) {
    let (script, hash) = slot.get_or_init(|| {
        let script = format!(
            "{}\n{src}",
            include_str!("../../../../../web/public/startup.js")
        )
        .replace("\r\n", "\n");
        let hash = STANDARD.encode(Sha256::digest(script.as_bytes()));
        (script, hash)
    });
    let csp = format!(
        "{}; script-src-elem 'self' 'sha256-{hash}'",
        policy.to_str().unwrap().trim_end_matches(';')
    );
    (
        format!("<script{attr}>{script}</script>"),
        Some(StartPagePolicy(HeaderValue::from_str(&csp).unwrap())),
    )
}

pub(super) async fn index(
    State(state): State<Arc<AppState>>,
    user: Option<Extension<crate::auth::AuthenticatedUser>>,
    uri: axum::http::Uri,
) -> Response {
    let public = uri.path() == "/share" || uri.path().starts_with("/s/");
    let (start, policy) = if public {
        static SHARE: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
        startup_element(
            include_str!("../../../../../web/public/start-share.js"),
            &SHARE,
            "",
            &state.shared.content_policy,
        )
    } else if state.shared.user_auth.is_some() {
        // Account names are normalized ASCII. No cookie or document data is embedded.
        let reader = user
            .map(|Extension(user)| format!(" data-reader=\"{}\"", user.username))
            .unwrap_or_default();
        static START: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
        startup_element(
            include_str!("../../../../../web/public/start-session.js"),
            &START,
            &reader,
            &state.shared.content_policy,
        )
    } else {
        static PLAIN: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
        startup_element("", &PLAIN, "", &state.shared.content_policy)
    };
    let page = include_str!(concat!(env!("OUT_DIR"), "/index.html"))
        .replace(
            "__FOLIO_LAYOUT__",
            if public {
                "data-sidebar=\"closed\" data-share-page"
            } else {
                "data-sidebar=\"open\""
            },
        )
        .replace("__STYLE_NONCE__", &state.shared.style_nonce)
        .replace("<!--FOLIO_START_SESSION-->", &start);
    let mut response = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response();
    if let Some(policy) = policy {
        response.extensions_mut().insert(policy);
    }
    response
}

pub(super) fn not_modified(headers: &HeaderMap, tag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|v| v == "*" || v.trim_start_matches("W/") == tag.trim_start_matches("W/"))
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let mut wildcard = false;
    for entry in headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
    {
        let (coding, quality) = entry.split_once(';').unwrap_or((entry, "q=1"));
        let allowed = quality.trim().split_once('=').is_some_and(|(name, q)| {
            name.trim().eq_ignore_ascii_case("q")
                && q.trim().parse::<f32>().is_ok_and(|q| q > 0.0 && q <= 1.0)
        });
        if coding.trim().eq_ignore_ascii_case("gzip") {
            return allowed;
        }
        if coding.trim() == "*" {
            wildcard = allowed;
        }
    }
    wildcard
}

fn bundle(
    headers: HeaderMap,
    query: Option<&str>,
    mime: &'static str,
    plain: &'static [u8],
    gzip: &'static [u8],
    tag: &'static str,
) -> Response {
    let mut response = if not_modified(&headers, tag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else if accepts_gzip(&headers) {
        let mut response = embedded(mime, gzip);
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        response
    } else {
        embedded(mime, plain)
    };
    let headers = response.headers_mut();
    let version = tag
        .strip_prefix("W/\"")
        .and_then(|tag| tag.strip_suffix('"'));
    let versioned = version.is_some() && query.and_then(|q| q.strip_prefix("v=")) == version;
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if versioned {
            "private, max-age=31536000, immutable"
        } else {
            "private, no-cache"
        }),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    headers.insert(header::ETAG, HeaderValue::from_static(tag));
    response
}

macro_rules! web_bundle {
    ($handler:ident, $name:literal, $mime:literal) => {
        pub(super) async fn $handler(headers: HeaderMap, uri: axum::http::Uri) -> Response {
            bundle(
                headers,
                uri.query(),
                concat!($mime, "; charset=utf-8"),
                include_bytes!(concat!("../../../../../web/public/", $name)),
                include_bytes!(concat!(env!("OUT_DIR"), "/", $name, ".gz")),
                include_str!(concat!(env!("OUT_DIR"), "/", $name, ".etag")),
            )
        }
    };
}
web_bundle!(workspace_styles, "workspace.css", "text/css");
web_bundle!(workspace_model, "workspace-model.mjs", "text/javascript");
web_bundle!(app_script, "app.mjs", "text/javascript");
web_bundle!(input_latency_script, "input-latency.mjs", "text/javascript");
web_bundle!(model_script, "model.mjs", "text/javascript");
web_bundle!(styles, "styles.css", "text/css");
web_bundle!(editor_script, "editor.bundle.mjs", "text/javascript");
web_bundle!(formula_script, "formula.mjs", "text/javascript");
web_bundle!(code_syntax, "code-syntax.mjs", "text/javascript");
web_bundle!(editor_styles, "editor.bundle.css", "text/css");
web_bundle!(editor_helpers, "editor-helpers.mjs", "text/javascript");

pub(super) async fn math_font(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let bytes = include!(concat!(env!("OUT_DIR"), "/math_fonts.rs"));
    let mut response = embedded("font/woff2", bytes);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

pub(super) async fn editor_licenses() -> Response {
    embedded(
        "text/plain; charset=utf-8",
        include_bytes!("../../../../../web/public/THIRD-PARTY-LICENSES.txt"),
    )
}

pub(super) async fn app_icon() -> Response {
    embedded(
        "image/x-icon",
        include_bytes!("../../../../../Shared/Resources/Folio.ico"),
    )
}

pub(super) async fn vector_icon() -> Response {
    embedded(
        "image/svg+xml",
        include_bytes!("../../../../../Shared/Resources/FolioIcon.svg"),
    )
}

pub(super) fn embedded(content_type: &'static str, bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}
