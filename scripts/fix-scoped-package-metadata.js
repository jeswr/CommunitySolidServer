const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const contextPath = join(__dirname, '..', 'dist', 'components', 'context.jsonld');
const scopedPrefix = 'npmd:@jeswr/community-solid-server/^7.0.0/';
const upstreamPrefix = 'npmd:@solid/community-server/^7.0.0/';
const contextSource = readFileSync(contextPath, 'utf8');

if (!contextSource.includes(scopedPrefix)) {
  throw new Error(`Expected the generated Components.js context to contain ${scopedPrefix}`);
}

function removeEmptyTerms(value) {
  if (Array.isArray(value)) {
    return value.map(removeEmptyTerms);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([ key ]) => key.length > 0)
      .map(([ key, entry ]) => [ key, removeEmptyTerms(entry) ]));
  }
  return value;
}

// The 3.x Components.js generator can emit empty aliases for constructor parameters.
// JSON-LD forbids empty terms, and newer parsers reject the entire package context.
const context = JSON.stringify(removeEmptyTerms(JSON.parse(contextSource)), null, 2);

// This package is a drop-in fork: its generated component identifiers and all
// existing CSS configurations retain the upstream @solid/community-server IRIs.
// The generator derives the `css:` prefix from package.json's scoped npm name,
// so restore that prefix after generation while keeping requireName pointed at
// @jeswr/community-solid-server in components.jsonld.
writeFileSync(contextPath, `${context.replaceAll(scopedPrefix, upstreamPrefix)}\n`);
