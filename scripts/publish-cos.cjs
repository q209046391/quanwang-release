const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream, statSync } = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const repo = 'q209046391/quanwang-release';
const testTag = 'quanwang-app-test-8.4.6';
const bucket = 'quanwang-update-test-1542797533';
const region = 'ap-guangzhou';
const origin = 'https://' + bucket + '.cos.' + region + '.myqcloud.com/';
const audience = 'sts.cloud.tencent.com';
const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

async function request(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(180_000), ...options });
}

async function fetchRelease(mode) {
  const route = mode === 'stable' ? 'latest' : 'tags/' + testTag;
  const reply = await request('https://api.github.com/repos/' + repo + '/releases/' + route, {
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GH_TOKEN },
  });
  if (reply.status === 404 && mode === 'stable') return null;
  assert.ok(reply.ok, 'GitHub release request failed with HTTP ' + reply.status);
  const item = await reply.json();
  assert.equal(item.draft, false);
  assert.equal(item.prerelease, mode !== 'stable');
  if (mode !== 'stable') assert.equal(item.tag_name, testTag);
  else assert.match(item.tag_name, /^v\d+\.\d+\.\d+$/);
  return item;
}

function getAsset(release, name, maxBytes) {
  const matches = release.assets.filter(item => item.name === name && item.state === 'uploaded');
  assert.equal(matches.length, 1, 'Expected one uploaded asset named ' + name);
  const file = matches[0];
  assert.match(file.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxBytes);
  const expected = 'https://github.com/' + repo + '/releases/download/' + release.tag_name + '/' + name;
  assert.equal(file.browser_download_url, expected);
  return file;
}

async function digest(stream, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest(encoding);
}

async function downloadAsset(file, dest) {
  const response = await request(file.browser_download_url);
  assert.ok(response.ok && response.body, 'Could not download ' + file.name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest, { flags: 'wx' }));
  assert.equal(statSync(dest).size, file.size);
  assert.equal('sha256:' + await digest(createReadStream(dest), 'sha256', 'hex'), file.digest);
}

function manifestData(buffer, yaml) {
  assert.ok(buffer.byteLength <= 16_384);
  const manifest = yaml.load(buffer.toString('utf8'));
  assert.match(manifest.version, versionPattern);
  const name = 'quanwang-' + manifest.version + '-setup.exe';
  assert.equal(manifest.path, name);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].url, name);
  assert.equal(manifest.files[0].sha512, manifest.sha512);
  assert.match(manifest.sha512, /^[A-Za-z0-9+/]{86}==$/);
  assert.ok(Number.isSafeInteger(manifest.files[0].size) && manifest.files[0].size > 0);
  return manifest;
}

function compareVersion(left, right) {
  const parts = right.split('.').map(Number);
  return left.split('.').map(Number).reduce((order, part, i) => order || part - parts[i], 0);
}

async function getIdentityToken() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', audience);
  const reply = await request(url, { headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } });
  assert.ok(reply.ok, 'GitHub OIDC request failed with HTTP ' + reply.status);
  const { value } = await reply.json();
  const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
  assert.equal(claims.repository, repo);
  assert.equal(claims.ref, 'refs/heads/main');
  assert.equal(claims.aud, audience);
  assert.equal(claims.iss, 'https://token.actions.githubusercontent.com');
  console.log('GitHub OIDC subject: ' + claims.sub);
  return value;
}

async function getTemporaryCredentials(token) {
  const role = process.env.COS_ROLE_ARN;
  assert.match(role ?? '', /^qcs::cam::uin\/\d+:roleName\/quanwang-cos-publisher$/);
  const response = await request('https://sts.tencentcloudapi.com', {
    method: 'POST',
    headers: {
      Authorization: 'SKIP',
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': 'AssumeRoleWithWebIdentity',
      'X-TC-Version': '2018-08-13',
      'X-TC-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-TC-Region': region,
    },
    body: JSON.stringify({
      ProviderId: 'quanwang-github',
      RoleArn: role,
      RoleSessionName: 'quanwang-' + process.env.GITHUB_RUN_ID,
      DurationSeconds: 900,
      WebIdentityToken: token,
    }),
  });
  const { Response: result } = await response.json();
  if (!response.ok || !result?.Credentials) {
    throw Error('Tencent STS rejected the upload role: HTTP ' + response.status + ' ' + (result?.Error?.Code ?? 'unknown'));
  }
  const { TmpSecretId: SecretId, TmpSecretKey: SecretKey, Token: SecurityToken } = result.Credentials;
  assert.ok(SecretId && SecretKey && SecurityToken);
  console.log('Tencent STS issued a temporary publishing credential');
  return { SecretId, SecretKey, SecurityToken };
}

