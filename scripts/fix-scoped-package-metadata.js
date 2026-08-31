const { readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const distributionPath = join(__dirname, '..', 'dist');
const moduleMetadataPath = join(distributionPath, 'components', 'components.jsonld');
const scopedPrefix = 'npmd:@jeswr/community-solid-server/^7.0.0/';
const upstreamPrefix = 'npmd:@solid/community-server/^7.0.0/';
const scopedContext =
  'https://linkedsoftwaredependencies.org/bundles/npm/@jeswr/community-solid-server/^7.0.0/components/context.jsonld';

function jsonLdFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return jsonLdFiles(path);
    }
    return path.endsWith('.jsonld') ? [ path ] : [];
  });
}

function canonicalizeMetadata(value) {
  if (Array.isArray(value)) {
    return value
      .filter(entry => entry !== scopedContext)
      .map(canonicalizeMetadata);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([ key ]) => key.length > 0)
      .map(([ key, entry ]) => [ key, canonicalizeMetadata(entry) ]));
  }
  if (typeof value === 'string') {
    return value.replaceAll(scopedPrefix, upstreamPrefix);
  }
  return value;
}

// This package is a drop-in fork: its generated component identifiers and all
// existing CSS configurations retain the upstream @solid/community-server IRIs.
// Keep the scoped URL as a package-level lookup alias, but canonicalize every
// generated component to the single upstream context and identifier set. This
// also removes empty constructor aliases emitted by the 3.x generator, which
// are invalid JSON-LD terms. The package is consumed through npm's
// @solid/community-server alias, so Components.js must require that installed
// alias rather than the package's scoped publication name.
for (const file of jsonLdFiles(distributionPath)) {
  const metadata = JSON.parse(readFileSync(file, 'utf8'));
  const canonicalMetadata = canonicalizeMetadata(metadata);
  if (file === moduleMetadataPath) {
    canonicalMetadata.requireName = '@solid/community-server';
  }
  writeFileSync(file, `${JSON.stringify(canonicalMetadata, null, 2)}\n`);
}
