use super::{
    ApiError, Root, StagedFile, check_version, read_limited, validate_document_path,
    validate_relative,
};
use crate::server::state_store::resources::{Resource, ResourceKind, validate_id};
use std::{collections::BTreeMap, ffi::OsStr, io};

const BIN: &str = ".folio-trash";

// Only this internal move can cross the hidden-directory boundary. Neither
// endpoint takes an API-supplied filesystem path or a user-chosen storage key.
pub(in crate::server) struct RecycleMove {
    visible: super::Resolved,
    bin: super::platform::Directory,
    pub(in crate::server) resource: Resource,
}

#[derive(Default, PartialEq)]
pub(in crate::server) struct Inventory {
    pub entries: BTreeMap<String, ResourceKind>,
    pub size: u64,
}

impl Root {
    pub(in crate::server) fn recycle_move(
        &self,
        resource: &Resource,
        restoring: bool,
    ) -> Result<RecycleMove, ApiError> {
        validate_id(&resource.id)?;
        match resource.kind {
            ResourceKind::Directory => super::validate_directory_path(&resource.path)?,
            ResourceKind::Document => validate_document_path(&resource.path)?,
            ResourceKind::Asset => {
                if super::panels::kind(&resource.path).is_none() {
                    return Err(ApiError::bad_request(
                        "Use attachment cleanup for individual assets.",
                    ));
                }
            }
        }
        let visible = self.resolve(&resource.path)?;
        if !restoring {
            match self.directory.create_private_dir(BIN.as_ref()) {
                Ok(()) => self.directory.sync()?,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(ApiError::io("Could not create the recycle folder", e)),
            }
        }
        let bin = self.directory.open_child(BIN.as_ref(), false)?;
        let movement = RecycleMove {
            visible,
            bin,
            resource: resource.clone(),
        };
        movement.check_vacant(!restoring)?;
        Ok(movement)
    }
}

impl RecycleMove {
    fn endpoint(&self, hidden: bool) -> (&super::platform::Directory, &OsStr) {
        if hidden {
            (&self.bin, self.resource.id.as_ref())
        } else {
            (&self.visible.parent, &self.visible.name)
        }
    }

    fn check_vacant(&self, hidden: bool) -> Result<(), ApiError> {
        let (dir, name) = self.endpoint(hidden);
        match dir.metadata(name) {
            Ok(_) => Err(ApiError::conflict(
                "The destination already exists. Nothing was overwritten.",
            )),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(ApiError::io("Could not check the recycle destination", e)),
        }
    }

    pub(in crate::server) fn rename(&self, to_bin: bool) -> Result<(), ApiError> {
        let (from, source) = self.endpoint(!to_bin);
        let (to, destination) = self.endpoint(to_bin);
        from.move_entry_to(source, to, destination)
            .map_err(|e| ApiError::io("Could not move the recycled entry", e))
    }

    pub(in crate::server) fn sync(&self) -> Result<(), ApiError> {
        self.bin.sync()?;
        self.visible.parent.sync()
    }

    pub(in crate::server) fn inspect(
        &self,
        hidden: bool,
        check: &impl Fn() -> Result<(), ApiError>,
    ) -> Result<Inventory, ApiError> {
        let (dir, name) = self.endpoint(hidden);
        let mut inventory = Inventory::default();
        inventory.visit(dir, name, &self.resource.path, check)?;
        if inventory.entries.get(&self.resource.path) != Some(&self.resource.kind) {
            return Err(ApiError::conflict("The entry changed type."));
        }
        Ok(inventory)
    }

    pub(in crate::server) fn check_version(
        &self,
        hidden: bool,
        version: &str,
    ) -> Result<(), ApiError> {
        let (dir, name) = self.endpoint(hidden);
        let mut file = dir.open_regular(name)?;
        check_version(
            &read_limited(&mut file, super::MAX_DOCUMENT_BYTES, "Markdown files")?,
            version,
        )
    }
}

impl Inventory {
    fn visit(
        &mut self,
        dir: &super::platform::Directory,
        name: &OsStr,
        path: &str,
        check: &impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        check()?;
        if self.entries.len() >= 20_000 {
            return Err(ApiError::too_large(
                "Too many entries to recycle in one operation.",
            ));
        }
        validate_relative(path)?;
        let metadata = dir
            .metadata(name)
            .map_err(|e| ApiError::io("Could not inspect the entry", e))?;
        if metadata.is_hidden()
            || metadata.is_link()
            || path
                .rsplit('/')
                .next()
                .is_some_and(|leaf| leaf.starts_with('.'))
        {
            return Err(ApiError::forbidden(
                "Hidden entries and symbolic links cannot be recycled.",
            ));
        }
        if metadata.is_dir() {
            super::validate_directory_path(path)?;
            self.entries.insert(path.into(), ResourceKind::Directory);
            let child = dir.open_child(name, true)?;
            for entry in child
                .entries()
                .map_err(|e| ApiError::io("Could not enumerate a folder", e))?
            {
                let entry =
                    entry.map_err(|e| ApiError::io("Could not inspect a folder member", e))?;
                let leaf = entry.to_str().ok_or_else(|| {
                    ApiError::bad_request("Folder members must have Unicode names.")
                })?;
                self.visit(&child, &entry, &format!("{path}/{leaf}"), check)?;
            }
        } else if metadata.is_file() {
            self.entries.insert(
                path.into(),
                if super::is_markdown(path) {
                    ResourceKind::Document
                } else {
                    ResourceKind::Asset
                },
            );
            self.size = self
                .size
                .checked_add(metadata.fingerprint().0[0])
                .ok_or_else(|| ApiError::too_large("The folder is too large."))?;
        } else {
            return Err(ApiError::forbidden(
                "Only regular files and directories can be recycled.",
            ));
        }
        Ok(())
    }
}

impl Root {
    pub(in crate::server) fn remove_document(
        &self,
        path: &str,
        version: &str,
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        validate_document_path(path)?;
        self.remove_checked(path, version, check)
    }

    pub(in crate::server) fn remove_checked(
        &self,
        path: &str,
        version: &str,
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        validate_relative(path)?;
        let resolved = self.resolve(path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        let bytes = read_limited(&mut file, 16 * 1024 * 1024, "Recycled files")?;
        check_version(&bytes, version)?;
        check()?;
        drop(file);
        resolved
            .parent
            .remove_file(&resolved.name)
            .map_err(|error| ApiError::io("Could not move the file into the recycle bin", error))?;
        resolved.parent.sync()?;
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.remove_tree(path);
        }
        if let Some(store) = self.resources.get() {
            store.retire_resource(path)?;
        }
        Ok(())
    }

    pub(in crate::server) fn restore_asset(
        &self,
        path: &str,
        bytes: &[u8],
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        validate_relative(path)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(ApiError::too_large("The recycled attachment is too large."));
        }
        let resolved = self.resolve(path)?;
        let mut staged = StagedFile::write(&resolved.parent, bytes, None)?;
        staged.commit(&resolved.name, false, check)?;
        resolved.parent.sync()?;
        Ok(())
    }
}
