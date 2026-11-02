import { AppDialog } from "./primitives";

/** Group writing, project, accessibility, and administrative preferences. */
export function SettingsDialog() {
  return (
    <>
      <AppDialog id="settings-dialog" class="settings-dialog" aria-labelledby="settings-title">
        <form id="settings-form">
          <header class="settings-header">
            <div>
              <h2 id="settings-title">Settings</h2>
              <label class="visually-hidden" for="settings-search">
                Search settings
              </label>
              <input
                id="settings-search"
                type="search"
                placeholder="Search settings"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <button id="settings-close" class="icon-button" type="button" aria-label="Close settings">
              <svg data-icon="x" aria-hidden="true"></svg>
            </button>
          </header>
          <div class="settings-body">
            <nav class="settings-tabs" role="tablist" aria-label="Settings" aria-orientation="vertical">
              <div class="settings-tab-group" data-settings-group="Writing preferences" role="presentation">
                <span class="settings-group-label" aria-hidden="true">
                  Writing preferences
                </span>
                <button type="button" role="tab" data-settings-tab="editor" aria-selected="true">
                  Writing
                </button>
                <button type="button" role="tab" data-settings-tab="appearance" aria-selected="false">
                  Appearance
                </button>
                <button type="button" role="tab" data-settings-tab="layout" aria-selected="false">
                  Layout
                </button>
                <button type="button" role="tab" data-settings-tab="shortcuts" aria-selected="false">
                  Shortcuts
                </button>
                <button type="button" role="tab" data-settings-tab="accessibility" aria-selected="false">
                  Accessibility
                </button>
              </div>
              <div class="settings-tab-group" data-settings-group="Current project" role="presentation">
                <span class="settings-group-label" aria-hidden="true">
                  Current project
                </span>
                <button type="button" role="tab" data-settings-tab="library" aria-selected="false">
                  Project files
                </button>
              </div>
              <div class="settings-tab-group" data-settings-group="Advanced" role="presentation">
                <span class="settings-group-label" aria-hidden="true">
                  Advanced
                </span>
                <button type="button" role="tab" data-settings-tab="performance" aria-selected="false">
                  Performance tuning
                </button>
              </div>
              <div class="settings-tab-group" data-settings-group="Administration" role="presentation">
                <span class="settings-group-label" aria-hidden="true">
                  Administration
                </span>
                <button
                  type="button"
                  role="tab"
                  data-settings-tab="users"
                  data-admin-only="true"
                  aria-selected="false"
                  hidden
                >
                  User management
                </button>
              </div>
            </nav>
            <label class="settings-mobile-navigation" for="settings-section">
              <span>Section</span>
              <select id="settings-section" aria-label="Settings section"></select>
            </label>
            <main class="settings-content">
              <p id="settings-empty" class="settings-empty" hidden>
                No settings match this search.
              </p>
              <section class="settings-panel" data-settings-panel="users" hidden>
                <h3>Accounts &amp; invitations</h3>
                <p id="accounts-error" class="notice is-error" role="alert" hidden></p>
                <div class="setting-card">
                  <label for="invite-lifetime">Invitation expires in</label>
                  <select id="invite-lifetime">
                    <option value="1">1 hour</option>
                    <option value="24" selected>
                      24 hours
                    </option>
                    <option value="168">7 days</option>
                  </select>
                </div>
                <button id="invite-create" class="button-primary" type="button">
                  Create one-time invitation
                </button>
                <div id="invite-created" class="setting-card setting-card-block" hidden>
                  <label for="invite-code">Invitation key</label>
                  <input id="invite-code" type="text" readOnly autocomplete="off" />
                  <button id="invite-copy" type="button">
                    Copy invitation
                  </button>
                </div>
                <h4>Users</h4>
                <div id="accounts-list" class="accounts-list"></div>
                <h4>Invitations</h4>
                <div id="invitations-list" class="accounts-list"></div>
              </section>
              <section class="settings-panel" data-settings-panel="editor">
                <h3>Writing</h3>
                <div class="setting-card">
                  <label for="settings-auto-save">Auto-save after idle</label>
                  <select id="settings-auto-save">
                    <option value="500">500 ms</option>
                    <option value="1000">1 second</option>
                    <option value="2000">2 seconds</option>
                    <option value="5000">5 seconds</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-default-view">Default document view</label>
                  <select id="settings-default-view">
                    <option value="live">Live</option>
                    <option value="source">Source</option>
                    <option value="compare">Compare</option>
                    <option value="read">Read</option>
                  </select>
                </div>
                <label class="setting-card setting-toggle" for="settings-line-wrap">
                  <span>Wrap Source lines</span>
                  <input id="settings-line-wrap" type="checkbox" />
                </label>
                <label class="setting-card setting-toggle" for="settings-spellcheck">
                  <span>Spellcheck in Live mode</span>
                  <input id="settings-spellcheck" type="checkbox" />
                </label>
              </section>
              <section class="settings-panel" data-settings-panel="appearance" hidden>
                <h3>Appearance</h3>
                <div class="setting-card">
                  <label for="settings-theme">Theme</label>
                  <select id="settings-theme">
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-latin-font">English font</label>
                  <input id="settings-latin-font" type="text" maxLength="128" />
                </div>
                <div class="setting-card">
                  <label for="settings-cjk-font">Chinese font</label>
                  <input id="settings-cjk-font" type="text" maxLength="128" />
                </div>
                <div class="setting-card">
                  <label for="settings-font-size">Document font size</label>
                  <div class="setting-range">
                    <input id="settings-font-size" type="range" min="12" max="28" step="1" />
                    <output id="settings-font-size-value" for="settings-font-size">
                      17 px
                    </output>
                  </div>
                </div>
                <div class="setting-card">
                  <label for="settings-line-height">Document line height</label>
                  <div class="setting-range">
                    <input id="settings-line-height" type="range" min="120" max="240" step="5" />
                    <output id="settings-line-height-value" for="settings-line-height">
                      175%
                    </output>
                  </div>
                </div>
                <div class="setting-card">
                  <label for="settings-density">Interface density</label>
                  <select id="settings-density">
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </div>
              </section>
              <section class="settings-panel" data-settings-panel="library" hidden>
                <h3>Project files</h3>
                <p class="settings-note">
                  The image directory belongs to this project. Visibility, refresh, and image-processing defaults use
                  this local service's shared preferences.
                </p>
                <div class="setting-card">
                  <span id="settings-library-label">Current folder</span>
                  <output id="settings-library-root"></output>
                </div>
                <button id="settings-projects-open" type="button" hidden>
                  Projects
                </button>
                <div class="setting-card setting-card-block">
                  <label for="settings-image-directory">Pasted image directory (relative to project)</label>
                  <input id="settings-image-directory" maxLength="512" placeholder="assets/images" />
                </div>
                <div class="setting-card setting-card-block">
                  <label for="hidden-patterns">Hidden paths</label>
                  <textarea
                    id="hidden-patterns"
                    rows="6"
                    placeholder="**/index.md&#10;drafts/**&#10;*.private.md"
                  ></textarea>
                </div>
                <div class="setting-card">
                  <label for="settings-tree-refresh">Automatic file refresh</label>
                  <select id="settings-tree-refresh">
                    <option value="0">Off</option>
                    <option value="10">Every 10 seconds</option>
                    <option value="30">Every 30 seconds</option>
                    <option value="60">Every minute</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-image-compression">Image compression</label>
                  <select id="settings-image-compression">
                    <option value="original">Keep original</option>
                    <option value="webp">Lossless WebP when smaller</option>
                    <option value="jpeg">JPEG on white background</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-image-max-edge">Maximum image edge</label>
                  <select id="settings-image-max-edge">
                    <option value="0">Original dimensions</option>
                    <option value="1024">1024 px</option>
                    <option value="2048">2048 px</option>
                    <option value="4096">4096 px</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-image-quality">JPEG quality</label>
                  <input id="settings-image-quality" type="range" min="50" max="100" step="5" />
                </div>
              </section>
              <section class="settings-panel" data-settings-panel="layout" hidden>
                <h3>Layout</h3>
                <div class="setting-card">
                  <label for="settings-page-width">Page width</label>
                  <select id="settings-page-width">
                    <option value="focused">Focused</option>
                    <option value="balanced">Balanced</option>
                    <option value="wide">Wide</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-sidebar-width">Sidebar width</label>
                  <div class="setting-range">
                    <input id="settings-sidebar-width" type="range" min="210" max="420" step="10" />
                    <output id="settings-sidebar-value" for="settings-sidebar-width">
                      260 px
                    </output>
                  </div>
                </div>
                <div class="setting-card">
                  <label for="settings-default-sidebar">Default navigation</label>
                  <select id="settings-default-sidebar">
                    <option value="files">Notes</option>
                    <option value="outline">Document outline</option>
                  </select>
                </div>
                <label class="setting-card setting-toggle" for="settings-sidebar-open">
                  <span>Open sidebar on launch</span>
                  <input id="settings-sidebar-open" type="checkbox" />
                </label>
              </section>
              <section class="settings-panel" data-settings-panel="performance" hidden>
                <h3>Advanced performance tuning</h3>
                <p class="settings-note">
                  Defaults work for most notes. Adjust these options only when you need to tune large documents or
                  background refresh.
                </p>
                <div class="setting-card">
                  <label for="settings-large-threshold">Virtual Source threshold</label>
                  <select id="settings-large-threshold">
                    <option value="512">512 KiB</option>
                    <option value="768">768 KiB</option>
                    <option value="1024">1 MiB</option>
                    <option value="2048">2 MiB</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-preview-delay">Preview delay</label>
                  <select id="settings-preview-delay">
                    <option value="100">100 ms</option>
                    <option value="300">300 ms</option>
                    <option value="500">500 ms</option>
                    <option value="1000">1 second</option>
                  </select>
                </div>
                <div class="setting-card">
                  <label for="settings-outline-delay">Outline delay</label>
                  <select id="settings-outline-delay">
                    <option value="25">25 ms</option>
                    <option value="75">75 ms</option>
                    <option value="150">150 ms</option>
                    <option value="300">300 ms</option>
                  </select>
                </div>
              </section>
              <section class="settings-panel" data-settings-panel="accessibility" hidden>
                <h3>Accessibility</h3>
                <label class="setting-card setting-toggle" for="settings-reduced-motion">
                  <span>Reduce motion</span>
                  <input id="settings-reduced-motion" type="checkbox" />
                </label>
                <label class="setting-card setting-toggle" for="settings-high-contrast">
                  <span>Increase contrast</span>
                  <input id="settings-high-contrast" type="checkbox" />
                </label>
                <label class="setting-card setting-toggle" for="settings-strong-focus">
                  <span>Strong focus indicators</span>
                  <input id="settings-strong-focus" type="checkbox" />
                </label>
              </section>
              <section class="settings-panel" data-settings-panel="shortcuts" hidden>
                <h3>Shortcuts</h3>
                <div class="setting-card">
                  <label for="settings-command-shortcut">Command panel</label>
                  <select id="settings-command-shortcut">
                    <option value="primary-k">Ctrl/Cmd+K</option>
                    <option value="primary-shift-p">Ctrl/Cmd+Shift+P</option>
                  </select>
                </div>
              </section>
            </main>
          </div>
          <p id="settings-error" class="notice is-error" role="alert" hidden></p>
          <footer class="settings-actions">
            <button id="settings-cancel" type="button">
              Cancel
            </button>
            <button id="settings-save" class="button-primary" type="submit">
              Save
            </button>
          </footer>
        </form>
      </AppDialog>
    </>
  );
}
