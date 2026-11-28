use super::{ApiError, BOM, MAX_DOCUMENT_BYTES};
use std::{fs::File, io::Read};

pub(super) fn preserve_format(original: &[u8], content: &str) -> Result<Vec<u8>, ApiError> {
    let has_bom = original.starts_with(BOM) || content.starts_with('\u{feff}');
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let original = std::str::from_utf8(original)
        .map_err(|_| ApiError::bad_request("The original document is not valid UTF-8."))?;
    let bytes = original.as_bytes();
    let only_crlf = bytes.contains(&b'\n')
        && bytes.iter().enumerate().all(|(index, byte)| match byte {
            b'\n' => index > 0 && bytes[index - 1] == b'\r',
            b'\r' => bytes.get(index + 1) == Some(&b'\n'),
            _ => true,
        });
    let content = if only_crlf && !content.contains('\r') {
        content.replace('\n', "\r\n")
    } else if bytes.contains(&b'\r') && !bytes.contains(&b'\n') && !content.contains('\r') {
        content.replace('\n', "\r")
    } else {
        content.to_owned()
    };
    let mut result = Vec::with_capacity(content.len() + if has_bom { BOM.len() } else { 0 });
    if has_bom {
        result.extend_from_slice(BOM);
    }
    result.extend_from_slice(content.as_bytes());
    validate_content(&result)?;
    Ok(result)
}

pub(in crate::server) fn validate_content(bytes: &[u8]) -> Result<(), ApiError> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(ApiError::too_large(
            "Markdown documents cannot exceed 4 MiB.",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ApiError::bad_request("The Markdown file is not valid UTF-8."))?;
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(ApiError::bad_request(
            "Binary files cannot be edited as Markdown.",
        ));
    }
    Ok(())
}

pub(super) fn read_limited(file: &mut File, limit: usize, kind: &str) -> Result<Vec<u8>, ApiError> {
    let metadata = file
        .metadata()
        .map_err(|error| ApiError::io("Could not inspect the file", error))?;
    if metadata.len() > limit as u64 {
        return Err(ApiError::too_large(format!(
            "{kind} cannot exceed {} MiB.",
            limit / 1024 / 1024
        )));
    }
    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(limit));
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| ApiError::io("Could not read the file", error))?;
    if bytes.len() > limit {
        return Err(ApiError::too_large(format!(
            "{kind} cannot exceed {} MiB.",
            limit / 1024 / 1024
        )));
    }
    Ok(bytes)
}
