use std::path::{Path, PathBuf};

use super::{ApiError, Catalog, Registry, Sharing, Summary, files, validate_name};
use crate::auth::{AuthenticatedUser, Role};

pub(super) struct SettingsUpdate {
    pub name: Option<String>,
    pub path: Option<String>,
    pub shared: Option<Sharing>,
    pub image_directory: Option<String>,
    pub root: Option<String>,
}

impl Catalog {
    pub(super) fn check_root(&self, except: Option<&str>, root: &Path) -> Result<(), ApiError> {
        if self.projects.iter().any(|(id, project)| {
            except != Some(id.as_str())
                && (project.root.starts_with(root) || root.starts_with(&project.root))
        }) {
            return Err(ApiError::conflict(
                "This directory overlaps an existing project.",
            ));
        }
        Ok(())
    }
}

impl Registry {
    pub(super) fn folder_root(&self, path: &Path) -> Result<PathBuf, ApiError> {
        if !path.is_absolute() {
            return Err(ApiError::bad_request(
                "Choose an absolute server directory path.",
            ));
        }
        let root = files::Root::open(path)?.path().to_owned();
        if self.protected.starts_with(&root) || root.starts_with(&self.protected) {
            return Err(ApiError::forbidden(
                "The Folio account and project storage cannot be attached.",
            ));
        }
        Ok(root)
    }

    pub(super) fn manage(
        &self,
        id: &str,
        user: &AuthenticatedUser,
        update: SettingsUpdate,
    ) -> Result<Summary, ApiError> {
        if update.path.is_some() && update.shared.is_none() {
            return Err(ApiError::bad_request(
                "Choose explicit sharing permissions for a document.",
            ));
        }
        let (identity, catalog) = self.catalog_for(user)?;
        let current = catalog
            .projects
            .get(id)
            .filter(|project| project.owned(&identity))
            .ok_or_else(|| {
                ApiError::forbidden("Only the project owner can change its settings.")
            })?;
        let root = update
            .root
            .as_deref()
            .map(|root| {
                if update.path.is_some() {
                    return Err(ApiError::bad_request(
                        "Change the folder from project settings, not document permissions.",
                    ));
                }
                if user.role != Role::Admin {
                    return Err(ApiError::forbidden(
                        "Only administrators can change server folders.",
                    ));
                }
                let path = Path::new(root.trim());
                if path == current.root {
                    Ok(current.root.clone())
                } else {
                    self.folder_root(path)
                }
            })
            .transpose()?;
        let changed = root.as_ref().is_some_and(|root| root != &current.root);
        let mut libraries = changed
            .then(|| {
                self.libraries
                    .lock()
                    .map_err(|_| ApiError::internal("Projects are unavailable."))
            })
            .transpose()?;
        let library = libraries
            .as_ref()
            .and_then(|libraries| libraries.get(id))
            .cloned();
        let _save = library
            .as_ref()
            .map(|library| {
                library
                    .saves
                    .lock()
                    .map_err(|_| ApiError::internal("The document save lock was poisoned."))
            })
            .transpose()?;
        let apply = || {
            self.mutate(|catalog| {
                if let Some(root) = &root {
                    catalog.check_root(Some(id), root)?;
                }
                let project = catalog
                    .projects
                    .get_mut(id)
                    .filter(|project| project.owned(&identity))
                    .ok_or_else(|| {
                        ApiError::forbidden("Only the project owner can change its settings.")
                    })?;
                if project.root != current.root {
                    return Err(ApiError::conflict(
                        "The project folder changed. Reopen its settings before saving.",
                    ));
                }
                if let Some(path) = update.path {
                    let root = files::Root::open(&project.root)?;
                    let path = root.canonical_document_path(&path)?;
                    let doc = root.document(&path)?;
                    if project.pages.len() >= 5000 && !project.pages.contains_key(&path) {
                        return Err(ApiError::conflict(
                            "The document permission limit was reached.",
                        ));
                    }
                    let referenced =
                        crate::server::markdown::referenced_assets(&path, &doc.content);
                    project.attachments.insert(path.clone(), referenced);
                    project.public_links.remove(&path);
                    let shared = update.shared.ok_or_else(|| {
                        ApiError::bad_request("Choose explicit sharing permissions for a document.")
                    })?;
                    project.pages.insert(path, shared);
                } else {
                    if let Some(name) = update.name {
                        project.name = validate_name(name)?;
                    }
                    if let Some(shared) = update.shared {
                        project.shared = shared;
                    }
                    if let Some(directory) = update.image_directory {
                        files::validate_relative(&directory)?;
                        project.image_directory = directory;
                    }
                    if let Some(root) = root.filter(|_| changed) {
                        project.root = root;
                    }
                }
                self.summarize(project, id, &identity)
            })
        };
        let summary = match &library {
            Some(library) => library.collaboration.relocate(apply)?,
            None => apply()?,
        };
        if let Some(libraries) = &mut libraries {
            libraries.remove(id);
        }
        Ok(summary)
    }
}
