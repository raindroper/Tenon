import test from 'node:test';
import assert from 'node:assert/strict';
import { HubMediaClient, HubMediaError } from '../server/media/hub-media.js';

const signal = () => new AbortController().signal;
const connection = () => ({ apiBaseUrl: 'http://127.0.0.1:8788/v1', apiKey: 'fixture-hub-key' });
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const client = (fetcher: typeof fetch) => new HubMediaClient({ baseUrl: 'http://127.0.0.1:8788/v1', connection, fetch: fetcher });

test('media catalog uses separate metadata endpoint and filters capabilities without guessing model names or exposing pricing', async () => {
  const media = client(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8788/v1/media/models');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-hub-key');
    return json({ enabled: false, models: [
      { id: 'chat-image-looking-name', tags: ['craft'] },
      { id: 'image-model-3.0', name: 'Picture', tags: ['text-to-image', 'image-to-image'], creditPerImage: 6 },
      { id: 'video-model', tags: ['text-to-video'], videoGeneration: { resolutions: ['720P', '1080P'], defaultSeconds: 5, maxSeconds: 10,
        aspectRatios: ['16:9'], supportsFirstFrame: false, audioMode: 'switchable', defaultEnableAudio: true } },
      { id: 'video-model', tags: ['image-to-video'] },
    ] });
  });
  const result = await media.catalog(signal());
  assert.equal(result.enabled, false); assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, 'image-model-3.0'); assert.equal('creditPerImage' in result.models[0], false);
  assert.deepEqual(result.models[1].videoGeneration?.resolutions, ['720P', '1080P']);
  assert.equal(result.models[1].videoGeneration?.audioMode, 'switchable');
  assert.equal(result.models[1].videoGeneration?.defaultEnableAudio, true);
  assert.deepEqual(result.models[1].tags, ['text-to-video']);
});

test('image generation and editing send exact JSON once and return durable source references before any download', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const media = client(async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    assert.equal(options?.redirect, 'error');
    return json({ model: 'image-fixture', data: requests.length === 1 ? [{ url: 'https://cdn.example.com/result.png?signature=test' }] : [{ b64_json: imageBytes.toString('base64') }] });
  });
  const generated = await media.generateImage({ model: 'image-fixture', prompt: ' owner requested picture ', size: '1024x1024' }, signal());
  assert.deepEqual(generated.source, { url: 'https://cdn.example.com/result.png?signature=test' });
  assert.equal(requests.length, 1, 'a received URL is handed to durable storage before attempting its download');
  assert.equal(requests[0].url, 'http://127.0.0.1:8788/v1/images/generations');
  assert.deepEqual(requests[0].body, { model: 'image-fixture', prompt: 'owner requested picture', size: '1024x1024', n: 1, response_format: 'url' });
  const edited = await media.generateImage({ model: 'image-fixture', prompt: 'edit', image: ['data:image/png;base64,' + imageBytes.toString('base64')] }, signal());
  assert.match(requests[1].url, /images\/edits$/);
  const content = await media.openImage(edited.source, signal());
  assert.equal(content.mediaType, 'image/png'); assert.deepEqual(Buffer.from(await new Response(content.body).arrayBuffer()), imageBytes);
  assert.equal(requests.length, 2);
});

test('network interruption or invalid success after submitting generation is uncertain and never automatically resubmits', async () => {
  let calls = 0;
  const media = client(async () => { calls++; throw new Error('network failed fixture-hub-key'); });
  await assert.rejects(media.submitVideo({ model: 'video', prompt: 'owner-approved video' }, signal()), (error: unknown) => {
    assert.ok(error instanceof HubMediaError); assert.equal(error.uncertain, true); assert.equal(error.retryable, true); assert.doesNotMatch(error.message, /fixture-hub-key/); return true;
  });
  assert.equal(calls, 1);
  const broken = client(async () => { calls++; return json({ success: true }); });
  await assert.rejects(broken.generateImage({ prompt: 'fixture' }, signal()), (error: unknown) => error instanceof HubMediaError && error.uncertain);
  assert.equal(calls, 2);
});

