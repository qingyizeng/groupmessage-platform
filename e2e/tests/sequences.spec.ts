import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill('admin');
  await page.getByTestId('login-password').fill('admin');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('current-role')).toContainText('admin');
}

const openDropdown = (page: Page) => page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();

async function ensureGroup(page: Page): Promise<void> {
  // Runs after console.spec in the same stack; create a group here if running alone.
  const groups = await page.request.get('/api/groups', { headers: { authorization: `Bearer ${await token(page)}` } });
  if ((await groups.json()).some((g: { status: string }) => g.status === 'active')) return;
  const auth = { authorization: `Bearer ${await token(page)}` };
  for (const id of ['acc_01', 'acc_02', 'acc_03']) await page.request.post(`/api/accounts/${id}/connect`, { headers: auth });
  const { jobId } = await (await page.request.post('/api/groups', { headers: auth, data: { creatorAccountId: 'acc_01', memberAccountIds: ['acc_02', 'acc_03'] } })).json();
  await expect
    .poll(async () => (await (await page.request.get(`/api/jobs/${jobId}`, { headers: auth })).json()).status, { timeout: 20_000 })
    .toBe('finished');
}

const token = (page: Page) =>
  page.evaluate(async () => ((await (await fetch('/api/auth/refresh', { method: 'POST' })).json()).accessToken as string));

test('sequence run: create, preflight errors and sources, start, live progress', async ({ page }) => {
  await login(page);
  await ensureGroup(page);
  await page.getByRole('menuitem', { name: '序列' }).click();

  await page.getByTestId('new-sequence').click();
  await page.getByTestId('sequence-json').fill(
    JSON.stringify({
      name: 'E2E 提醒',
      steps: [
        { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始', delaySeconds: 1 },
        { index: 2, accountRole: 'member', text: '{event} 资料在 {location}', delaySeconds: 1 },
      ],
    }),
  );
  await page.getByRole('button', { name: /OK|确\s*定/ }).click();
  await expect(page.getByTestId('seq-sequence')).toContainText('E2E 提醒');

  await page.getByTestId('seq-group').click();
  await openDropdown(page).locator('.ant-select-item-option:not(.ant-select-item-option-disabled)').first().click();

  await page.getByTestId('var-event').fill('周会');
  await page.getByTestId('var-time').fill('10:00');
  await page.getByTestId('preflight').click();
  await expect(page.getByTestId('preflight-error')).toContainText('第 2 步的占位符 {location}');
  await expect(page.getByTestId('start-run')).toBeDisabled();
  await page.getByRole('button', { name: '返回修改' }).click();

  await page.getByTestId('stepvar-2-location').fill('共享盘/Q2');
  await page.getByTestId('preflight').click();
  const table = page.getByTestId('preflight-table');
  await expect(table).toContainText('周会 将于 10:00 开始');
  await expect(table).toContainText('周会 资料在 共享盘/Q2');
  await expect(table.getByTestId('var-source')).toHaveText(['default', 'default', 'default', 'step:2']);
  await page.getByTestId('start-run').click();

  await expect(page).toHaveURL(/\/sequence-runs\//);
  await expect(page.getByTestId('seq-run-status')).toHaveText('finished', { timeout: 20_000 });
  await expect(page.getByTestId('seq-step-status')).toHaveText(['sent', 'sent']);
  await page.screenshot({ path: 'test-results/sequence-run.png', fullPage: true });
});
