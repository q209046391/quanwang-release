const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const path = require('node:path');

async function main() {
  const [, , installer, version, manifestVersion, expectedSha512] = process.argv;
  assert.match(version || '', /^\d+\.\d+\.\d+$/, 'Expected a release version');
  assert.equal(manifestVersion, version, 'Update manifest has the wrong version');
  assert.equal(path.basename(installer), `全网短剧-${version}-安装版.exe`, 'Update points at the wrong installer');
  assert.match(expectedSha512 || '', /^[A-Za-z0-9+/]{86}==$/, 'Expected a base64 SHA-512 digest');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  assert.equal(hash.digest('base64'), expectedSha512, 'Installer digest differs from the update manifest');
  console.log(`Verified installer digest for 全网短剧 ${version}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

