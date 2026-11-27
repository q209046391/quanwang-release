const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream, statSync } = require('node:fs');
const { mkdtemp, open, readFile, rm, writeFile } = require('node:fs/promises');
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
    signal: AbortSignal.timeout(45_000),
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
      DurationSeconds: 2400,
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
  const { SecretId, SecretKey, SecurityToken } = await getTemporaryCredentials(await getIdentityToken());
  function signedHeaders(method, name, headers = {}, Query = {}) {
    const Key = prefix + name;
    const url = new URL(Key, origin);
    const Headers = { host: url.host, 'x-cos-security-token': SecurityToken, ...headers };
    const authorization = COS.getAuthorization({ SecretId, SecretKey, Method: method, Key, Headers, Query, Expires: 300 });
    return { ...Headers, authorization };
  }
  async function objectExists(name) {
    const result = await request(origin + prefix + name, {
      method: 'HEAD', redirect: 'error', headers: signedHeaders('HEAD', name), signal: AbortSignal.timeout(30_000),
    });
    if (result.status === 404) return false;
    assert.ok(result.ok, 'COS could not check ' + name + ': HTTP ' + result.status);
    return true;
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

  async function uploadFile(name, source, extraHeaders, query = {}) {
    const responsePath = source + '.cos-body';
    const headerPath = source + '.cos-head';
    const url = new URL(prefix + name, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = signedHeaders('PUT', name, {
      'content-length': String(statSync(source).size),
      'content-md5': await digest(createReadStream(source), 'md5', 'base64'),
      ...extraHeaders,
    }, query);
    const input = Object.entries(headers).map(([key, value]) => 'header = ' + JSON.stringify(key + ': ' + value)).join('\n');
    const log = 'HTTP %{http_code}, sent %{size_upload} bytes in %{time_total}s';
    const { status, summary } = await new Promise((resolve, reject) => {
      const child = spawn('curl', [
        '--config', '-', '--silent', '--http1.1', '--connect-timeout', '15', '--max-time', '140',
        '--retry', '1', '--retry-max-time', '285',
        '--expect100-timeout', '5', '--header', 'Expect: 100-continue',
        '--upload-file', source, '--output', responsePath, '--dump-header', headerPath,
        '--write-out', log, url.href,
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stdin.on('error', reject);
      child.on('error', reject);
      child.on('close', status => resolve({ status, summary: stdout || 'no HTTP response' }));
      child.stdin.end(input);
    });
    const body = await readFile(responsePath, 'utf8').catch(() => '');
    const code = body.match(/<Code>([\w.]+)<\/Code>/)?.[1];
    assert.ok(status === 0 && /^HTTP 2\d\d\b/.test(summary),
      'COS upload failed for ' + name + ': ' + summary + ' (curl ' + status + (code ? ', ' + code : '') + ')');
    return readFile(headerPath, 'utf8');
  }

  async function multipartControl(method, name, query, headers = {}, body) {
    const url = new URL(prefix + name, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const result = await request(url, {
      method, body, headers: signedHeaders(method, name, headers, query),
      redirect: 'error', signal: AbortSignal.timeout(45_000),
    });
    const xml = await result.text();
    const code = xml.match(/<Code>([\w.]+)<\/Code>/)?.[1];
    assert.ok(result.ok && !code, 'COS multipart ' + method + ': HTTP ' + result.status + (code ? ' ' + code : ''));
    return xml;
  }

  async function uploadInstaller(name) {
    const xml = await multipartControl('POST', name, { uploads: '' }, {
      'x-cos-acl': 'public-read',
      'content-type': 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    const uploadId = xml.match(/<UploadId>([A-Za-z0-9._~+/=-]+)<\/UploadId>/)?.[1];
    assert.ok(uploadId, 'COS did not return a multipart upload ID');
    const source = await open(installerPath, 'r');
    try {
      const partSize = 1024 * 1024;
      const total = statSync(installerPath).size;
      const count = Math.ceil(total / partSize);
      const parts = Array(count);
      let next = 0;
      let received = 0;
      let failure;
      async function worker() {
        while (!failure && next < count) {
          const index = next++;
          const start = index * partSize;
          const part = Buffer.alloc(Math.min(partSize, total - start));
          const { bytesRead } = await source.read(part, 0, part.length, start);
          assert.equal(bytesRead, part.length);
          const number = index + 1;
          const partPath = path.join(path.dirname(installerPath), 'part-' + number);
          await writeFile(partPath, part, { flag: 'wx' });
          const headers = await uploadFile(name, partPath, {}, { partNumber: String(number), uploadId });
          const etag = headers.match(/^etag:\s*"?([a-f\d]+)"?\s*$/im)?.[1];
          assert.match(etag ?? '', /^[a-f\d]{32}$/i);
          parts[index] = '<Part><PartNumber>' + number + '</PartNumber><ETag>"' + etag + '"</ETag></Part>';
          received++;
          if (received % 16 === 0 || received === count) console.log('COS received ' + received + ' of ' + count + ' parts');
        }
      }
      await Promise.all(Array.from({ length: Math.min(24, count) }, () =>
        worker().catch(error => { failure ||= error; })));
      if (failure) throw failure;
      const body = '<CompleteMultipartUpload>' + parts.join('') + '</CompleteMultipartUpload>';
      await multipartControl('POST', name, { uploadId }, { 'content-type': 'application/xml' }, body);
    } catch (error) {
      await multipartControl('DELETE', name, { uploadId }).catch(cleanup => console.warn(cleanup.message));
      throw error;
    } finally {
      await source.close();
    }
  }

  const assetUrl = origin + prefix + manifest.path;
  // Never replace an existing versioned EXE with different bytes.
  if (!await objectExists(manifest.path)) {
    console.log('Uploading the checked installer to ' + prefix);
    await uploadInstaller(manifest.path);
  }
  console.log('Downloading the COS installer to verify the published bytes');
  const asset = await request(assetUrl);
  assert.ok(asset.ok && asset.body, 'The installer is not publicly downloadable, HTTP ' + asset.status);
  assert.equal(Number(asset.headers.get('content-length')), manifest.files[0].size);
  assert.equal(await digest(Readable.fromWeb(asset.body), 'sha512', 'base64'), manifest.sha512);
  console.log('Publishing latest.yml after installer verification');
  await uploadFile('latest.yml', manifestPath, {
    'x-cos-acl': 'public-read', 'content-type': 'application/yaml', 'cache-control': 'no-store, max-age=0',
  });
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

