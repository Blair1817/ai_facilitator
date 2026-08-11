# Reversible baselines

Created on 2026-08-11 before any further facilitation-agent changes.

This project did not contain Git history when it was inspected. The change
history below is therefore reconstructed from the preserved initial runtime
copy and the current workspace; it is not a commit-exact authorship record.

## Archives

### Original downloaded source

- File: `original_download_source_2026-08-11.tar.gz`
- SHA-256: `94927f8503a0ae7a82320938a6d07fc09e4036874d8b1f86f0f375ed1025ac9e`
- Source: `/tmp/delibra-run.u6U3NG`
- Excludes: `.env`, `node_modules`, build output, Empirica local runtime data,
  Python caches, and `.DS_Store`.

This is the rollback reference for the project as first downloaded/tested.

### Current facilitation-agent baseline

- File: `facilitation_current_2026-08-11.tar.gz`
- SHA-256: `d8ae319757505b06276382a082e05696480a3fd22138ff1faf427d16de7e61af`
- Contains 27 current facilitation-agent, prompt-loader, UI-gating, and test
  files.
- Contains no `.env`, dependency directory, build output, or experiment data.

This is the rollback reference for changes made after the requested-Generalist
implementation.

## Safe restoration

Extract into a new directory first; do not overwrite the active project until
the extracted files have been reviewed.

```sh
mkdir -p /tmp/delibra-restore-review
tar -xzf reversible_baselines/facilitation_current_2026-08-11.tar.gz \
  -C /tmp/delibra-restore-review
```

For the original downloaded source, use a different empty review directory:

```sh
mkdir -p /tmp/delibra-original-review
tar -xzf reversible_baselines/original_download_source_2026-08-11.tar.gz \
  -C /tmp/delibra-original-review
```

## Reversibility rule from this baseline onward

Before modifying any covered file:

1. Preserve its current version in a dated archive or Git commit.
2. Record the purpose and affected files here.
3. Run focused tests before and after the change.
4. Restore from the archive if the focused tests regress.

Once all OneDrive `dataless` files are fully downloaded, initialise a local Git
repository and commit the entire current source tree as the next baseline.
