use std::{
    collections::HashMap,
    ffi::OsStr,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::server::state_store::resources::{Resource, ResourceKind};
use serde::Serialize;

use super::{
    ApiError, Root, frontmatter, ignored_directory, is_markdown, platform, validate_document_path,
    validate_relative,
};

pub(super) struct CachedTitle {
    pub(super) fingerprint: platform::EntryFingerprint,
    pub(super) title: Option<Arc<str>>,
}

pub(super) struct CachedIdentities {
    revision: u64,
    entries: Arc<[Resource]>,
}

impl Root {
    pub(super) fn title_for(
        &self,
        path: &str,
        directory: &platform::Directory,
        name: &OsStr,
        fingerprint: platform::EntryFingerprint,
    ) -> Option<Arc<str>> {
        if let Ok(cache) = self.title_cache.read() {
            if let Some(title) = cached_title(&cache, path, fingerprint) {
                return title;
            }
        }
        let title = read_title(directory, name);
        if let Ok(mut cache) = self.title_cache.write() {
            cache.insert(
                path.into(),
                CachedTitle {
                    fingerprint,
                    title: title.clone(),
                },
            );
        }
        title
    }

    pub(in crate::server) fn tree(&self) -> Result<Tree, ApiError> {
        self.tree_with_limits(TreeLimits::default())
    }

    pub(super) fn tree_with_limits(&self, limits: TreeLimits) -> Result<Tree, ApiError> {
        let mut tree = scan(self, limits)?;
        if let Some(store) = self
            .resources
            .get()
            .filter(|_| !tree.files.is_empty() || !tree.directories.is_empty())
        {
            let paths = || {
                tree.files
                    .iter()
                    .map(|file| (file.path.as_str(), ResourceKind::Document))
                    .chain(
                        tree.directories
                            .iter()
                            .map(|folder| (folder.path.as_str(), ResourceKind::Directory)),
                    )
            };
            // The scan and access filter stay live. Only reuse stable ids for the exact paths
            // and DB epoch; delete/recreate at the same path must not resurrect the old id.
            let revision = store.identity_revision()?;
            let cached = self.tree_identities.read().ok().and_then(|cache| {
                let c = cache.as_ref()?;
                (c.revision == revision
                    && c.entries.len() == tree.files.len() + tree.directories.len()
                    && paths()
                        .zip(c.entries.iter())
                        .all(|((p, k), r)| p == r.path && k == r.kind))
                .then(|| c.entries.clone())
            });
            let resources = match cached {
                Some(entries) => entries,
                None => {
                    let entries = paths().map(|(p, k)| (p.to_owned(), k)).collect::<Vec<_>>();
                    let entries: Arc<[Resource]> = store.identify_many(&entries)?.into();
                    if let Ok(mut cache) = self.tree_identities.write() {
                        *cache = Some(CachedIdentities {
                            revision,
                            entries: entries.clone(),
                        });
                    }
                    entries
                }
            };
            for (file, resource) in tree.files.iter_mut().zip(resources.iter()) {
                file.id = Some(resource.id.clone());
                file.code = resource.code.clone();
            }
            for (folder, resource) in tree
                .directories
                .iter_mut()
                .zip(&resources[tree.files.len()..])
            {
                folder.id = Some(resource.id.clone());
            }
        }
        Ok(tree)
    }
}

struct TitleUpdate {
    path: String,
    expected: Option<platform::EntryFingerprint>,
    next: CachedTitle,
}

#[derive(Debug, Serialize)]
pub(in crate::server) struct Tree {
    pub(in crate::server) root: String,
    pub(in crate::server) files: Vec<TreeFile>,
    #[serde(rename = "panelFiles", skip_serializing_if = "Vec::is_empty")]
    pub(in crate::server) panel_files: Vec<String>,
    pub(in crate::server) directories: Vec<TreeDirectory>,
    pub(in crate::server) truncated: bool,
}

#[derive(Debug, Serialize)]
pub(in crate::server) struct TreeFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) id: Option<String>,
    pub(in crate::server) path: String,
    pub(in crate::server) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) title: Option<Arc<str>>,
}

#[derive(Debug, Serialize)]
pub(in crate::server) struct TreeDirectory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) id: Option<String>,
    pub(in crate::server) path: String,
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) title: Option<Arc<str>>,
}

#[derive(Clone, Copy)]
pub(super) struct TreeLimits {
    pub(super) entries: usize,
    pub(super) files: usize,
    pub(super) depth: usize,
    pub(super) duration: Duration,
}

impl Default for TreeLimits {
    fn default() -> Self {
        Self {
            entries: 20_000,
            files: 5_000,
            depth: 32,
            duration: Duration::from_secs(2),
        }
    }
}

