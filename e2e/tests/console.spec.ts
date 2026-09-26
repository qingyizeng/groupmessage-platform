import { expect, test, type Page } from '@playwright/test';

const GATEWAY = process.env.E2E_GATEWAY_URL ?? 'http://localhost:4101';

async function login(page: Page, user: 'admin' | 'viewer') {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(user);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('current-role')).toContainText(user);
}

/** Picks an option in an antd Select; the most recently opened dropdown is the last one in the DOM. */
async function pick(page: Page, testId: string, option: string) {
  await page.getByTestId(testId).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last().getByTitle(option, { exact: true }).click();
}

async function gatewayPost(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`${GATEWAY}${path}`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe.configure({ mode: 'serial' });

test('viewer sees data but no write controls', async ({ page }) => {
  await login(page, 'viewer');
  await expect(page.getByRole('cell', { name: 'acc_01' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /重\s*连/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '群组' }).click();
  await expect(page.getByTestId('create-group')).toHaveCount(0);
  // The API refuses writes too.
  const token = await page.evaluate(async () => {
    const r = await fetch('/api/auth/refresh', { method: 'POST' });
    return (await r.json()).accessToken as string;
  });
  const res = await page.request.post('/api/accounts/acc_01/connect', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(403);
});

test('admin: accounts, create group, send, agent run with steps', async ({ page }) => {
  await login(page, 'admin');

  // Accounts: only legal actions are offered; reconnect brings accounts online (pushed live).
  for (const id of ['acc_01', 'acc_02', 'acc_03']) {
    const row = page.getByRole('row', { name: new RegExp(`^${id}`) });
    await expect(row.getByRole('button', { name: /标记离线/ })).toHaveCount(0);
    await row.getByTestId(`account-reconnect-${id}`).click();
    await expect(row.getByTestId('account-status')).toHaveText('online');
    await expect(row.getByTestId(`account-offline-${id}`)).toBeVisible();
    await expect(row.getByTestId(`account-release-${id}`)).toBeVisible();
    await expect(row.getByTestId(`account-reconnect-${id}`)).toHaveCount(0);
  }

  // Create a group through the modal and follow the job.
  await page.getByRole('menuitem', { name: '群组' }).click();
  await page.getByTestId('create-group').click();
  await pick(page, 'creator-select', 'acc_01');
  await pick(page, 'members-select', 'acc_02');
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last().getByTitle('acc_03', { exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /OK|确\s*定/ }).click();
  await expect(page.getByText('建群完成')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('row').nth(1).getByRole('link').click();

  // Members with roles.
  const members = page.getByTestId('members');
  await expect(members.getByRole('row', { name: /acc_01.*creator/ })).toBeVisible();
  await expect(members.getByRole('row', { name: /acc_02.*admin/ })).toBeVisible();
  await expect(members.getByRole('row', { name: /acc_03.*member/ })).toBeVisible();

  // Send as acc_03: appears in the timeline and reaches `sent`.
  await pick(page, 'send-account', 'acc_03（member）');
  await page.getByTestId('send-text').fill('hello from the console');
  await page.getByTestId('send-button').click();
  const own = page.getByTestId('timeline-message').filter({ hasText: 'hello from the console' });
  await expect(own.getByTestId('delivery-status')).toHaveText('sent', { timeout: 10_000 });

  // Enable the agent; an external user's message triggers a run that replies.
  await page.getByTestId('agent-switch').click();
  await expect(page.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'true');
  const gatewayGroupId = (await page.locator('.ant-descriptions-item').filter({ hasText: '网关群 id' }).locator('.ant-descriptions-item-content').textContent())!.trim();
  await gatewayPost(page, `/_control/groups/${gatewayGroupId}/external-message`, {
    platformUserId: 'pu_visitor',
    text: '请问几点开会？',
  });
  await expect(page.getByTestId('timeline-message').filter({ hasText: '请问几点开会？' })).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('agent-run-status').first()).toHaveText('finished', { timeout: 15_000 });

  await page.screenshot({ path: 'test-results/group-detail.png', fullPage: true });

  // Run detail: every step with its kind.
  await page.getByTestId('agent-runs').getByRole('link').first().click();
  await expect(page.getByTestId('run-status')).toHaveText('finished');
  await expect(page.getByTestId('step-kind')).toHaveText(['tool_use', 'tool_use', 'final']);
  await page.screenshot({ path: 'test-results/agent-run.png', fullPage: true });
});

test('timeline: load earlier pages and live append without duplicates', async ({ page }) => {
  await login(page, 'admin');
  await page.getByRole('menuitem', { name: '群组' }).click();
  await page.getByRole('row').nth(1).getByRole('link').click();
  const gatewayGroupId = (await page.locator('.ant-descriptions-item').filter({ hasText: '网关群 id' }).locator('.ant-descriptions-item-content').textContent())!.trim();
  await page.getByTestId('agent-switch').click();
  await expect(page.getByTestId('agent-switch')).toHaveAttribute('aria-checked', 'false');

  for (let i = 0; i < 60; i++) {
    await gatewayPost(page, `/_control/groups/${gatewayGroupId}/external-message`, { platformUserId: 'pu_bulk', text: `bulk ${i}` });
  }
  await page.reload();
  const bulk = page.getByTestId('timeline-message').filter({ hasText: /^.*bulk \d+$/ });
  await expect(bulk).toHaveCount(50);
  await page.getByTestId('load-earlier').click();
  await expect(bulk).toHaveCount(60);
  await gatewayPost(page, `/_control/groups/${gatewayGroupId}/external-message`, { platformUserId: 'pu_bulk', text: 'bulk live' });
  await expect(page.getByTestId('timeline-message').filter({ hasText: 'bulk live' })).toHaveCount(1);
  await expect(bulk).toHaveCount(60);
});
