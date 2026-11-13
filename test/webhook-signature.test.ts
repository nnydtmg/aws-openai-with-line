import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// ハンドラはモジュール読み込み時に環境変数を参照するため、import より前に設定する
const channelSecret = 'test-channel-secret';
process.env.CHANNEL_SECRET = channelSecret;
process.env.CHANNEL_ACCESS_TOKEN = 'test-access-token';
process.env.OPEN_AI_SECRET = 'test-openai-key';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/lambda/api-handler').default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sign = (body: string) => createHmac('sha256', channelSecret).update(body).digest('base64');
const body = JSON.stringify({ destination: 'xxx', events: [] });

test('署名ヘッダーがないリクエストは 401 で拒否されること', async () => {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  expect(res.status).toBe(401);
});

test('署名が一致しないリクエストは 401 で拒否されること', async () => {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign('tampered') },
    body,
  });
  expect(res.status).toBe(401);
});

test('/webhook 以外のパスにも署名検証が適用されること', async () => {
  const res = await fetch(`${baseUrl}/other`, { method: 'GET' });
  expect(res.status).toBe(401);
});

test('正しい署名のリクエストは受け付けられること', async () => {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) },
    body,
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});
