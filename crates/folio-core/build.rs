use flate2::{Compression, write::GzEncoder};
use sha2::{Digest, Sha256};
use std::{env, fs, io::Write, path::PathBuf};

fn main() {
    let public = PathBuf::from("../../web/public");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let index = public.join("index.html");
    println!("cargo:rerun-if-changed={}", index.display());
    let mut page = fs::read_to_string(index).unwrap();
    for name in [
        "app.mjs",
        "model.mjs",
        "workspace-model.mjs",
        "editor.bundle.mjs",
        "formula.mjs",
        "code-syntax.mjs",
        "input-latency.mjs",
        "editor-helpers.mjs",
        "editor.bundle.css",
        "workspace.css",
        "styles.css",
    ] {
        let path = public.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(path).unwrap();
        let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
        gzip.write_all(&bytes).unwrap();
        fs::write(out.join(format!("{name}.gz")), gzip.finish().unwrap()).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        fs::write(out.join(format!("{name}.etag")), format!("W/\"{hash}\"")).unwrap();
        page = page.replace(&format!("\"/{name}\""), &format!("\"/{name}?v={hash}\""));
    }
    fs::write(out.join("index.html"), page).unwrap();
    let fonts = public.join("math-fonts");
    println!("cargo:rerun-if-changed={}", fonts.display());
    let mut names = fs::read_dir(fonts)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    let mut table = String::from("match name.as_str() {\n");
    for name in names {
        assert!(
            name.ends_with(".woff2")
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        );
        table.push_str(&format!("{name:?} => include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/../../web/public/math-fonts/{name}\")).as_slice(),\n"));
    }
    table.push_str("_ => return StatusCode::NOT_FOUND.into_response(),\n}");
    fs::write(out.join("math_fonts.rs"), table).unwrap();
}
