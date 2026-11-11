import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReadBatch, ReadSession } from '@s2-dev/streamstore';
import Studio from '../packages/dashboard/src/basins/Studio';
import * as api from '../packages/dashboard/src/basins/api';
import { toast } from '../packages/dashboard/src/ui/use-toast';
import { deferred, renderDashboard } from './harness';

vi.mock('../packages/dashboard/src/basins/api', async (original) => ({
  ...(await original<typeof api>()),
  fetchStreamsData: vi.fn(),
  checkStreamTail: vi.fn(),
  readStreamBatch: vi.fn(),
  openReadSession: vi.fn(),
  appendToStream: vi.fn(),
}));
vi.mock('../packages/dashboard/src/ui/use-toast', () => ({
  toast: vi.fn(),
  setToastSink: vi.fn(),
}));
const recordView = vi.hoisted(() => ({
  clear: vi.fn(),
  addRecord: vi.fn(),
  addStatus: vi.fn(),
  mounts: { count: 0 },
}));
vi.mock('../packages/dashboard/src/basins/RecordView', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return {
    RecordView: forwardRef(function RecordView(_props, ref) {
      useImperativeHandle(ref, () => recordView);
      useEffect(() => {
        recordView.mounts.count += 1;
      }, []);
      return <div />;
    }),
  };
});

const stream = (name: string) => ({
  name,
  createdAt: new Date(0),
  cipher: 'aes-256-gcm' as const,
});
const route = (basinId: string, name = 'events') => ({
  pathname: `/dashboard/basins/${basinId}/studio`,
  basinId,
  searchParams: new URLSearchParams({ stream: name }),
});

beforeEach(() => {
  vi.clearAllMocks();
  recordView.mounts.count = 0;
  vi.mocked(api.fetchStreamsData).mockImplementation(async (_s2, input) => ({
    streams: [stream(input.prefix ?? 'events')],
    hasMore: false,
  }));
  vi.mocked(api.checkStreamTail).mockResolvedValue({
    tail: { seqNum: 0, timestamp: new Date(0) },
  });
  vi.mocked(api.appendToStream).mockResolvedValue({
    start: { seqNum: 0, timestamp: new Date(0) },
    end: { seqNum: 1, timestamp: new Date(0) },
    tail: { seqNum: 1, timestamp: new Date(0) },
  });
});

it('loads encryption metadata for a URL-selected stream beyond the first 50', async () => {
  vi.mocked(api.fetchStreamsData).mockImplementation(async (_s2, input) => ({
    streams: input.prefix
      ? [stream('later-stream')]
      : Array.from({ length: 50 }, (_, n) => ({
          name: `first-${n}`,
          createdAt: new Date(0),
        })),
    hasMore: !input.prefix,
  }));
  renderDashboard(<Studio />, { route: route('basin-a', 'later-stream') });
  await screen.findByPlaceholderText('base64 key');
  expect(api.fetchStreamsData).toHaveBeenCalledWith(expect.anything(), {
    basinId: 'basin-a',
    prefix: 'later-stream',
    limit: 1,
  });
});

it.each(['basin', 'account', 'stream'])(
  'stops streaming and clears the key on a %s change',
  async (change) => {
    const pending = deferred<ReadSession<'string'>>();
    vi.mocked(api.openReadSession).mockReturnValue(pending.promise);
    const { updateHost, client } = renderDashboard(<Studio />, {
      route: route('basin-a'),
    });
    const user = userEvent.setup();
    await user.type(
      await screen.findByPlaceholderText('base64 key'),
      'YWJjZA=='
    );
    await user.click(screen.getByRole('button', { name: 'Stream' }));
    await waitFor(() => expect(api.openReadSession).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.openReadSession).mock.calls[0][5]?.signal;
    // Cache the target basin just as a previously visited route would be cached.
    client.setQueryData(['studio-streams', 'account-a', 'basin-b'], {
      streams: [stream('events')],
      hasMore: false,
    });
    updateHost(
      change === 'account'
        ? { scopeKey: 'account-b' }
        : {
            route: route(
              change === 'basin' ? 'basin-b' : 'basin-a',
              change === 'stream' ? 'other' : 'events'
            ),
          }
    );
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText('base64 key') as HTMLInputElement).value
      ).toBe('')
    );
    const previousRecords = recordView.addRecord.mock.calls.length;
    await act(async () =>
      pending.resolve({
        async *[Symbol.asyncIterator]() {
          yield {
            seqNum: 4,
            timestamp: new Date(0),
            body: 'old-basin',
            headers: [],
          };
        },
      } as unknown as ReadSession<'string'>)
    );
    expect(recordView.addRecord).toHaveBeenCalledTimes(previousRecords);
  }
);

it('ignores a late one-shot read after changing streams', async () => {
  const pending = deferred<ReadBatch<'string'>>();
  vi.mocked(api.readStreamBatch).mockReturnValue(pending.promise);
  const { updateHost } = renderDashboard(<Studio />, {
    route: route('basin-a'),
  });
  const user = userEvent.setup();
  await screen.findByPlaceholderText('base64 key');
  await user.click(screen.getByRole('button', { name: 'Read Once' }));
  await waitFor(() => expect(api.readStreamBatch).toHaveBeenCalledOnce());
  updateHost({ route: route('basin-a', 'other') });
  await waitFor(() =>
    expect(screen.getByTitle('Copy s2://basin-a/other')).toBeTruthy()
  );
  recordView.addRecord.mockClear();
  await act(async () =>
    pending.resolve({
      records: [
        { seqNum: 5, timestamp: new Date(0), body: 'old-stream', headers: [] },
      ],
    } as ReadBatch<'string'>)
  );
  expect(recordView.addRecord).not.toHaveBeenCalled();
});

