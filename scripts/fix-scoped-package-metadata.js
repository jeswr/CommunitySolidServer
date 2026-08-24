const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const contextPath = join(__dirname, '..', 'dist', 'components', 'context.jsonld');
const scopedPrefix = 'npmd:@jeswr/community-solid-server/^7.0.0/';
const upstreamPrefix = 'npmd:@solid/community-server/^7.0.0/';
const context = readFileSync(contextPath, 'utf8');

if (!context.includes(scopedPrefix)) {
  throw new Error(`Expected the generated Components.js context to contain ${scopedPrefix}`);
}

// This package is a drop-in fork: its generated component identifiers and all
// existing CSS configurations retain the upstream @solid/community-server IRIs.
// The generator derives the `css:` prefix from package.json's scoped npm name,
// so restore that prefix after generation while keeping requireName pointed at
// @jeswr/community-solid-server in components.jsonld.
writeFileSync(contextPath, context.replaceAll(scopedPrefix, upstreamPrefix));
