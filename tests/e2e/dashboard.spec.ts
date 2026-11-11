import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

function source(page: Page) {
  return page.locator('.asset-meta-badge').filter({ hasText: 'Source:' });
}

function connectedPeers(page: Page) {
  return page.locator('.stat-card').filter({ hasText: 'Active Mesh Peers' }).locator('.stat-value');
}

async function requestAsset(page: Page, url?: string) {
  if (url) await page.getByRole('textbox', { name: 'Asset URL' }).fill(url);
  await page.getByRole('button', { name: 'Request Single Asset' }).click();
}

async function assetDigest(page: Page): Promise<string> {
  return page.getByAltText('Resolved from Mesh').evaluate(async (image: HTMLImageElement) => {
    const response = await fetch(image.src);
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  });
}

test('two isolated Chromium sessions deliver a multi-megabyte asset through real WebRTC', async ({ browser, baseURL }) => {
  const url = new URL('/test-large.png', baseURL).href;
  const bytes = randomBytes(2 * 1024 * 1024 + 71);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const seeder = await browser.newContext();
  const receiver = await browser.newContext();
  try {
    let originRequests = 0;
    let receiverOriginRequests = 0;
    await seeder.route(url, (route) => {
      originRequests++;
      return route.fulfill({ body: bytes, contentType: 'image/png' });
    });
    await receiver.route(url, (route) => {
      receiverOriginRequests++;
      return route.abort();
    });
    const first = await seeder.newPage();
    await first.goto(baseURL!);
    await requestAsset(first, url);
    await expect(source(first)).toContainText('HTTP Origin');
    expect(await assetDigest(first)).toBe(digest);

    const second = await receiver.newPage();
    await second.goto(baseURL!);
    await expect(connectedPeers(second)).toHaveText('1', { timeout: 10_000 });
    await requestAsset(second, url);
    await expect(source(second)).toContainText('P2P Mesh', { timeout: 10_000 });
    expect(await assetDigest(second)).toBe(digest);
    await requestAsset(second, url);
    await expect(source(second)).toContainText('IndexedDB Cache');
    expect(originRequests).toBe(1);
    expect(receiverOriginRequests).toBe(0);
    await first.close();
    await expect(connectedPeers(second)).toHaveText('0');
  } finally {
    await Promise.all([seeder.close(), receiver.close()]);
  }
});

test('service worker serves the pinned sample and leaves Range and reload requests to HTTP', async ({ page }) => {
  await page.goto('/');
  await requestAsset(page);
  await expect(source(page)).toContainText('HTTP Origin');
  await expect(page.getByAltText('Resolved from Mesh')).toBeVisible();

  await page.getByRole('button', { name: 'Enable SW' }).click();
  await expect(page.getByRole('button', { name: /SW Active/ })).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect.poll(() => page.evaluate(async () => {
    const response = await fetch('/sample.png');
    return response.headers.get('x-shadowcast-source');
  })).toBe('service-worker');

  const responses = await page.evaluate(async () => {
    const normal = await fetch('/sample.png');
    const range = await fetch('/sample.png', { headers: { Range: 'bytes=0-7' } });
    const reload = await fetch('/sample.png', { cache: 'reload' });
    return {
      mimeType: normal.headers.get('content-type'),
      rangeSource: range.headers.get('x-shadowcast-source'),
      rangeStatus: range.status,
      rangeBytes: (await range.arrayBuffer()).byteLength,
      reloadSource: reload.headers.get('x-shadowcast-source'),
      reloadStatus: reload.status,
    };
  });
  expect(responses).toEqual({
    mimeType: 'image/png', rangeSource: null, rangeStatus: 206, rangeBytes: 8, reloadSource: null, reloadStatus: 200,
  });
  const other = await page.context().newPage();
  await other.goto('/playground');
  const sourceFromOtherTab = await other.evaluate(async () => {
    const response = await fetch('/sample.png');
    return response.headers.get('x-shadowcast-source');
  });
  expect(sourceFromOtherTab).toBeNull();
  await other.close();
  await page.getByRole('button', { name: /SW Active/ }).click();
  await expect(page.getByRole('button', { name: 'Enable SW' })).toBeVisible();
});

test('playground admits a room and exposes live client status', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: /connect/i }).click();
  await expect(page.getByText(/Connected successfully to room/)).toBeVisible();
  await expect(page.getByText(/"isConnected": true/)).toBeVisible();
});
