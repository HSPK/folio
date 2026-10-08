#ifndef FOLIO_CORE_H
#define FOLIO_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct FolioCoreHandle FolioCoreHandle;

uint32_t folio_core_abi_version(void);

/* Paths and requests are UTF-8. A NULL settings_path uses the platform default.
 * On failure create returns NULL and sets *error_out to an allocated message.
 * Handles are single-owner and must not be used concurrently or after free. */
FolioCoreHandle *folio_core_create(const char *settings_path, char **error_out);
void folio_core_free(FolioCoreHandle *handle);

/* Request JSON: {"op":"get_settings"|"status"|"start"|"stop"|"open_url"}
 * or {"op":"save_settings","settings":{...}}.
 * Reply JSON always contains "ok"; errors also contain "error".
 * get_settings/save_settings return "settings"; get_settings also returns
 * "firstRun" (true until settings have been saved). status/start/stop return
 * "status": {"running":bool,"hasFolder":bool,"port":number}.
 * open_url starts if needed and returns "url" (includes a private access token).
 * All returned strings must be released with folio_core_string_free. */
char *folio_core_request(FolioCoreHandle *handle, const char *request_json);
void folio_core_string_free(char *text);

#ifdef __cplusplus
}
#endif
#endif
