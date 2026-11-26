# Releasing Paper Trail

A release is a GitHub Release whose tag is `vX.Y.Z`. Publishing one runs the Release workflow, which checks and builds the tagged commit and attaches the build to the release. Listing the plugin in the bb Community marketplace is a separate, manual step ([below](#marketplace-listing-manual)).

## The short version

1. **Actions → Prepare release → Run workflow**, pick `patch`, `minor` or `major`.
   It pushes a `release/vX.Y.Z` branch that bumps the version and creates a **draft release** with generated notes. Its summary links the pull request: open it (a pull request you open yourself runs CI), wait for CI, and merge.
2. Move the `Unreleased` section of `CHANGELOG.md` under the new version and date (in the same pull request, or one before it).
3. Open the draft release, edit the notes if you like, and **Publish release**.

Publishing runs **Release**. Nothing is published to the marketplace automatically.

The first release is `v0.1.0`: `package.json` is already at `0.1.0`, so create the release by hand instead of running Prepare release (which would bump to `0.1.1`): create a draft release with the new tag `v0.1.0` targeting `main`, then publish it.

## What Release checks

- The tag is `vX.Y.Z` (optionally with a pre-release suffix) and equals `"v" + package.json version` at the tagged commit. A release published before its version bump was merged fails here: delete that release and tag, merge the bump, and publish again. Never move a published tag.
- `npm ci`, `npm run typecheck`, `npx vitest run` (including the marketplace sync script's test), and `npm run check:app` (build with the bb CLI pinned in `.github/bb-version`, then check the app bundle).
- A clean production install (`npm ci --omit=dev`) still builds: marketplace installs have no dev dependencies.

Then it attaches `paper-trail-vX.Y.Z.tar.gz` (the `dist/` build and `package.json`) and its `.sha256` to the release.

## Runners and secrets

All workflows run on GitHub-hosted `ubuntu-latest` runners. The repository is public, so no self-hosted runner is needed. No secrets are required: the built-in `GITHUB_TOKEN` pushes the release branch, creates the draft release and uploads the build.

## Marketplace listing (manual)

Users receive every release inside the marketplace entry's version range without any marketplace change:

| Version line | Entry range | A new release in this line |
|---|---|---|
| `0.x` | `>=0.1.0 <1.0.0` | reaches users directly |
| `1.x` and later | `^MAJOR.0.0` | patches and minors reach users directly |

A marketplace pull request is needed only when the entry does not exist yet (the first release), a release starts a new major version, or the listing changed: display name, store description, tags, category, author, icon (`assets/icon.svg`), long description (`PLUGIN_OVERVIEW.md`) or screenshots (`marketplace/screenshots/`). Pre-releases never change the entry.

The entry is generated from this repository by `scripts/marketplace-sync.mjs`:

| Entry field | Source |
|---|---|
| `id` | the plugin id derived from `package.json` `name` (`paper-trail`) |
| `displayName` | `package.json` `bb.name` |
| `description`, `tags`, `category`, `secondaryCategories`, `author` | `marketplace/listing.json` |
| `icon` | `assets/icon.svg`, copied as `icons/paper-trail-<first 8 sha256 chars>.svg` |
| `overview` | `PLUGIN_OVERVIEW.md`, copied to `overview/paper-trail.md` |
| `screenshots` | every PNG, JPEG or WebP in `marketplace/screenshots/` (sorted by name, at most six, each at least 1200 px wide and at most 2 MiB) |
| `source` | `{ "git": { "url": "https://github.com/vanZeben/bb-paper-trail.git", "range": … } }` |

Run these from the account in `marketplace/listing.json` `author.github`, after the release is published (the marketplace owner is whoever submits the pull request):

```sh
TAG=vX.Y.Z
git clone --depth 1 --branch "$TAG" https://github.com/vanZeben/bb-paper-trail.git paper-trail
(cd paper-trail && npm ci --ignore-scripts)
git clone https://github.com/get-bb/marketplace.git marketplace   # full history: the build reads entry dates from git
node paper-trail/scripts/marketplace-sync.mjs --tag "$TAG" --marketplace marketplace
# the JSON it prints says whether a pull request is needed and why

cd marketplace
git checkout -b "paper-trail-$TAG"
git add -A -- entries/paper-trail.json 'icons/paper-trail-*' overview/paper-trail.md screenshots/paper-trail
git status --porcelain            # only this plugin's files
git commit -m "Update Paper Trail to $TAG"   # "Add plugin entry: paper-trail" for the first entry
npm ci --ignore-scripts && npm run build && npm run check

gh repo fork get-bb/marketplace --clone=false
git remote add fork "https://github.com/$(gh api user --jq .login)/marketplace.git"
git push -u fork "paper-trail-$TAG"
gh pr create --repo get-bb/marketplace --base main --head "$(gh api user --jq .login):paper-trail-$TAG"
```

Pass `--dry-run` to the sync script to print the summary without writing files. Commit with the account's public `noreply` address if you don't want your usual email in the marketplace history. The pull request body should say what the plugin does, the source and range, the checks that passed, its permissions (a standard full-trust bb plugin that holds no credentials), and what each screenshot shows. Changes to the fields the v1 catalog carries (name, description, icon, tags, author, source) also need the marketplace's `v1-change` label.

Opening that pull request needs the owner's final approval.

## Local deployment

Without a release, the plugin deploys from a local build: `npm ci`, `npm run build`, then `bb plugin install .`.
