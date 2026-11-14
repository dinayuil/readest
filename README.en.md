# Readest lite

[简体中文](README.md) | [English](README.en.md)

**Sync your library to your own cloud storage without a Readest account.**

Readest lite is an independently maintained fork of
[Readest](https://github.com/readest/readest). It retains the upstream reader,
library, annotation, and read-aloud features while changing account requirements,
telemetry, and distribution. This fork provides Windows and Android builds,
released separately from the official Readest app.

[Download the latest release](https://github.com/dinayuil/readest-lite/releases/latest) ·
[Build history](https://github.com/dinayuil/readest-lite/actions/workflows/fork-build.yml) ·
[Project status](fork/status.md)

## Highlights

- **Sync without a Readest account:** configure WebDAV, S3, or another supported
  third-party storage provider to sync your library, book files, reading progress,
  highlights, and notes. Credentials for your storage service are still required.
- **Optional reading statistics sync:** enable **Sync Reading Statistics** in a
  storage provider's settings to merge reading and listening history across
  devices. Existing history is uploaded first, followed by incremental changes.
  The option is off by default.
- **Simpler account navigation:** official account, subscription, and
  account-dependent integration entries are hidden to avoid unusable sign-in and
  upgrade routes.
- **PostHog usage telemetry disabled:** SDK initialization and event reporting are
  blocked, and telemetry controls and consent prompts are hidden. Sentry crash
  reporting remains enabled; see the [implementation notes](fork/requirements.md).
- **Official app update checks disabled:** desktop, Android, and nightly checks
  are disabled in source to avoid offering an official package with a different
  signature. Download new versions from this repository's Releases and install
  them manually.
- **Google translation by default:** providers requiring a Readest login are
  filtered out. If an existing configuration selects an unavailable provider, an
  available fallback is used from the first translation request.
- **Automatic Windows and Android releases:** pushes build both platforms. When
  both builds succeed on the `lite` branch, a GitHub Release is published with
  the downloadable packages.

Upstream features such as multiple book formats, annotations, dictionaries, TTS,
OPDS, and reading layouts remain available. See the
[upstream repository](https://github.com/readest/readest) for the full reader
feature overview.

## Download and installation

Visit this fork's [Releases](https://github.com/dinayuil/readest-lite/releases):

| Platform | File | Purpose |
| --- | --- | --- |
| Windows | `Readest-lite-<version>-x64-setup.exe` | Installer |
| Windows | `Readest-lite-<version>-x64-portable.exe` | Portable executable |
| Android | `Readest-lite-<version>-universal-release.apk` | Signed APK for multiple architectures |

Release tags follow `v<upstream-version>-lite.<build-number>` and titles use
`Readest lite`. Earlier releases may still have files beginning with
`Readest-fork-`; releases built after the rename use the names above.

Windows packages are not code-signed, so SmartScreen may display a warning.
Android packages use this fork's own signing key, which is retained for future
updates. Official APKs and this fork's APKs cannot be installed over each other.

The rename preserves package identifiers, URL schemes, and data paths for
compatibility with existing fork installations. The Windows installer also uses
the product name for its installation directory and uninstall entry, so an older
`Readest` installation entry may remain after the rename. Android retains its
applicationId and signature to allow in-place updates. Side-by-side installation
and data isolation from the official app are not guaranteed.

## Sync scope and limitations

Configure your storage in Settings → Integrations to sync your library, books,
reading progress, and annotations. **This does not unlock all official online
services or subscription features:**

- Global app settings, dictionaries, fonts, and other official account data do
  not gain third-party file sync through these changes.
- Reading statistics require the separate **Sync Reading Statistics** option.
  Book metadata and reading times are stored as unencrypted files. This version
  merges history without cross-device clearing or deletion; repeated sync does
  not count the same record twice.
- Official cloud storage and account-dependent AI/translation proxies are
  outside the scope of this accountless build.
- Google Drive and OneDrive require your own OAuth application and client ID
  configuration. WebDAV and S3 do not require this step.
- This repository automatically builds Windows and Android only. Upstream
  support for other platforms does not mean this fork provides or has validated
  packages for them.

See [fork/requirements.md](fork/requirements.md) for the detailed scope and
configuration switches. Maintainer documentation is currently in Chinese.

### Enable reading statistics sync over WebDAV

1. On each device, connect to the same storage directory in
   **Settings → Integrations → WebDAV** and enable sync.
2. Enable **Sync Reading Statistics** separately on each device and choose
   **Send and receive** as the sync strategy.
3. Select **Sync now**, then open **Reading Statistics** to view the merged history.

The first sync uploads each device's existing statistics. Later, saved reading
and listening events trigger background uploads. Opening a book or the statistics
panel, or running a library sync, also merges data from other devices. If a
background upload cannot finish while offline or before the app closes, the
records remain local and can be uploaded on a later sync.

## Development and maintenance

```bash
git clone --recurse-submodules https://github.com/dinayuil/readest-lite.git
cd readest-lite
pnpm install
pnpm -C apps/readest-app dev-web
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for native build prerequisites and
[fork/build.md](fork/build.md) for fork packages, signing, and workflows.

This fork follows upstream release tags through merges. Maintainer guidance
starts in [AGENTS.md](AGENTS.md). **All progress, validation results, backlog
items, and known issues are recorded only in [fork/status.md](fork/status.md).**
The READMEs describe product features and usage rather than track progress.

- [Requirements and implementation](fork/requirements.md)
- [Build instructions](fork/build.md)
- [Upstream integration procedure](fork/upstream-sync.md)
- [Application testing guide](apps/readest-app/docs/testing.md)

## Credits and license

This project is based on [Readest](https://github.com/readest/readest). Thanks to
Readest, [Foliate](https://github.com/johnfactotum/foliate), and their contributors.
Readest lite is an independently maintained fork; the official website and app
stores distribute the upstream app.

The repository remains licensed under the
[GNU Affero General Public License v3.0](LICENSE). Existing copyright notices
and third-party licenses are retained.