pub(super) fn scan(root: &Root, limits: TreeLimits) -> Result<Tree, ApiError> {
    let (mut files, mut directories, mut panel_files, truncated, title_updates) = {
        let title_cache = root.title_cache.read().ok();
        let mut walk = TreeWalk {
            title_cache: title_cache.as_deref(),
            title_updates: Vec::new(),
            files: Vec::new(),
            panel_files: Vec::new(),
            directories: Vec::new(),
            scanned: 0,
            truncated: false,
            exhausted: false,
            started: Instant::now(),
            limits,
        };
        walk.directory(&root.directory, "", 0)?;
        (
            walk.files,
            walk.directories,
            walk.panel_files,
            walk.truncated,
            walk.title_updates,
        )
    };
    if !title_updates.is_empty() {
        if let Ok(mut cache) = root.title_cache.write() {
            for update in title_updates {
                let current = cache.get(&update.path).map(|cached| cached.fingerprint);
                if current == update.expected {
                    cache.insert(update.path, update.next);
                }
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    panel_files.sort();
    directories.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(Tree {
        root: root.path.to_string_lossy().into_owned(),
        files,
        panel_files,
        directories,
        truncated,
    })
}

struct TreeWalk<'a> {
    title_cache: Option<&'a HashMap<String, CachedTitle>>,
    title_updates: Vec<TitleUpdate>,
    files: Vec<TreeFile>,
    panel_files: Vec<String>,
    directories: Vec<TreeDirectory>,
    scanned: usize,
    truncated: bool,
    exhausted: bool,
    started: Instant,
    limits: TreeLimits,
}

impl TreeWalk<'_> {
    fn directory(
        &mut self,
        directory: &platform::Directory,
        relative: &str,
        depth: usize,
    ) -> Result<Option<Arc<str>>, ApiError> {
        let mut directory_title = None;
        let entries = directory
            .entries()
            .map_err(|error| ApiError::io("Could not enumerate a Markdown folder", error))?;
        for entry in entries {
            if self.exhausted {
                break;
            }
            if self.scanned >= self.limits.entries || self.started.elapsed() >= self.limits.duration
            {
                self.truncated = true;
                self.exhausted = true;
                break;
            }
            self.scanned += 1;
            let entry =
                entry.map_err(|error| ApiError::io("Could not read a folder entry", error))?;
            let metadata = directory
                .metadata(&entry)
                .map_err(|error| ApiError::io("Could not inspect a folder entry", error))?;
            if metadata.is_link() || metadata.is_hidden() {
                continue;
            }
            let name = entry.into_string().map_err(|_| {
                ApiError::bad_request("A folder entry has a non-Unicode file name.")
            })?;
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            if metadata.is_dir() {
                if ignored_directory(&name) {
                    continue;
                }
                if depth >= self.limits.depth {
                    self.truncated = true;
                    continue;
                }
                validate_relative(&format!("{path}/document.md"))?;
                let child = directory.open_child(name.as_ref(), true)?;
                let title = self.directory(&child, &path, depth + 1)?;
                self.directories.push(TreeDirectory {
                    id: None,
                    path,
                    name,
                    title,
                });
            } else if metadata.is_file() && is_markdown(&name) {
                validate_document_path(&path)?;
                if self.files.len() >= self.limits.files {
                    self.truncated = true;
                    self.exhausted = true;
                    break;
                }
                let fingerprint = metadata.fingerprint();
                let title = self
                    .title_cache
                    .and_then(|cache| cached_title(cache, &path, fingerprint))
                    .unwrap_or_else(|| {
                        let title = read_title(directory, name.as_ref());
                        self.title_updates.push(TitleUpdate {
                            expected: self
                                .title_cache
                                .and_then(|cache| cache.get(&path))
                                .map(|cached| cached.fingerprint),
                            path: path.clone(),
                            next: CachedTitle {
                                fingerprint,
                                title: title.clone(),
                            },
                        });
                        title
                    });
                if name.eq_ignore_ascii_case("index.md") {
                    directory_title.clone_from(&title);
                }
                self.files.push(TreeFile {
                    code: None,
                    id: None,
                    path,
                    name,
                    title,
                });
            } else if metadata.is_file()
                && super::panels::kind(&path).is_some()
                && validate_relative(&path).is_ok()
            {
                if self.panel_files.len() < self.limits.files {
                    self.panel_files.push(path);
                } else {
                    self.truncated = true;
                }
            }
        }
        Ok(directory_title)
    }
}

pub(super) fn cached_title(
    cache: &HashMap<String, CachedTitle>,
    path: &str,
    fingerprint: platform::EntryFingerprint,
) -> Option<Option<Arc<str>>> {
    cache
        .get(path)
        .filter(|cached| cached.fingerprint == fingerprint)
        .map(|cached| cached.title.clone())
}

pub(super) fn read_title(directory: &platform::Directory, name: &OsStr) -> Option<Arc<str>> {
    let file = directory.open_regular(name).ok()?;
    frontmatter::title_from_reader(file)
        .ok()
        .flatten()
        .map(Arc::from)
}