test('video submission, polling, cancellation and protected MP4 download keep the same gateway task and key', async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])]);
  const media = client(async (url, options) => {
    requests.push({ url: String(url), method: options?.method });
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-hub-key');
    if (String(url).endsWith('/content')) return new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
    if (String(url).endsWith('/videos')) assert.equal(JSON.parse(String(options?.body)).enable_audio, false);
    if (String(url).endsWith('/cancel')) return json({ id: 'video_1', status: 'failed', error: { code: 'cancelled', message: 'cancelled before dispatch' } });
    return json({ id: 'video_1', status: requests.length === 1 ? 'queued' : 'completed', model: 'video-model', seconds: '5', url: 'https://untrusted.example/result.mp4' }, requests.length === 1 ? 202 : 200);
  });
  const submitted = await media.submitVideo({ model: 'video-model', prompt: 'video fixture', seconds: 5, resolution: '720P', aspect_ratio: '16:9', enable_audio: false }, signal());
  assert.equal(submitted.id, 'video_1'); assert.equal(submitted.status, 'queued'); assert.equal(submitted.seconds, 5);
  assert.equal((await media.videoStatus(submitted.id, signal())).status, 'completed');
  const content = await media.downloadVideo(submitted.id, signal()); assert.deepEqual(Buffer.from(await new Response(content.body).arrayBuffer()), mp4);
  assert.equal((await media.cancelVideo(submitted.id, signal())).error?.code, 'cancelled');
  assert.deepEqual(requests.map(item => item.url), ['/videos', '/videos/video_1', '/videos/video_1/content', '/videos/video_1/cancel'].map(path => 'http://127.0.0.1:8788/v1' + path));
  assert.deepEqual(requests.map(item => item.method), ['POST', 'GET', 'GET', 'POST']);
});

test('model connection changes or malformed references never send a key or paid request to another endpoint', async () => {
  let calls = 0;
  const media = new HubMediaClient({ baseUrl: 'http://127.0.0.1:8788/v1', connection: () => ({ apiBaseUrl: 'https://another.example/v1', apiKey: 'private-key' }), fetch: async () => { calls++; throw new Error(); } });
  await assert.rejects(media.generateImage({ prompt: 'fixture' }, signal()), /不一致/);
  await assert.rejects(media.videoStatus('../outside', signal()));
  const matching = client(async () => { calls++; throw new Error(); });
  await assert.rejects(matching.generateImage({ prompt: 'fixture', image: ['file:///etc/passwd'] }, signal()));
  await assert.rejects(matching.openImage({ url: 'https://127.0.0.1/private' }, signal()), /公开网络/);
  await assert.rejects(matching.openImage({ url: 'https://[::1]/private' }, signal()), /公开网络/);
  await assert.rejects(matching.openImage({ url: 'https://user:secret@example.com/private' }, signal()), /公开 HTTPS/);
  assert.equal(calls, 0);
});

test('wrong file types, oversized bodies and rejected generation are explicit without regeneration', async () => {
  let calls = 0;
  const media = client(async () => { calls++; return new Response('<html>not a video</html>', { headers: { 'content-type': 'text/html' } }); });
  await assert.rejects(media.downloadVideo('video_1', signal()), /MP4/); assert.equal(calls, 1);
  const oversized = client(async () => new Response('small', { headers: { 'content-type': 'video/mp4', 'content-length': String(101 * 1024 * 1024) } }));
  await assert.rejects(oversized.downloadVideo('video_1', signal()), /上限/);
  const rejected = client(async () => json({ error: { message: 'media disabled fixture-hub-key' } }, 404));
  await assert.rejects(rejected.generateImage({ prompt: 'fixture' }, signal()), (error: unknown) => {
    assert.ok(error instanceof HubMediaError); assert.equal(error.uncertain, false); assert.equal(error.status, 404); assert.doesNotMatch(error.message, /fixture-hub-key/); return true;
  });
  const invalid = client(async () => new Response('invalidbytes', { headers: { 'content-type': 'video/mp4' } }));
  const content = await invalid.downloadVideo('video_1', signal());
  await assert.rejects(new Response(content.body).arrayBuffer(), /不完整|格式/);
});

test('artifact validation failures stop retries while transport and temporary HTTP failures remain retryable', async () => {
  const permanent = (error: unknown) => error instanceof HubMediaError && !error.retryable;
  await assert.rejects(client(async () => new Response('wrong-type', { headers: { 'content-type': 'text/html' } })).downloadVideo('video_1', signal()), permanent);
  await assert.rejects(client(async () => new Response('small', { headers: { 'content-type': 'video/mp4', 'content-length': String(101 * 1024 * 1024) } })).downloadVideo('video_1', signal()), permanent);
  const invalid = await client(async () => new Response('not-valid-video-content', { headers: { 'content-type': 'video/mp4' } })).downloadVideo('video_1', signal());
  await assert.rejects(new Response(invalid.body).arrayBuffer(), permanent);
  await assert.rejects(client(async () => json({ invalid: 'task shape' })).videoStatus('video_1', signal()), permanent);
  await assert.rejects(client(async () => json({})).openImage({ b64: 'not-base64' }, signal()), permanent);
  for (const status of [401, 404, 408, 429, 500]) {
    const media = client(async () => json({ error: { message: 'fixture HTTP failure' } }, status));
    await assert.rejects(media.videoStatus('video_1', signal()), (error: unknown) => {
      assert.ok(error instanceof HubMediaError); assert.equal(error.retryable, [408, 429, 500].includes(status)); return true;
    });
  }
});
