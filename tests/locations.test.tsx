import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import Basins from '../packages/dashboard/src/basins/Basins';
import * as api from '../packages/dashboard/src/basins/api';
import { renderDashboard } from './harness';

vi.mock('../packages/dashboard/src/basins/api', async (original) => ({
  ...(await original<typeof api>()),
  fetchBasinsData: vi.fn(async () => ({ basins: [], hasMore: false })),
  listLocations: vi.fn(async () => [
    { name: 'aws:eu-north-1', isPrivate: false },
    { name: 'aws:us-east-1', isPrivate: false },
  ]),
  getDefaultLocation: vi.fn(async () => ({
    name: 'aws:us-east-1',
    isPrivate: false,
  })),
  setDefaultLocation: vi.fn(async (_s2, name: string) => ({
    name,
    isPrivate: false,
  })),
}));
vi.mock('../packages/dashboard/src/ui/use-toast', () => ({
  toast: vi.fn(),
  setToastSink: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

it('shows the account default in the create dialog and updates it after a change', async () => {
  renderDashboard(<Basins />, {
    capabilities: { locations: true, storageClasses: true },
  });
  const user = userEvent.setup();
  const picker = await screen.findByRole('combobox', {
    name: 'Default location',
  });
  await within(picker).findByText('aws:us-east-1');

  await user.click(picker);
  await user.click(
    await screen.findByRole('option', { name: 'aws:eu-north-1' })
  );
  await within(picker).findByText('aws:eu-north-1');
  expect(vi.mocked(api.setDefaultLocation).mock.calls[0]?.[1]).toBe(
    'aws:eu-north-1'
  );

  await user.click(screen.getByRole('button', { name: 'Create Basin' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('combobox', { name: 'Location' }));
  await screen.findByRole('option', {
    name: 'Account default (aws:eu-north-1)',
  });
  expect(api.getDefaultLocation).toHaveBeenCalledTimes(1);
});
