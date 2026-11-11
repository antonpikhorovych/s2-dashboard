'use client';

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  ChevronRight,
  Copy,
  Check,
  Info,
  Clock,
  X,
  Terminal,
} from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../lib/utils';
import { SIZE_BODY, SIZE_CONTROL, SIZE_LABEL } from './studio-type';
import { formatUTCTime, formatUTCTimestamp } from '../lib/date-time';
import { meteredBytes } from '@s2-dev/streamstore';

export interface StreamRecord {
  seqNum: bigint | number;
  timestamp: Date | bigint | number;
  body: string;
  headers?: ReadonlyArray<readonly [string, string]>;
}

export interface StatusMessage {
  type: 'info' | 'success' | 'warning' | 'error';
  text: string;
  timestamp: Date;
}

interface RecordItemProps {
  record: StreamRecord;
  defaultExpanded?: boolean;
}

function tryParseJson(text: string): { isJson: boolean; formatted: string } {
  try {
    const parsed = JSON.parse(text);
    return { isJson: true, formatted: JSON.stringify(parsed, null, 2) };
  } catch {
    return { isJson: false, formatted: text };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function getCommandType(
  headers?: ReadonlyArray<readonly [string, string]>
): 'trim' | 'fence' | null {
  if (!headers || headers.length !== 1) {
    return null;
  }

  const [name, value] = headers[0];
  if (name !== '') {
    return null;
  }

  if (value === 'trim' || value === 'fence') {
    return value;
  }

  return null;
}

function parseTrimTargetSeqNum(body: string): number | null {
  const decimal = body.trim();
  if (/^\d+$/.test(decimal)) {
    const parsed = Number.parseInt(decimal, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length % 4 === 0) {
    try {
      const decoded = atob(body);
      if (decoded.length === 8) {
        const bytes = new Uint8Array(8);
        for (let i = 0; i < 8; i += 1) {
          bytes[i] = decoded.charCodeAt(i);
        }
        const parsed = new DataView(bytes.buffer).getBigUint64(0, false);
        return parsed <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(parsed)
          : null;
      }
    } catch {
      // not valid base64; continue with other parsers
    }
  }

  if (body.length >= 8) {
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) {
      const code = body.charCodeAt(i);
      if (code > 255) {
        return null;
      }
      bytes[i] = code;
    }
    const parsed = new DataView(bytes.buffer).getBigUint64(0, false);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }

  return null;
}

function RecordItem({ record, defaultExpanded = false }: RecordItemProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const seqNum = Number(record.seqNum);
  const timestamp =
    record.timestamp instanceof Date
      ? record.timestamp
      : new Date(Number(record.timestamp));
  const timeString = formatUTCTimestamp(timestamp);
  const shortTime = formatUTCTime(timestamp);
  const { isJson, formatted } = tryParseJson(record.body);
  const preview =
    record.body.slice(0, 100) + (record.body.length > 100 ? '...' : '');
  const hasHeaders = record.headers && record.headers.length > 0;
  const commandType = getCommandType(record.headers);
  const trimTargetSeqNum =
    commandType === 'trim' ? parseTrimTargetSeqNum(record.body) : null;
  const commandSummary =
    commandType === 'trim'
      ? trimTargetSeqNum !== null
        ? `trim through #${trimTargetSeqNum}`
        : 'trim command'
      : commandType === 'fence'
        ? record.body
          ? `set fence token "${record.body}"`
          : 'clear fencing token'
        : null;
  const size = meteredBytes(
    record as unknown as Parameters<typeof meteredBytes>[0]
  );

  const copyBody = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(record.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      return;
    }
  };

  return (
    <div className="group">
      <div
        className="hover:bg-muted/60 flex cursor-pointer items-center gap-2 px-4 py-2 transition-colors dark:hover:bg-white/[0.03]"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground/50 h-3.5 w-3.5 shrink-0 transition-transform duration-150',
            isExpanded && 'text-muted-foreground rotate-90'
          )}
        />
        <span
          className={cn(
            'text-muted-foreground w-12 shrink-0 text-right',
            SIZE_BODY,
            'tabular-nums'
          )}
        >
          {seqNum}
        </span>
        <span
          className={cn(
            'text-muted-foreground/70 w-[96px] shrink-0 sm:w-48',
            SIZE_BODY,
            'whitespace-nowrap tabular-nums'
          )}
        >
          <span className="sm:hidden">{shortTime}</span>
          <span className="hidden sm:inline">{timeString}</span>
        </span>
        <span className="hidden w-20 shrink-0 items-center gap-1 sm:flex">
          {isJson && (
            <span
              className={cn(
                'shrink-0 rounded-sm bg-blue-500/10 px-1 py-px',
                SIZE_LABEL,
                'font-medium text-blue-700 dark:text-blue-400'
              )}
              title="Body parses as JSON"
            >
              json
            </span>
          )}
          {commandType && (
            <span
              className={cn(
                'shrink-0 rounded-sm bg-amber-500/10 px-1 py-px',
                SIZE_LABEL,
                'font-medium text-amber-700 dark:text-amber-300'
              )}
              title={commandSummary ?? `${commandType} command`}
            >
              {commandType}
            </span>
          )}
          {hasHeaders && !commandType && (
            <span
              className={cn(
                'shrink-0 rounded-sm bg-purple-500/10 px-1 py-px',
                SIZE_LABEL,
                'font-medium text-purple-700 dark:text-purple-300'
              )}
              title={`${record.headers!.length} header(s)`}
            >
              {record.headers!.length} hdr
            </span>
          )}
        </span>
        <span
          className={cn(
            'text-muted-foreground/70 hidden w-14 shrink-0 text-right sm:block',
            SIZE_BODY,
            'tabular-nums'
          )}
        >
          {formatBytes(size)}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!isExpanded && (
            <span
              className={cn(
                SIZE_CONTROL,
                'truncate font-mono',
                commandType
                  ? 'text-amber-700/80 dark:text-amber-300/80'
                  : 'text-foreground/50'
              )}
            >
              {commandSummary ?? preview}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="hidden h-5 w-5 shrink-0 rounded-sm p-0 opacity-0 transition-opacity group-hover:opacity-100 sm:inline-flex"
          onClick={copyBody}
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Copy className="text-muted-foreground/50 h-3 w-3" />
          )}
        </Button>
      </div>
      {isExpanded && (
        <div className="border-border/20 ml-[72px] border-l py-3 pr-4 pl-4">
          {commandType && (
            <div className="mb-2 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
              <div
                className={cn(
                  'mb-1',
                  SIZE_LABEL,
                  'font-medium text-amber-700/80 dark:text-amber-300/80'
                )}
              >
                Command
              </div>
              <div
                className={cn(
                  'font-mono',
                  SIZE_CONTROL,
                  'text-amber-700/80 dark:text-amber-200/90'
                )}
              >
                {commandType === 'trim' && trimTargetSeqNum !== null
                  ? `Trim through sequence #${trimTargetSeqNum}`
                  : commandType === 'trim'
                    ? 'Trim command'
                    : record.body
                      ? `Fencing token set to "${record.body}"`
                      : 'Fencing token cleared'}
              </div>
            </div>
          )}
          {hasHeaders && (
            <div className="mb-2">
              <div
                className={cn(
                  'text-muted-foreground/50 mb-1',
                  SIZE_LABEL,
                  'font-medium'
                )}
              >
                Headers
              </div>
              {record.headers!.map(([key, value], i) => (
                <div
                  key={i}
                  className={cn('flex gap-1.5 py-0.5 font-mono', SIZE_CONTROL)}
                >
                  <span className="text-muted-foreground">{key}:</span>
                  <span className="text-foreground/80 break-all">{value}</span>
                </div>
              ))}
            </div>
          )}
          {record.body && commandType !== 'trim' && (
            <pre
              className={cn(
                'bg-muted/70 text-foreground/80 max-h-[400px] overflow-auto rounded-md p-2 font-mono',
                SIZE_CONTROL,
                'leading-relaxed break-all whitespace-pre-wrap dark:bg-black/20'
              )}
            >
              {isJson ? formatted : record.body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface StatusItemProps {
  message: StatusMessage;
}

function StatusItem({ message }: StatusItemProps) {
  const timeString = formatUTCTime(message.timestamp);

  const colorClass = {
    info: 'text-blue-700 dark:text-blue-400',
    success: 'text-emerald-700 dark:text-emerald-400',
    warning: 'text-amber-700 dark:text-amber-400',
    error: 'text-red-700 dark:text-red-400',
  }[message.type];

  const IconComponent = {
    info: Info,
    success: Check,
    warning: Clock,
    error: X,
  }[message.type];

  const bgClass = {
    info: 'bg-blue-500/10 dark:bg-blue-400/5',
    success: 'bg-emerald-500/10 dark:bg-emerald-500/5',
    warning: 'bg-amber-500/10 dark:bg-amber-400/5',
    error: 'bg-red-500/10 dark:bg-red-400/5',
  }[message.type];

  return (
    <div className={cn('flex items-center gap-2 px-4 py-2', bgClass)}>
      <IconComponent className={cn('h-3 w-3 shrink-0', colorClass)} />
      <span
        className={cn(
          'text-muted-foreground/70 shrink-0',
          SIZE_LABEL,
          'tabular-nums'
        )}
      >
        {timeString}
      </span>
      <span className={cn(SIZE_BODY, colorClass)}>{message.text}</span>
    </div>
  );
}

export interface RecordViewHandle {
  addRecord: (record: StreamRecord) => void;
  addStatus: (type: StatusMessage['type'], text: string) => void;
  clear: () => void;
}

interface RecordViewProps {
  maxRecords?: number;
}

type ItemType =
  | { type: 'record'; id: string; data: StreamRecord }
  | { type: 'status'; id: string; data: StatusMessage };

let statusIdCounter = 0;

export const RecordView = forwardRef<RecordViewHandle, RecordViewProps>(
  function RecordView({ maxRecords = 500 }, ref) {
    const [items, setItems] = useState<ItemType[]>([]);
    const [showLegend, setShowLegend] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const shouldAutoScrollRef = useRef(true);

    const handleScroll = useCallback(() => {
      if (!scrollRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      shouldAutoScrollRef.current =
        scrollHeight - scrollTop - clientHeight < 50;
    }, []);

    useEffect(() => {
      if (shouldAutoScrollRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [items]);

    const addRecord = useCallback(
      (record: StreamRecord) => {
        setItems((prev) => {
          const newItems = [
            ...prev,
            { type: 'record' as const, id: `r-${record.seqNum}`, data: record },
          ];
          if (newItems.length > maxRecords) {
            return newItems.slice(-maxRecords);
          }
          return newItems;
        });
      },
      [maxRecords]
    );

    const addStatus = useCallback(
      (type: StatusMessage['type'], text: string) => {
        setItems((prev) => [
          ...prev,
          {
            type: 'status' as const,
            id: `s-${++statusIdCounter}`,
            data: { type, text, timestamp: new Date() },
          },
        ]);
      },
      []
    );

    const clear = useCallback(() => {
      setItems([]);
    }, []);

    useImperativeHandle(ref, () => ({ addRecord, addStatus, clear }), [
      addRecord,
      addStatus,
      clear,
    ]);

    return (
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="bg-muted/40 h-full overflow-y-auto"
        style={{ scrollbarGutter: 'stable' }}
      >
        {items.length > 0 && (
          <div className="bg-muted sticky top-0 z-10">
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="w-3.5 shrink-0" />
              <span
                className={cn(
                  'text-muted-foreground w-12 shrink-0 text-right',
                  SIZE_LABEL
                )}
              >
                Seq
              </span>
              <span
                className={cn(
                  'text-muted-foreground w-[96px] shrink-0 sm:w-48',
                  SIZE_LABEL
                )}
              >
                Time
              </span>
              <span
                className={cn(
                  'text-muted-foreground hidden w-20 shrink-0 sm:block',
                  SIZE_LABEL
                )}
              >
                Type
              </span>
              <span
                className={cn(
                  'text-muted-foreground hidden w-14 shrink-0 text-right sm:block',
                  SIZE_LABEL
                )}
              >
                Size
              </span>
              <span
                className={cn(
                  'text-muted-foreground min-w-0 flex-1',
                  SIZE_LABEL
                )}
              >
                Preview
              </span>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'text-muted-foreground h-6 rounded-sm px-2',
                  SIZE_LABEL
                )}
                onClick={() => setShowLegend((prev) => !prev)}
              >
                <Info className="mr-1 h-3 w-3" />
                {showLegend ? 'Hide' : 'Legend'}
              </Button>
            </div>
            {showLegend && (
              <div
                className={cn(
                  'border-border/30 text-muted-foreground grid gap-1 border-t px-4 py-3',
                  SIZE_LABEL
                )}
              >
                <div>
                  <span className="text-foreground/80 font-mono">seq</span> =
                  stream sequence number.
                </div>
                <div>
                  <span className="text-foreground/80 font-mono">time</span> =
                  record timestamp (UTC).
                </div>
                <div>
                  <span
                    className={cn(
                      'rounded-sm bg-blue-500/10 px-1 py-px',
                      SIZE_LABEL,
                      'font-medium text-blue-700 dark:text-blue-400'
                    )}
                  >
                    json
                  </span>{' '}
                  body parses as JSON.
                </div>
                <div>
                  <span
                    className={cn(
                      'rounded-sm bg-amber-500/10 px-1 py-px',
                      SIZE_LABEL,
                      'font-medium text-amber-700 dark:text-amber-300'
                    )}
                  >
                    trim
                  </span>{' '}
                  trim command; preview includes target sequence when available.
                </div>
                <div>
                  <span
                    className={cn(
                      'rounded-sm bg-amber-500/10 px-1 py-px',
                      SIZE_LABEL,
                      'font-medium text-amber-700 dark:text-amber-300'
                    )}
                  >
                    fence
                  </span>{' '}
                  fencing command; preview shows token set/clear action.
                </div>
                <div>
                  <span
                    className={cn(
                      'rounded-sm bg-purple-500/10 px-1 py-px',
                      SIZE_LABEL,
                      'font-medium text-purple-700 dark:text-purple-300'
                    )}
                  >
                    n hdr
                  </span>{' '}
                  number of record headers (non-command records).
                </div>
                <div>
                  <span className="text-foreground/80 font-mono">size</span> =
                  metered record size in bytes.
                </div>
              </div>
            )}
          </div>
        )}
        {items.length === 0 ? (
          <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-2">
            <Terminal className="h-10 w-10 stroke-[1.2]" />
            <p className={cn('text-muted-foreground', SIZE_BODY)}>
              Waiting for records
            </p>
            <p className={cn('text-muted-foreground/60', SIZE_LABEL)}>
              Read Once or Stream to get started
            </p>
          </div>
        ) : (
          <div className="divide-border/20 divide-y">
            {items.map((item) =>
              item.type === 'record' ? (
                <RecordItem key={item.id} record={item.data} />
              ) : (
                <StatusItem key={item.id} message={item.data} />
              )
            )}
          </div>
        )}
      </div>
    );
  }
);