async function currentManifest(prefix, yaml, objectExists) {
  const result = await request(origin + prefix + 'latest.yml', { cache: 'no-store' });
  if (result.status === 404) return null;
  if (result.status === 403 && objectExists && !await objectExists('latest.yml')) return null;
  assert.ok(result.ok, 'Could not read current COS manifest, HTTP ' + result.status);
  return manifestData(Buffer.from(await result.arrayBuffer()), yaml);
}

async function publish(mode, manifest, manifestPath, installerPath, yaml) {
  const prefix = mode === 'stable' ? 'windows/x64/' : 'automation-test/';
  const COS = require('cos-nodejs-sdk-v5');
  const cos = new COS({ ...await getTemporaryCredentials(await getIdentityToken()), Timeout: 120_000 });
  const call = (method, name, options = {}) => new Promise((resolve, reject) => cos[method]({
    Bucket: bucket, Region: region, Key: prefix + name, ...options,
  }, (err, value) => err ? reject(err) : resolve(value)));
  async function objectExists(name) {
    try {
      await call('headObject', name);
      return true;
    } catch (error) {
      if (Number(error.statusCode) === 404) return false;
      throw Error('COS could not check ' + name + ': ' + (error.code || error.statusCode || 'unknown'));
    }
  }
  const current = await currentManifest(prefix, yaml, objectExists);
  if (current) {
    const order = compareVersion(manifest.version, current.version);
    if (order < 0) throw Error('Refused to replace the COS manifest with an older release');
    if (order === 0) {
      assert.equal(current.sha512, manifest.sha512, 'Installer differs for an already published version');
      const existing = await request(origin + prefix + manifest.path, { method: 'HEAD' });
      assert.ok(existing.ok && Number(existing.headers.get('content-length')) === manifest.files[0].size,
        'The published installer must be repaired before this version can be reused');
      console.log('COS already publishes the verified version ' + manifest.version);
      return;
    }
  }

  async function upload(name, source, type, cache) {
    const ContentMD5 = await digest(createReadStream(source), 'md5', 'base64');
    try {
      await call('putObject', name, {
        ACL: 'public-read', Body: createReadStream(source), ContentLength: statSync(source).size,
        ContentMD5, ContentType: type, CacheControl: cache,
      });
    } catch (error) {
      throw Error('COS upload failed for ' + name + ': ' + (error.code || error.statusCode || 'unknown'));
    }
  }

  const assetUrl = origin + prefix + manifest.path;
  // Never replace an existing versioned EXE with different bytes.
  if (!await objectExists(manifest.path)) {
    console.log('Uploading the checked installer to ' + prefix);
    await upload(manifest.path, installerPath, 'application/octet-stream', 'public, max-age=31536000, immutable');
  }
  console.log('Downloading the COS installer to verify the published bytes');
  const asset = await request(assetUrl);
  assert.ok(asset.ok && asset.body, 'The installer is not publicly downloadable, HTTP ' + asset.status);
  assert.equal(Number(asset.headers.get('content-length')), manifest.files[0].size);
  assert.equal(await digest(Readable.fromWeb(asset.body), 'sha512', 'base64'), manifest.sha512);
  console.log('Publishing latest.yml after installer verification');
  await upload('latest.yml', manifestPath, 'application/yaml', 'no-store, max-age=0');
  const published = await currentManifest(prefix, yaml);
  assert.equal(published?.version, manifest.version);
  assert.equal(published?.sha512, manifest.sha512);
  console.log('COS published and verified ' + prefix + 'latest.yml for ' + manifest.version);
}

async function main() {
  const mode = process.env.COS_PUBLISH_MODE;
  assert.ok(['validate', 'test', 'stable'].includes(mode));
  const yaml = require('js-yaml');
  const release = await fetchRelease(mode);
  if (!release) {
    console.log('No formal GitHub release is available');
    return;
  }
  const version = mode === 'stable' ? release.tag_name.slice(1) : '8.4.6';
  assert.match(version, versionPattern);
  const manifestAsset = getAsset(release, 'latest.yml', 16_384);
  const exeAsset = getAsset(release, 'quanwang-' + version + '-setup.exe', 350_000_000);
  const folder = await mkdtemp(path.join(tmpdir(), 'quanwang-cos-'));
  try {
    const manifestPath = path.join(folder, 'latest.yml');
    const installerPath = path.join(folder, exeAsset.name);
    await downloadAsset(manifestAsset, manifestPath);
    const manifest = manifestData(await readFile(manifestPath), yaml);
    assert.equal(manifest.version, version);
    assert.equal(manifest.files[0].size, exeAsset.size);
    await downloadAsset(exeAsset, installerPath);
    assert.equal(await digest(createReadStream(installerPath), 'sha512', 'base64'), manifest.sha512);
    console.log('Verified GitHub release assets for ' + version);
    if (mode === 'validate') await getIdentityToken();
    else await publish(mode, manifest, manifestPath, installerPath, yaml);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

