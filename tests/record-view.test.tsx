import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  RecordView,
  type RecordViewHandle,
} from '../packages/dashboard/src/basins/RecordView';

it('keeps a full batch next to status rows and drops only the oldest records', () => {
  const ref = createRef<RecordViewHandle>();
  render(<RecordView ref={ref} maxRecords={3} />);
  const add = (seqNum: number) =>
    ref.current!.addRecord({
      seqNum,
      timestamp: new Date(0),
      body: `body-${seqNum}`,
    });

  act(() => {
    ref.current!.addStatus('info', 'reading');
    [0, 1, 2].forEach(add);
    ref.current!.addStatus('success', 'done');
  });
  expect(screen.getByText('body-0')).toBeTruthy();
  expect(screen.queryByText(/dropped/)).toBeNull();

  act(() => add(3));
  expect(screen.queryByText('body-0')).toBeNull();
  expect(screen.getByText('body-1')).toBeTruthy();
  expect(screen.getByText('reading')).toBeTruthy();
  expect(screen.getByText(/1 earlier record\(s\) dropped/)).toBeTruthy();

  act(() => ref.current!.clear());
  act(() => add(4));
  expect(screen.queryByText(/dropped/)).toBeNull();
});
