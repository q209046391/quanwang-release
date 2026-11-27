const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function verify(source, output) {
  const requireCandidate = createRequire(path.join(source, 'package.json'));
  const { version } = requireCandidate('./package.json');
  const yaml = requireCandidate('js-yaml');
  const asar = requireCandidate('@electron/asar');
  const installer = `quanwang-${version}-setup.exe`;
  const manifest = yaml.load(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.path, installer);
  assert.equal(manifest.files.length, 1);
  const [file] = manifest.files;
  assert.equal(file.url, installer);
  const target = path.join(output, installer);
  assert.equal(file.size, fs.statSync(target).size);
  const digest = createHash('sha512');
  for await (const chunk of fs.createReadStream(target)) digest.update(chunk);
  assert.equal(file.sha512, digest.digest('base64'));
  assert.equal(manifest.sha512, file.sha512);

  const resources = path.join(output, 'win-unpacked', 'resources');
  const packaged = path.join(resources, 'app.asar');
  const metadata = JSON.parse(asar.extractFile(packaged, 'package.json'));
  assert.equal(metadata.version, version);
  assert.match(asar.extractFile(packaged, 'main.js').toString(), /get-membership-status/);
  for (const name of ['membership-public.pem', 'membership-v2-public.pem']) {
    const assetPath = path.join('src', 'native', name);
    assert.deepEqual(asar.extractFile(packaged, assetPath), fs.readFileSync(path.join(source, assetPath)));
  }
  const entries = asar.listPackage(packaged);
  for (const plan of ['month', 'year']) {
    const image = entries.find(name => name.startsWith(path.join(path.sep, 'dist-react', 'assets', plan + '-')) && name.endsWith('.jpg'));
    assert.ok(image, `missing ${plan} QR code`);
    assert.deepEqual(asar.extractFile(packaged, image.slice(1)), fs.readFileSync(path.join(source, 'src/assets/membership', plan + '.jpg')));
  }
  const helper = path.join('build', 'sdk-playback', 'win32-x64', 'hongguo-sdk-playback.exe');
  assert.ok(asar.statFile(packaged, helper).unpacked);
  assert.ok(fs.statSync(path.join(resources, 'app.asar.unpacked', helper)).size > 0);
  for (const media of ['ffmpeg.exe', 'ffprobe.exe', 'librempeg.exe']) {
    assert.ok(fs.statSync(path.join(resources, 'bin', media)).size > 0);
  }
  console.log(`Verified ${version}: NSIS manifest, both QR codes, public membership keys and Windows media runtime`);
}

verify(...process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
