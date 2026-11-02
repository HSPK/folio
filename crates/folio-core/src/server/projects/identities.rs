use super::{ApiError, Project, Registry, Sharing, Summary};
use crate::server::state_store::resources::{ResourceKind, validate_id};
use std::collections::{BTreeMap, BTreeSet};

impl Project {
    pub(super) fn summary(&self, id: &str, user: &str) -> Summary {
        let owned = self.owned(user);
        Summary {
            id: id.into(),
            name: self.name.clone(),
            owner: self.owner.clone(),
            owned,
            root: owned.then(|| self.root.clone()),
            shared: self.shared,
            access: self.permission(user, None),
            pages: self
                .pages
                .iter()
                .filter(|(path, _)| owned || self.permission(user, Some(path)) != Sharing::Private)
                .map(|(path, level)| (path.clone(), *level))
                .collect(),
            document_ids: BTreeMap::new(),
            image_directory: self.image_directory.clone(),
            public_links: if owned {
                self.public_links
                    .iter()
                    .map(|(path, link)| (path.clone(), link.info()))
                    .collect()
            } else {
                BTreeMap::new()
            },
        }
    }
}

impl Registry {
    pub(super) fn summarize(
        &self,
        project: &Project,
        id: &str,
        user: &str,
    ) -> Result<Summary, ApiError> {
        let mut summary = project.summary(id, user);
        let documents = summary
            .pages
            .keys()
            .chain(summary.public_links.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let resources = self.storage()?.project(id).identify_many(
            &documents
                .into_iter()
                .map(|path| (path, ResourceKind::Document))
                .collect::<Vec<_>>(),
        )?;
        summary.document_ids = resources
            .into_iter()
            .map(|resource| (resource.path, resource.id))
            .collect();
        Ok(summary)
    }

    pub(super) fn bind_public_identities(&self) -> Result<(), ApiError> {
        if !self.catalog()?.projects.values().any(|project| {
            project
                .public_links
                .values()
                .any(|link| link.resource.is_none())
        }) {
            return Ok(());
        }
        self.mutate(|catalog| {
            for (id, project) in &mut catalog.projects {
                let store = self.storage()?.project(id);
                let paths = project
                    .public_links
                    .iter()
                    .filter(|(_, link)| link.resource.is_none())
                    .map(|(path, _)| (path.clone(), ResourceKind::Document))
                    .collect::<Vec<_>>();
                for resource in store.identify_many(&paths)? {
                    if let Some(link) = project.public_links.get_mut(&resource.path) {
                        link.resource = Some(resource.id);
                    }
                }
            }
            Ok(())
        })
    }

    pub(super) fn permission_path(
        &self,
        project: &str,
        document: &str,
    ) -> Result<String, ApiError> {
        validate_id(document)?;
        let store = self.storage()?.project(project);
        let resource = store.resource(document, true)?;
        if resource.kind != ResourceKind::Document {
            return Err(ApiError::bad_request("Choose a document resource."));
        }
        if store
            .resource_at_path(&resource.path, false)?
            .is_some_and(|active| active.id != resource.id)
        {
            return Err(ApiError::conflict(
                "This location now belongs to another document. Its permissions cannot be changed through the old identity.",
            ));
        }
        Ok(resource.path)
    }
}
