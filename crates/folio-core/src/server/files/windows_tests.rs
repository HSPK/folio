use super::*;
use std::cell::{Cell, RefCell};
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

#[test]
fn temporary_windows_locks_retry_without_losing_changes_or_ignoring_cancellation() {
    for (external_edit, cancelled) in [(false, false), (true, false), (false, true)] {
        let fixture = Fixture::new();
        let path = fixture.0.join("note.md");
        fs::write(&path, "original").unwrap();
        let root = Root::open(&fixture.0).unwrap();
        let original = root.document("note.md").unwrap();
        let blocker = RefCell::new(Some(
            OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(&path)
                .unwrap(),
        ));
        let resolved = root.resolve("note.md").unwrap();
        {
            let staged = StagedFile::write(&resolved.parent, b"probe", None).unwrap();
            let error = staged
                .parent
                .commit(&staged.name, &resolved.name, true)
                .unwrap_err();
            assert!(matches!(error.raw_os_error(), Some(5 | 32 | 33)));
        }

        let checks = Cell::new(0);
        let result = root.save("note.md", "saved draft", &original.version, || {
            checks.set(checks.get() + 1);
            if checks.get() == 5 {
                drop(blocker.borrow_mut().take());
                if external_edit {
                    fs::write(&path, "external change").unwrap();
                }
                if cancelled {
                    return Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "cancelled"));
                }
            }
            Ok(())
        });
        if external_edit || cancelled {
            assert_eq!(checks.get(), 5);
            assert_eq!(
                result.unwrap_err().status,
                if cancelled {
                    StatusCode::REQUEST_TIMEOUT
                } else {
                    StatusCode::CONFLICT
                }
            );
        } else {
            assert_eq!(checks.get(), 6);
            assert_eq!(result.unwrap().content, "saved draft");
        }
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            if external_edit {
                "external change"
            } else if cancelled {
                "original"
            } else {
                "saved draft"
            }
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
}