it('does not read when the start position is invalid', async () => {
  renderDashboard(<Studio />, { route: route('basin-a') });
  const user = userEvent.setup();
  await screen.findByPlaceholderText('base64 key');
  await user.click(screen.getByRole('button', { name: /Read settings/ }));
  const startValue = screen.getByPlaceholderText('10');
  await user.clear(startValue);
  await user.type(startValue, 'abc');
  await screen.findByText('Tail offset must be a whole number.');
  await user.click(screen.getByRole('button', { name: 'Read Once' }));
  expect(api.readStreamBatch).not.toHaveBeenCalled();
});

it('does not append when a supplied match sequence is invalid', async () => {
  renderDashboard(<Studio />, { route: route('basin-a') });
  const user = userEvent.setup();
  await screen.findByPlaceholderText('base64 key');
  await user.type(screen.getByPlaceholderText('single record body'), 'payload');
  await user.click(screen.getByRole('button', { name: /Concurrency/ }));
  await user.type(
    screen.getByRole('textbox', { name: 'Match sequence number' }),
    '123abc'
  );
  await user.click(screen.getByRole('button', { name: 'Append' }));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Append failed',
        description: expect.stringContaining('non-negative safe integer'),
      })
    )
  );
  expect(api.appendToStream).not.toHaveBeenCalled();
});

it('sends the session fencing token with an append', async () => {
  renderDashboard(<Studio />, { route: route('basin-a') });
  const user = userEvent.setup();
  await screen.findByPlaceholderText('base64 key');
  await user.type(screen.getByLabelText('Fencing token'), 'tok-1');
  await user.type(screen.getByPlaceholderText('single record body'), 'payload');
  await user.click(screen.getByRole('button', { name: 'Append' }));
  await waitFor(() =>
    expect(api.appendToStream).toHaveBeenCalledWith(
      expect.anything(),
      'basin-a',
      'events',
      expect.objectContaining({ fencingToken: 'tok-1' }),
      undefined
    )
  );
});

it('keeps the log streaming while an append runs', async () => {
  const queue: Array<{
    seqNum: number;
    timestamp: Date;
    body: string;
    headers: never[];
  }> = [];
  let resume: (() => void) | null = null;
  vi.mocked(api.openReadSession).mockResolvedValue({
    [Symbol.asyncIterator]: () => ({
      async next() {
        while (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
        return { done: false, value: queue.shift() };
      },
    }),
  } as unknown as ReadSession<'string'>);
  const deliver = async (body: string, seqNum: number) => {
    await act(async () => {
      queue.push({ seqNum, timestamp: new Date(0), body, headers: [] });
      const waiting = resume;
      resume = null;
      waiting?.();
    });
  };

  renderDashboard(<Studio />, { route: route('basin-a') });
  const user = userEvent.setup();
  await screen.findByPlaceholderText('base64 key');
  await user.click(screen.getByRole('button', { name: 'Stream' }));
  await waitFor(() => expect(api.openReadSession).toHaveBeenCalledOnce());
  const signal = vi.mocked(api.openReadSession).mock.calls[0][5]?.signal;

  await deliver('first', 1);
  await waitFor(() =>
    expect(recordView.addRecord).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'first' })
    )
  );
  recordView.clear.mockClear();

  await user.type(screen.getByPlaceholderText('single record body'), 'payload');
  await user.click(screen.getByRole('button', { name: 'Append' }));
  await waitFor(() => expect(api.appendToStream).toHaveBeenCalledOnce());

  // Appending must not end the open read or remount the log.
  expect(signal?.aborted).toBe(false);
  expect(recordView.clear).not.toHaveBeenCalled();
  expect(recordView.mounts.count).toBe(1);

  // The same read keeps delivering records after the append.
  await deliver('second', 2);
  await waitFor(() =>
    expect(recordView.addRecord).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'second' })
    )
  );
  expect(recordView.addRecord).toHaveBeenCalledWith(
    expect.objectContaining({ body: 'first' })
  );
});

it.each(['json', 'jsonl'])(
  'loads text as one body after a %s file',
  async (extension) => {
    renderDashboard(<Studio />, { route: route('basin-a') });
    const user = userEvent.setup();
    await screen.findByPlaceholderText('base64 key');
    const input = screen.getByLabelText('Load file');
    fireEvent.change(input, {
      target: {
        files: [{ name: `data.${extension}`, text: async () => '["one"]' }],
      },
    });
    await screen.findByDisplayValue('["one"]');
    fireEvent.change(input, {
      target: {
        files: [{ name: 'data.txt', text: async () => 'first\nsecond' }],
      },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByPlaceholderText(
            'single record body'
          ) as HTMLTextAreaElement
        ).value
      ).toBe('first\nsecond')
    );
    await user.click(screen.getByRole('button', { name: 'Append' }));
    await waitFor(() =>
      expect(api.appendToStream).toHaveBeenCalledWith(
        expect.anything(),
        'basin-a',
        'events',
        expect.objectContaining({ records: [{ body: 'first\nsecond' }] }),
        undefined
      )
    );
  }
);
