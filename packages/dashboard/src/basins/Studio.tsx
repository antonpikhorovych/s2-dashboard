'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  AppendAck,
  ReadFrom,
  ReadInput,
  ReadLimits,
  RangeNotSatisfiableError,
  StreamPosition,
} from '@s2-dev/streamstore';
import { useQuery } from 'react-query';
import { toast } from '../ui/use-toast';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import { Checkbox } from '../ui/checkbox';
import {
  Copy,
  Check,
  Calendar as CalendarIcon,
  ChevronDown,
  Eye,
  EyeOff,
  ExternalLink,
  Eraser,
  Loader2,
  Paperclip,
  Play,
  RefreshCw,
  Send,
  Square,
} from 'lucide-react';
import EmptyList from '../components/EmptyList';
import { Calendar } from '../ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../lib/utils';
import {
  formatUTCDateTime,
  parseUTCTimestamp,
  toUTCDateTimeValue,
} from '../lib/date-time';
import { buildReadCurlCommand, buildAppendCurlCommand } from './studio-curl';
import { parseMatchSeqNum, parseRecordTimestamp } from './studio-input';
import {
  appendToStream,
  checkStreamTail,
  fenceStream,
  fetchStreamsData,
  openReadSession,
  readStreamBatch,
  trimStream,
  type StudioAppendInput,
  type StudioAppendRecordInput,
} from './api';
import { RecordView, RecordViewHandle } from './RecordView';
import { useDashboardHost } from './dashboard-host';
import { StreamCombobox } from './StreamCombobox';
import { BasinCombobox } from './BasinCombobox';

type ReadStartMode = 'tailOffset' | 'seqNum' | 'timestamp';
type AppendInputMode = 'single' | 'lines' | 'json-array';

const STUDIO_DOCS = {
  studio: 'https://s2.dev/docs/studio',
  reads: 'https://s2.dev/docs/concepts/reads',
  appends: 'https://s2.dev/docs/concepts/appends',
  concurrency: 'https://s2.dev/docs/concepts/concurrency-controls',
  retention: 'https://s2.dev/docs/concepts/retention',
  limits: 'https://s2.dev/docs/platform/limits',
} as const;

const BODY = 'text-[14px] leading-5';
const LABEL = 'text-[12px] leading-4 text-muted-foreground';
const HEADING = 'text-[14px] leading-5 font-semibold';
const CONTROL = 'text-[13px] leading-5';

function DocsLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[12px] whitespace-nowrap underline decoration-dotted underline-offset-2 transition-colors',
        className
      )}
    >
      <span>{label}</span>
      <ExternalLink className="h-2.5 w-2.5 opacity-70" />
    </a>
  );
}

function parseHeaders(
  value: unknown
): ReadonlyArray<readonly [string, string]> | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const headers = value
      .map((item) => {
        if (!Array.isArray(item) || item.length !== 2) {
          return undefined;
        }
        return [String(item[0]), String(item[1])] as const;
      })
      .filter((item): item is readonly [string, string] => Boolean(item));
    return headers.length > 0 ? headers : undefined;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, headerValue]) => [key, String(headerValue)] as const
    );
    return entries.length > 0 ? entries : undefined;
  }

  return undefined;
}

function formatPosition(position?: StreamPosition): string {
  if (!position) {
    return 'n/a';
  }
  return `#${position.seqNum} @ ${formatUTCDateTime(position.timestamp)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTimestampDisplay(value: string): string {
  const parsed = parseUTCTimestamp(value);
  if (!parsed) {
    return 'Pick timestamp';
  }
  return formatUTCDateTime(parsed);
}

function toEpochMillis(value: number | Date): number {
  return value instanceof Date ? value.getTime() : value;
}

function describeReadFrom(from: ReadFrom | undefined): string {
  if (from && 'seqNum' in from) {
    return `seq ${from.seqNum}`;
  }
  if (from && 'timestamp' in from) {
    return `timestamp ${toEpochMillis(from.timestamp)}`;
  }
  return 'the requested start';
}

function decodeQueryParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface StudioFieldProps {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  error?: string;
  children: ReactNode;
}

function StudioField({
  label,
  hint,
  htmlFor,
  error,
  children,
}: StudioFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className={cn(LABEL, 'block w-fit')}>
        {label}
      </Label>
      {children}
      {error ? (
        <p className={cn(LABEL, 'text-destructive')}>{error}</p>
      ) : (
        hint && <p className={LABEL}>{hint}</p>
      )}
    </div>
  );
}

function StudioSection({
  title,
  summary,
  error,
  children,
}: {
  title: string;
  summary?: string;
  error?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The fields show their own errors once the section is open.
  const caption = open ? summary : (error ?? summary);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn(LABEL, 'font-medium')}>{title}</span>
          {caption && (
            <span
              className={cn(
                LABEL,
                'truncate tabular-nums',
                !open && error ? 'text-destructive' : 'text-muted-foreground/70'
              )}
            >
              {caption}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && <div className="space-y-3 pt-3">{children}</div>}
    </div>
  );
}

function CopyIconButton({
  label,
  copied,
  onClick,
}: {
  label: string;
  copied: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground h-8 w-8 rounded-sm"
          aria-label={label}
          onClick={onClick}
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

function PositionRows({
  rows,
}: {
  rows: Array<[string, StreamPosition | undefined]>;
}) {
  return (
    <div className="space-y-0.5 text-[11px] tabular-nums">
      {rows.map(([label, position]) => (
        <div key={label} className="flex justify-between gap-3">
          <span className={LABEL}>{label}</span>
          <span className="text-muted-foreground">
            {formatPosition(position)}
          </span>
        </div>
      ))}
    </div>
  );
}

function parseAppendRecords(
  mode: AppendInputMode,
  payload: string
): StudioAppendRecordInput[] {
  if (!payload.trim()) {
    throw new Error('Append payload cannot be empty');
  }

  if (mode === 'single') {
    return [{ body: payload }];
  }

  if (mode === 'lines') {
    return payload
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ body: line }));
  }

  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('JSON array mode requires an array payload');
  }

  return parsed.map((item, index) => {
    if (typeof item === 'string') {
      return { body: item };
    }

    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid record at index ${index}`);
    }

    const body = (item as { body?: unknown }).body;
    if (typeof body !== 'string') {
      throw new Error(`Record ${index} must include a string body`);
    }

    return {
      body,
      headers: parseHeaders((item as { headers?: unknown }).headers),
      timestamp: parseRecordTimestamp(
        (item as { timestamp?: unknown }).timestamp,
        index
      ),
    };
  });
}

export default function Studio(): JSX.Element {
  const { scopeKey, route } = useDashboardHost();
  // Hosts may reuse the view across routes. Do not carry reads, keys or pending
  // destructive actions into a different account or basin.
  return <StudioSession key={JSON.stringify([scopeKey, route.basinId])} />;
}

function StudioSession(): JSX.Element | null {
  const { getToken, getClient, endpoints, scopeKey, route, navigate } =
    useDashboardHost();
  const { searchParams } = route;
  const basinId = route.basinId ?? '';

  const [selectedStream, setSelectedStream] = useState('');
  const [concurrencyOpen, setConcurrencyOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(true);

  const [readStartMode, setReadStartMode] =
    useState<ReadStartMode>('tailOffset');
  const [readFromValue, setReadFromValue] = useState('10');
  const [readLimitCount, setReadLimitCount] = useState('');
  const [readWaitSecs, setReadWaitSecs] = useState('');
  const [readClamp, setReadClamp] = useState(true);
  const [ignoreCommandRecords, setIgnoreCommandRecords] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [recordsReceived, setRecordsReceived] = useState(0);
  const [streamStartedAtMs, setStreamStartedAtMs] = useState<number | null>(
    null
  );
  const [lastRecordAtMs, setLastRecordAtMs] = useState<number | null>(null);

  const [appendMode, setAppendMode] = useState<AppendInputMode>('single');
  const [appendPayload, setAppendPayload] = useState('');
  const [appendMatchSeqNum, setAppendMatchSeqNum] = useState('');
  const [fencingToken, setFencingToken] = useState('');
  const [appending, setAppending] = useState(false);
  const [lastAppendAck, setLastAppendAck] = useState<AppendAck | null>(null);
  const [tailInfo, setTailInfo] = useState<StreamPosition | undefined>(
    undefined
  );
  const [tailLoading, setTailLoading] = useState(false);
  const [trimSeqNum, setTrimSeqNum] = useState('');
  const [trimConfirmSeqNum, setTrimConfirmSeqNum] = useState<number | null>(
    null
  );
  const [nextFenceToken, setNextFenceToken] = useState('');
  const [runningCommand, setRunningCommand] = useState(false);
  const [lastCommandAck, setLastCommandAck] = useState<AppendAck | null>(null);

  const [uriCopied, setUriCopied] = useState(false);
  const [readCurlCopied, setReadCurlCopied] = useState(false);
  const [streamCurlCopied, setStreamCurlCopied] = useState(false);
  const [appendCurlCopied, setAppendCurlCopied] = useState(false);

  const [encryptionKey, setEncryptionKey] = useState('');
  const [showEncryptionKey, setShowEncryptionKey] = useState(false);

  const recordViewRef = useRef<RecordViewHandle | null>(null);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const previousStreamRef = useRef<string>('');
  const sessionAbortRef = useRef(new AbortController());

  const resolveToken = useCallback(async (): Promise<string | null> => {
    return await getToken();
  }, [getToken]);

  const {
    data: streamsResponse,
    isLoading: isLoadingStreams,
    refetch: refetchStreams,
  } = useQuery(
    ['studio-streams', scopeKey, basinId],
    async () => {
      const s2 = await getClient();
      if (s2 === null) {
        throw new Error('No auth token found');
      }
      return fetchStreamsData(s2, { basinId, limit: 50 });
    },
    {
      enabled: Boolean(basinId),
      refetchOnWindowFocus: false,
      retry: false,
      onError: (error: unknown) => {
        toast({
          title: 'Error loading streams',
          description:
            error instanceof Error ? error.message : 'Unknown error occurred',
          variant: 'destructive',
        });
      },
    }
  );

  const streams = useMemo(
    () => streamsResponse?.streams ?? [],
    [streamsResponse]
  );
  const { data: selectedStreamInfo, refetch: refetchSelectedStream } = useQuery(
    ['studio-stream', scopeKey, basinId, selectedStream],
    async () => {
      const s2 = await getClient();
      if (s2 === null) throw new Error('No auth token found');
      // StreamConfig does not include the cipher. An exact prefix lookup finds
      // metadata even when the selected stream is beyond the first list page.
      const result = await fetchStreamsData(s2, {
        basinId,
        prefix: selectedStream,
        limit: 1,
      });
      return (
        result.streams.find((stream) => stream.name === selectedStream) ?? null
      );
    },
    {
      enabled: Boolean(basinId && selectedStream),
      initialData: streams.find((stream) => stream.name === selectedStream),
      refetchOnWindowFocus: false,
      retry: false,
      onError: (error: unknown) => {
        toast({
          title: 'Error loading selected stream',
          description:
            error instanceof Error ? error.message : 'Unknown error occurred',
          variant: 'destructive',
        });
      },
    }
  );

  useEffect(() => {
    const streamFromUrlParam = searchParams.get('stream');
    if (streamFromUrlParam) {
      const decodedStreamFromUrl = decodeQueryParam(streamFromUrlParam);
      const requestedStream =
        streams.find((stream) => stream.name === streamFromUrlParam)?.name ??
        streams.find((stream) => stream.name === decodedStreamFromUrl)?.name ??
        decodedStreamFromUrl;

      if (selectedStream !== requestedStream) {
        queueMicrotask(() => setSelectedStream(requestedStream));
      }

      if (selectedStream === requestedStream && selectedStreamInfo === null) {
        const fallbackStream = streams[0]?.name ?? '';
        const nextParams = new URLSearchParams(searchParams.toString());
        if (fallbackStream) nextParams.set('stream', fallbackStream);
        else nextParams.delete('stream');
        const queryString = nextParams.toString();
        navigate(
          `/dashboard/basins/${encodeURIComponent(basinId)}/studio${queryString ? `?${queryString}` : ''}`,
          { replace: true, scroll: false }
        );
      }
      return;
    }

    if (streams.length === 0) {
      if (selectedStream !== '') {
        queueMicrotask(() => setSelectedStream(''));
      }
      return;
    }

    if (
      !selectedStream ||
      !streams.some((stream) => stream.name === selectedStream)
    ) {
      queueMicrotask(() => setSelectedStream(streams[0].name));
    }
  }, [
    basinId,
    navigate,
    searchParams,
    selectedStream,
    selectedStreamInfo,
    streams,
  ]);

  const updateStreamInUrl = (streamName: string) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('stream', streamName);
    navigate(
      `/dashboard/basins/${encodeURIComponent(basinId)}/studio?${nextParams.toString()}`,
      { replace: true, scroll: false }
    );
  };

  const readStartError = useMemo((): string | null => {
    const trimmed = readFromValue.trim();
    if (readStartMode === 'tailOffset') {
      if (!trimmed) return null;
      return /^-?\d+$/.test(trimmed)
        ? null
        : 'Tail offset must be a whole number.';
    }
    if (readStartMode === 'seqNum') {
      return /^\d+$/.test(trimmed)
        ? null
        : 'Sequence number must be a non-negative integer.';
    }
    return parseUTCTimestamp(trimmed)
      ? null
      : 'Use an ISO date/time (UTC unless an offset is given).';
  }, [readFromValue, readStartMode]);

  const buildReadInput = useCallback((): ReadInput | null => {
    if (readStartError) {
      return null;
    }

    const trimmed = readFromValue.trim();
    let readFrom: ReadFrom;

    if (readStartMode === 'tailOffset') {
      readFrom = { tailOffset: Math.abs(Number.parseInt(trimmed || '10', 10)) };
    } else if (readStartMode === 'seqNum') {
      readFrom = { seqNum: Number(trimmed) };
    } else {
      const parsed = parseUTCTimestamp(trimmed);
      if (!parsed) {
        return null;
      }
      readFrom = { timestamp: parsed };
    }

    let limits: ReadLimits | undefined;
    const parsedCount = Number.parseInt(readLimitCount, 10);
    if (!Number.isNaN(parsedCount) && parsedCount > 0) {
      limits = { count: parsedCount };
    }

    let waitSecs: number | undefined;
    const parsedWaitSecs = Number.parseInt(readWaitSecs, 10);
    if (!Number.isNaN(parsedWaitSecs) && parsedWaitSecs >= 0) {
      waitSecs = parsedWaitSecs;
    }

    const stop =
      limits || waitSecs !== undefined
        ? {
            limits,
            waitSecs,
          }
        : undefined;

    return {
      start: {
        from: readFrom,
        clamp: readClamp,
      },
      stop,
      ignoreCommandRecords,
    };
  }, [
    ignoreCommandRecords,
    readClamp,
    readFromValue,
    readLimitCount,
    readStartError,
    readStartMode,
    readWaitSecs,
  ]);

  const stopStreaming = useCallback(async () => {
    if (streamAbortControllerRef.current) {
      streamAbortControllerRef.current.abort('stream-stopped');
      streamAbortControllerRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    return () => controller.abort();
  }, [selectedStream]);

  useEffect(() => {
    if (previousStreamRef.current === selectedStream) {
      return;
    }

    previousStreamRef.current = selectedStream;

    void stopStreaming();
    recordViewRef.current?.clear();
    setRecordsReceived(0);
    setStreamStartedAtMs(null);
    setLastRecordAtMs(null);
    setAppendMatchSeqNum('');
    setFencingToken('');
    setTrimConfirmSeqNum(null);
    setTrimSeqNum('');
    setNextFenceToken('');
    setAppending(false);
    setRunningCommand(false);
    setTailLoading(false);
    setLastAppendAck(null);
    setLastCommandAck(null);
    setTailInfo(undefined);
    setReadCurlCopied(false);
    setEncryptionKey('');
    setShowEncryptionKey(false);
  }, [selectedStream, stopStreaming]);

  const refreshTail = useCallback(async () => {
    if (!selectedStream) {
      return;
    }

    const signal = sessionAbortRef.current.signal;
    const s2 = await getClient();
    if (signal.aborted) return;
    if (s2 === null) {
      toast({
        title: 'Unable to check tail',
        description: 'No auth token found',
        variant: 'destructive',
      });
      return;
    }

    setTailLoading(true);
    try {
      const response = await checkStreamTail(s2, basinId, selectedStream);
      if (!signal.aborted) setTailInfo(response.tail);
    } catch (error) {
      if (signal.aborted) return;
      toast({
        title: 'Failed to check tail',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (!signal.aborted) setTailLoading(false);
    }
  }, [basinId, getClient, selectedStream]);

  useEffect(() => {
    if (!selectedStream) {
      queueMicrotask(() => setTailInfo(undefined));
      return;
    }
    queueMicrotask(() => void refreshTail());
  }, [refreshTail, selectedStream]);

  useEffect(() => {
    return () => {
      void stopStreaming();
    };
  }, [stopStreaming]);

  const readOnce = async () => {
    if (!selectedStream) {
      return;
    }

    const signal = sessionAbortRef.current.signal;
    const s2 = await getClient();
    if (signal.aborted) return;
    if (s2 === null) {
      toast({
        title: 'Unable to read stream',
        description: 'No auth token found',
        variant: 'destructive',
      });
      return;
    }

    const input = buildReadInput();
    if (!input) {
      return;
    }

    recordViewRef.current?.clear();
    recordViewRef.current?.addStatus(
      'info',
      `Reading from s2://${basinId}/${selectedStream}`
    );

    try {
      const response = await readStreamBatch(
        s2,
        basinId,
        selectedStream,
        input,
        encryptionKey.trim() || undefined
      );
      if (signal.aborted) return;
      response.records.forEach((record) => {
        recordViewRef.current?.addRecord({
          seqNum: record.seqNum,
          timestamp: record.timestamp,
          body: record.body,
          headers: record.headers,
        });
      });
      setRecordsReceived(response.records.length);
      const now = Date.now();
      setStreamStartedAtMs(now);
      setLastRecordAtMs(now);
      recordViewRef.current?.addStatus(
        'success',
        `Read ${response.records.length} record(s)`
      );
      if (response.tail) {
        setTailInfo(response.tail);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof RangeNotSatisfiableError &&
        error.tail &&
        input.start?.clamp
      ) {
        setTailInfo(error.tail);
        recordViewRef.current?.addStatus(
          'info',
          `Start clamped to tail (seq ${error.tail.seqNum}). No records at or after ${describeReadFrom(input.start.from)}.`
        );
        return;
      }
      recordViewRef.current?.addStatus(
        'error',
        error instanceof Error ? error.message : 'Read failed'
      );
      toast({
        title: 'Read failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const copyCurl = async (streaming: boolean) => {
    if (!selectedStream) {
      return;
    }

    const input = buildReadInput();
    if (!input) {
      return;
    }

    const curlToken = (await resolveToken()) ?? undefined;

    const curlCommand = buildReadCurlCommand(
      basinId,
      selectedStream,
      input,
      streaming,
      curlToken,
      endpoints?.basin,
      encryptionKey
    );

    writeCurlToClipboard(
      curlCommand,
      streaming ? 'stream' : 'read',
      streaming ? setStreamCurlCopied : setReadCurlCopied
    );
  };

  const copyAppendCurl = async () => {
    if (!selectedStream) {
      return;
    }

    let input: StudioAppendInput;
    try {
      input = buildAppendInput();
    } catch (error) {
      toast({
        title: 'Invalid append payload',
        description:
          error instanceof Error ? error.message : 'Could not build command',
        variant: 'destructive',
      });
      return;
    }

    const curlToken = (await resolveToken()) ?? undefined;
    writeCurlToClipboard(
      buildAppendCurlCommand(
        basinId,
        selectedStream,
        input,
        curlToken,
        endpoints?.basin,
        encryptionKey
      ),
      'append',
      setAppendCurlCopied
    );
  };

  const writeCurlToClipboard = (
    curlCommand: string,
    label: string,
    setCopied: (copied: boolean) => void
  ) => {
    void navigator.clipboard
      .writeText(curlCommand)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast({
          title: 'Copied',
          description: `curl ${label} command copied to clipboard`,
        });
      })
      .catch((error: unknown) => {
        toast({
          title: 'Failed to copy curl command',
          description:
            error instanceof Error ? error.message : 'Could not copy command',
          variant: 'destructive',
        });
      });
  };

  const startStreaming = async () => {
    if (!selectedStream || isStreaming) {
      return;
    }

    const signal = sessionAbortRef.current.signal;
    const s2 = await getClient();
    if (signal.aborted) return;
    if (s2 === null) {
      toast({
        title: 'Unable to start streaming',
        description: 'No auth token found',
        variant: 'destructive',
      });
      return;
    }

    const input = buildReadInput();
    if (!input) {
      return;
    }

    setIsStreaming(true);
    setRecordsReceived(0);
    setStreamStartedAtMs(Date.now());
    recordViewRef.current?.clear();

    const streamAbortController = new AbortController();
    streamAbortControllerRef.current = streamAbortController;

    try {
      const session = await openReadSession(
        s2,
        basinId,
        selectedStream,
        input,
        undefined,
        { signal: streamAbortController.signal },
        encryptionKey.trim() || undefined
      );

      for await (const value of session) {
        if (streamAbortController.signal.aborted || signal.aborted) break;
        recordViewRef.current?.addRecord({
          seqNum: value.seqNum,
          timestamp: value.timestamp,
          body: value.body,
          headers: value.headers,
        });
        setRecordsReceived((prev) => prev + 1);
        setLastRecordAtMs(Date.now());
      }
    } catch (error) {
      if (streamAbortController.signal.aborted) {
        return;
      }

      recordViewRef.current?.addStatus(
        'error',
        error instanceof Error ? error.message : 'Streaming failed'
      );
      toast({
        title: 'Streaming failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
        setIsStreaming(false);
      }
      if (!signal.aborted) void refreshTail();
    }
  };

  const buildAppendInput = (): StudioAppendInput => {
    const matchSeqNum = parseMatchSeqNum(appendMatchSeqNum);
    return {
      records: parseAppendRecords(appendMode, appendPayload),
      matchSeqNum,
      fencingToken: fencingToken.trim() || undefined,
    };
  };

  const handleAppend = async () => {
    if (!selectedStream) {
      return;
    }

    const signal = sessionAbortRef.current.signal;
    const s2 = await getClient();
    if (signal.aborted) return;
    if (s2 === null) {
      toast({
        title: 'Unable to append',
        description: 'No auth token found',
        variant: 'destructive',
      });
      return;
    }

    setAppending(true);
    try {
      const input = buildAppendInput();
      const records = input.records;

      const ack = await appendToStream(
        s2,
        basinId,
        selectedStream,
        input,
        encryptionKey.trim() || undefined
      );

      if (signal.aborted) return;
      setLastAppendAck(ack);
      toast({
        title: 'Append successful',
        description: `Appended ${records.length} record(s).`,
      });
      void refreshTail();
    } catch (error) {
      if (signal.aborted) return;
      toast({
        title: 'Append failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (!signal.aborted) setAppending(false);
    }
  };

  const onAppendFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      setAppendPayload(text);
      if (file.name.endsWith('.json')) {
        setAppendMode('json-array');
      } else if (
        file.name.endsWith('.jsonl') ||
        file.name.endsWith('.ndjson')
      ) {
        setAppendMode('lines');
      } else {
        setAppendMode('single');
      }
      toast({
        title: 'File loaded',
        description: `${file.name} loaded into append editor.`,
      });
    } catch {
      toast({
        title: 'File load failed',
        description: 'Could not read the selected file.',
        variant: 'destructive',
      });
    }
  };

  const runTrim = async () => {
    if (!selectedStream) {
      return;
    }

    const seqNum = Number.parseInt(trimSeqNum, 10);
    if (Number.isNaN(seqNum) || seqNum < 0) {
      toast({
        title: 'Invalid trim point',
        description: 'Trim sequence number must be a non-negative integer.',
        variant: 'destructive',
      });
      return;
    }

    setTrimConfirmSeqNum(seqNum);
  };

  const confirmTrim = async () => {
    if (!selectedStream || trimConfirmSeqNum === null) {
      setTrimConfirmSeqNum(null);
      return;
    }

    const seqNum = trimConfirmSeqNum;

    const signal = sessionAbortRef.current.signal;
    const s2 = await getClient();
    if (signal.aborted) return;
    if (s2 === null) {
      toast({
        title: 'Unable to trim stream',
        description: 'No auth token found',
        variant: 'destructive',
      });
      setTrimConfirmSeqNum(null);
      return;
    }

    setRunningCommand(true);
    try {
      const ack = await trimStream(
        s2,
        basinId,
        selectedStream,
        seqNum,
        fencingToken.trim() || undefined,
        encryptionKey.trim() || undefined
      );
      if (signal.aborted) return;
      setLastCommandAck(ack);
      toast({
        title: 'Trim command submitted',
        description: `Stream trimmed through sequence #${seqNum}.`,
      });
      void refreshTail();
      setTrimConfirmSeqNum(null);
    } catch (error) {
      if (signal.aborted) return;
      toast({
        title: 'Trim failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (!signal.aborted) setRunningCommand(false);
    }
  };

  const runFence = async () => {
    if (!selectedStream) {
      return;
    }

    if (!nextFenceToken.trim()) {
      toast({
        title: 'Missing fencing token',
        description: 'Set a token to apply to the stream.',
        variant: 'destructive',
      });
      return;
    }

    const signal = sessionAbortRef.current.signal;
    const s2 = await getClient();
    if (signal.aborted) return;
    if (s2 === null) {
      toast({
        title: 'Unable to fence stream',
        description: 'No auth token found',
        variant: 'destructive',
      });
      return;
    }

    setRunningCommand(true);
    try {
      const ack = await fenceStream(
        s2,
        basinId,
        selectedStream,
        nextFenceToken.trim(),
        fencingToken.trim() || undefined,
        encryptionKey.trim() || undefined
      );
      if (signal.aborted) return;
      setLastCommandAck(ack);
      toast({
        title: 'Fence command submitted',
        description: `Fencing token set to "${nextFenceToken.trim()}".`,
      });
      setFencingToken(nextFenceToken.trim());
      setNextFenceToken('');
      void refreshTail();
    } catch (error) {
      if (signal.aborted) return;
      toast({
        title: 'Fence failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      if (!signal.aborted) setRunningCommand(false);
    }
  };

  const recordsPerSecond = useMemo(() => {
    if (!streamStartedAtMs || !lastRecordAtMs || recordsReceived === 0) {
      return '0.0';
    }
    const elapsedSecs = Math.max(
      (lastRecordAtMs - streamStartedAtMs) / 1000,
      0.1
    );
    return (recordsReceived / elapsedSecs).toFixed(1);
  }, [recordsReceived, streamStartedAtMs, lastRecordAtMs]);

  const timestampDate = useMemo(
    () => parseUTCTimestamp(readFromValue.trim()),
    [readFromValue]
  );

  const timestampTimeValue = useMemo(() => {
    if (!timestampDate) {
      return '00:00';
    }
    return `${pad2(timestampDate.getUTCHours())}:${pad2(timestampDate.getUTCMinutes())}`;
  }, [timestampDate]);

  const handleTimestampDateChange = (selectedDate: Date | undefined) => {
    if (!selectedDate) {
      return;
    }

    const base = timestampDate ?? new Date();
    const next = new Date(selectedDate);
    next.setUTCHours(base.getUTCHours(), base.getUTCMinutes(), 0, 0);
    setReadFromValue(toUTCDateTimeValue(next));
  };

  const handleTimestampTimeChange = (timeValue: string) => {
    const [hoursStr, minutesStr] = timeValue.split(':');
    const hours = Number.parseInt(hoursStr ?? '', 10);
    const minutes = Number.parseInt(minutesStr ?? '', 10);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }

    const base = timestampDate ?? new Date();
    const next = new Date(base);
    next.setUTCHours(hours, minutes, 0, 0);
    setReadFromValue(toUTCDateTimeValue(next));
  };

  const readStartLabel =
    readStartMode === 'tailOffset'
      ? `tail -${readFromValue.trim() || '10'}`
      : readStartMode === 'seqNum'
        ? `seq ${readFromValue.trim() || '0'}`
        : formatTimestampDisplay(readFromValue.trim());

  const readSummary = [
    readStartLabel,
    readLimitCount.trim() ? `limit ${readLimitCount.trim()}` : null,
    readWaitSecs.trim() ? `wait ${readWaitSecs.trim()}s` : null,
    ignoreCommandRecords ? 'data only' : null,
    readClamp ? null : 'no clamp',
  ]
    .filter(Boolean)
    .join(' · ');

  const appendPreview = useMemo(() => {
    if (!appendPayload.trim()) {
      return null;
    }
    try {
      return { count: parseAppendRecords(appendMode, appendPayload).length };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Invalid payload',
      };
    }
  }, [appendMode, appendPayload]);

  if (!basinId) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <section className="flex w-full flex-1 flex-col gap-4 pt-4">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-2 pb-1">
          <div className="border-border/50 flex h-7 items-center overflow-hidden rounded-sm border">
            <BasinCombobox
              value={basinId}
              className="hover:bg-muted h-7 w-[132px] rounded-none border-0 bg-transparent px-2 text-[12px] sm:w-[146px]"
              onValueChange={(value) => {
                navigate(
                  `/dashboard/basins/${encodeURIComponent(value)}/studio`
                );
              }}
            />
            <span
              aria-hidden
              className="border-border/60 h-full shrink-0 border-l border-dotted"
            />
            <StreamCombobox
              basinId={basinId}
              value={selectedStream}
              className="hover:bg-muted h-7 w-[150px] rounded-none border-0 bg-transparent px-2 text-[12px] sm:w-[180px]"
              onValueChange={(value) => {
                setSelectedStream(value);
                updateStreamInUrl(value);
              }}
            />
          </div>
          {selectedStream && (
            <>
              <button
                className="group/uri hover:bg-muted flex min-w-0 shrink items-center gap-1 rounded px-1 py-0.5 text-[12px] transition-colors"
                onClick={async () => {
                  const uri = `s2://${basinId}/${selectedStream}`;
                  try {
                    await navigator.clipboard.writeText(uri);
                    setUriCopied(true);
                    setTimeout(() => setUriCopied(false), 1500);
                  } catch {
                    return;
                  }
                }}
                title={`Copy s2://${basinId}/${selectedStream}`}
              >
                <span className="text-muted-foreground truncate">
                  s2://{basinId}/{selectedStream}
                </span>
                {uriCopied ? (
                  <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3 shrink-0 opacity-60 transition-opacity group-hover/uri:opacity-100" />
                )}
              </button>
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  selectedStreamInfo?.deletedAt
                    ? 'bg-destructive'
                    : 'bg-emerald-500'
                )}
              />
              <span className={cn(LABEL, 'sr-only')}>
                {selectedStreamInfo?.deletedAt ? 'deleting' : 'active'}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-muted-foreground/70 text-[12px] whitespace-nowrap tabular-nums">
              {formatPosition(tailInfo)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground h-8 w-8 rounded-sm"
              aria-label="Refresh streams and tail"
              onClick={() => {
                void refetchStreams();
                if (selectedStream) void refetchSelectedStream();
                void refreshTail();
              }}
              disabled={tailLoading}
            >
              {tailLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
            <DocsLink href={STUDIO_DOCS.studio} label="Studio docs" />
          </div>
        </header>

        {isLoadingStreams ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : streams.length === 0 ? (
          <EmptyList
            title="No streams yet"
            description="Create a stream from the basin page to get started."
            cta={{
              label: 'Go to Streams',
              onClick: () =>
                navigate(`/dashboard/basins/${encodeURIComponent(basinId)}`),
            }}
          />
        ) : (
          <>
            <div className="grid gap-4 lg:h-[calc(100dvh_-_190px)] lg:min-h-[520px] lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="border-border/50 flex h-[55vh] min-h-0 flex-col overflow-hidden rounded-lg border lg:h-auto">
                <div className="bg-muted/60 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className={HEADING}>Records</span>
                    <span className={cn(LABEL, 'tabular-nums')}>
                      {recordsReceived}{' '}
                      {recordsReceived === 1 ? 'record' : 'records'} &middot;{' '}
                      {recordsPerSecond}/s
                    </span>
                    {isStreaming && (
                      <span
                        className={cn(
                          LABEL,
                          'text-emerald-600 dark:text-emerald-400'
                        )}
                      >
                        streaming
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      CONTROL,
                      'text-muted-foreground h-8 gap-1 rounded-sm px-2'
                    )}
                    onClick={() => recordViewRef.current?.clear()}
                  >
                    <Eraser className="h-3 w-3" />
                    Clear
                  </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden">
                  <RecordView ref={recordViewRef} />
                </div>

                <div className="border-border/40 shrink-0 border-t">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-3">
                    <button
                      type="button"
                      className={cn(
                        LABEL,
                        'hover:text-foreground inline-flex items-center gap-1'
                      )}
                      aria-expanded={composerOpen}
                      onClick={() => setComposerOpen((prev) => !prev)}
                    >
                      Payload
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 transition-transform',
                          composerOpen && 'rotate-180'
                        )}
                      />
                    </button>
                    <Select
                      value={appendMode}
                      onValueChange={(v) => setAppendMode(v as AppendInputMode)}
                    >
                      <SelectTrigger
                        aria-label="Input mode"
                        className={cn(
                          CONTROL,
                          'h-8 w-auto gap-1 rounded-sm px-2'
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="single">Single body</SelectItem>
                        <SelectItem value="lines">
                          One record per line
                        </SelectItem>
                        <SelectItem value="json-array">JSON array</SelectItem>
                      </SelectContent>
                    </Select>
                    <label
                      className={cn(
                        CONTROL,
                        'text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition-colors'
                      )}
                    >
                      <Paperclip className="h-3 w-3" />
                      <span>Load file</span>
                      <input
                        type="file"
                        className="hidden"
                        accept=".txt,.json,.jsonl,.ndjson"
                        onChange={(e) => void onAppendFileSelected(e)}
                      />
                    </label>
                    <Popover
                      open={concurrencyOpen}
                      onOpenChange={setConcurrencyOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          className={cn(
                            CONTROL,
                            'text-muted-foreground h-8 gap-1 rounded-sm px-2 font-normal'
                          )}
                          aria-expanded={concurrencyOpen}
                        >
                          Concurrency
                          {appendMatchSeqNum.trim() &&
                            ` \u00b7 seq ${appendMatchSeqNum.trim()}`}
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-72 p-3">
                        <StudioField
                          label="Match sequence number"
                          htmlFor="append-match-seq"
                          hint="Only appends if the stream tail matches this sequence number."
                        >
                          <Input
                            id="append-match-seq"
                            aria-label="Match sequence number"
                            className={cn(CONTROL, 'h-8 rounded-sm')}
                            value={appendMatchSeqNum}
                            onChange={(e) =>
                              setAppendMatchSeqNum(e.target.value)
                            }
                            placeholder="optional"
                          />
                        </StudioField>
                      </PopoverContent>
                    </Popover>
                    {appendPreview ? (
                      'error' in appendPreview ? (
                        <span
                          className={cn(LABEL, 'text-destructive truncate')}
                        >
                          {appendPreview.error}
                        </span>
                      ) : (
                        <span className={cn(LABEL, 'tabular-nums')}>
                          {appendPreview.count}{' '}
                          {appendPreview.count === 1 ? 'record' : 'records'}
                        </span>
                      )
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                      <CopyIconButton
                        label="Copy append as curl"
                        copied={appendCurlCopied}
                        onClick={() => void copyAppendCurl()}
                      />
                      <Button
                        size="sm"
                        className={cn(CONTROL, 'h-8 gap-1.5 rounded-sm')}
                        onClick={() => void handleAppend()}
                        disabled={
                          appending ||
                          Boolean(appendPreview && 'error' in appendPreview)
                        }
                      >
                        {appending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Append
                      </Button>
                    </div>
                  </div>
                  {composerOpen && (
                    <textarea
                      className={cn(
                        BODY,
                        'bg-background placeholder:text-muted-foreground dark:bg-input/30 h-28 w-full resize-y border-0 px-4 py-3 font-mono text-[13px] focus:ring-0 focus:outline-none'
                      )}
                      value={appendPayload}
                      onChange={(e) => setAppendPayload(e.target.value)}
                      placeholder={
                        appendMode === 'json-array'
                          ? '[{"body":"hello","headers":{"source":"studio"}}]'
                          : appendMode === 'lines'
                            ? 'first line\nsecond line'
                            : 'single record body'
                      }
                    />
                  )}
                  {lastAppendAck && (
                    <div className="px-4 py-2">
                      <PositionRows
                        rows={[
                          ['start', lastAppendAck.start],
                          ['end', lastAppendAck.end],
                          ['tail', lastAppendAck.tail],
                        ]}
                      />
                    </div>
                  )}
                </div>
              </div>

              <aside className="border-border/50 flex min-h-0 flex-col overflow-hidden rounded-lg border">
                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
                  <div className="space-y-3">
                    <h2 className={HEADING}>Read</h2>
                    <div className="flex items-center gap-1">
                      {isStreaming ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className={cn(
                            CONTROL,
                            'h-8 flex-1 gap-1.5 rounded-sm'
                          )}
                          onClick={() => void stopStreaming()}
                        >
                          <Square className="h-3 w-3" />
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className={cn(
                            CONTROL,
                            'h-8 flex-1 gap-1.5 rounded-sm'
                          )}
                          onClick={() => void startStreaming()}
                        >
                          <Play className="h-3 w-3" />
                          Stream
                        </Button>
                      )}
                      <CopyIconButton
                        label="Copy stream as curl"
                        copied={streamCurlCopied}
                        onClick={() => void copyCurl(true)}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn(CONTROL, 'h-8 flex-1 rounded-sm')}
                        onClick={() => void readOnce()}
                        disabled={isStreaming}
                      >
                        Read Once
                      </Button>
                      <CopyIconButton
                        label="Copy read as curl"
                        copied={readCurlCopied}
                        onClick={() => void copyCurl(false)}
                      />
                    </div>
                    <StudioSection
                      title="Read settings"
                      summary={readSummary}
                      error={readStartError ?? undefined}
                    >
                      <StudioField
                        label="Start from"
                        htmlFor="read-start-mode"
                        hint="Choose how to anchor the read position: relative from tail, absolute sequence number, or a specific timestamp."
                      >
                        <Select
                          value={readStartMode}
                          onValueChange={(v) =>
                            setReadStartMode(v as ReadStartMode)
                          }
                        >
                          <SelectTrigger
                            id="read-start-mode"
                            className={cn(CONTROL, 'h-8 rounded-sm')}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="tailOffset">
                              Tail offset
                            </SelectItem>
                            <SelectItem value="seqNum">
                              Sequence number
                            </SelectItem>
                            <SelectItem value="timestamp">Timestamp</SelectItem>
                          </SelectContent>
                        </Select>
                      </StudioField>
                      <StudioField
                        label={
                          readStartMode === 'tailOffset'
                            ? 'Tail offset'
                            : readStartMode === 'seqNum'
                              ? 'Sequence number'
                              : 'Timestamp (UTC)'
                        }
                        htmlFor={
                          readStartMode === 'timestamp'
                            ? undefined
                            : 'read-start-value'
                        }
                        hint={
                          readStartMode === 'tailOffset'
                            ? 'Number of records back from the stream tail to start reading (e.g. 10 = last 10 records).'
                            : readStartMode === 'seqNum'
                              ? 'Absolute sequence number of the first record to read. Must be a non-negative integer.'
                              : 'Start reading from the first record at or after this UTC timestamp.'
                        }
                        error={readStartError ?? undefined}
                      >
                        {readStartMode === 'timestamp' ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                className={cn(
                                  BODY,
                                  'h-8 w-full justify-between px-2 text-left font-normal',
                                  !timestampDate && 'text-muted-foreground'
                                )}
                              >
                                <span className="truncate">
                                  {formatTimestampDisplay(readFromValue.trim())}
                                </span>
                                <CalendarIcon className="h-3.5 w-3.5 opacity-70" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              className="border-border/50 w-auto p-0"
                            >
                              <Calendar
                                mode="single"
                                timeZone="UTC"
                                selected={timestampDate ?? undefined}
                                onSelect={handleTimestampDateChange}
                                initialFocus
                              />
                              <div className="border-border/40 flex items-center gap-2 border-t p-2">
                                <Label
                                  htmlFor="read-timestamp-time"
                                  className={LABEL}
                                >
                                  Time (UTC)
                                </Label>
                                <Input
                                  id="read-timestamp-time"
                                  type="time"
                                  className={cn(CONTROL, 'h-8 rounded-sm')}
                                  value={timestampTimeValue}
                                  onChange={(e) =>
                                    handleTimestampTimeChange(e.target.value)
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className={cn(CONTROL, 'h-8 rounded-sm px-2')}
                                  onClick={() =>
                                    setReadFromValue(
                                      toUTCDateTimeValue(new Date())
                                    )
                                  }
                                >
                                  Now
                                </Button>
                              </div>
                            </PopoverContent>
                          </Popover>
                        ) : (
                          <Input
                            id="read-start-value"
                            className={cn(CONTROL, 'h-8 rounded-sm')}
                            type="text"
                            value={readFromValue}
                            onChange={(e) => setReadFromValue(e.target.value)}
                            placeholder={
                              readStartMode === 'tailOffset' ? '10' : '0'
                            }
                          />
                        )}
                      </StudioField>
                      <div className="space-y-3">
                        <StudioField
                          label="Limit"
                          htmlFor="read-limit"
                          hint="Max records to return per batch (up to 1000). Leave empty for no cap."
                        >
                          <Input
                            id="read-limit"
                            className={cn(CONTROL, 'h-8 rounded-sm')}
                            value={readLimitCount}
                            onChange={(e) => setReadLimitCount(e.target.value)}
                            placeholder="optional"
                          />
                        </StudioField>
                        <StudioField
                          label="Wait (s)"
                          htmlFor="read-wait"
                          hint="Seconds to wait for new records when streaming reaches the tail. Set to 0 to stop immediately at tail."
                        >
                          <Input
                            id="read-wait"
                            className={cn(CONTROL, 'h-8 rounded-sm')}
                            value={readWaitSecs}
                            onChange={(e) => setReadWaitSecs(e.target.value)}
                            placeholder="optional"
                          />
                        </StudioField>
                      </div>
                      <div className="flex flex-col gap-1.5 pt-0.5">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="read-clamp"
                            checked={readClamp}
                            onCheckedChange={(c) => setReadClamp(Boolean(c))}
                          />
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Label
                                htmlFor="read-clamp"
                                className={cn(
                                  BODY,
                                  'w-fit cursor-pointer underline decoration-dotted underline-offset-2'
                                )}
                              >
                                Clamp to tail
                              </Label>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[220px] text-xs">
                              If the start position is beyond the current tail,
                              clamp it to the tail instead of returning an
                              error.
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="read-ignore-commands"
                            checked={ignoreCommandRecords}
                            onCheckedChange={(c) =>
                              setIgnoreCommandRecords(Boolean(c))
                            }
                          />
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Label
                                htmlFor="read-ignore-commands"
                                className={cn(
                                  BODY,
                                  'w-fit cursor-pointer underline decoration-dotted underline-offset-2'
                                )}
                              >
                                Ignore command records
                              </Label>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[220px] text-xs">
                              Filter out fence and trim command records,
                              returning only data records.
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </StudioSection>
                  </div>

                  <div className="space-y-3">
                    <h2 className={HEADING}>Session</h2>
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="studio-fencing-token"
                          className={cn(LABEL, 'block w-fit')}
                        >
                          Fencing token
                        </Label>
                        <div className="flex items-center gap-1">
                          <Input
                            id="studio-fencing-token"
                            aria-label="Fencing token"
                            spellCheck={false}
                            placeholder="optional"
                            value={fencingToken}
                            onChange={(e) => setFencingToken(e.target.value)}
                            className="h-8 min-w-0 flex-1 rounded-sm font-mono text-[13px]"
                          />
                          {fencingToken && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground h-8 w-8 rounded-sm"
                              onClick={() => setFencingToken('')}
                              title="Clear token"
                            >
                              <Eraser className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                        <p className={LABEL}>
                          Sent with appends, trims and fences. While the stream
                          is fenced, a mismatch is rejected.
                        </p>
                      </div>
                      {selectedStreamInfo?.cipher && (
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="studio-encryption-key"
                            className={cn(LABEL, 'block w-fit')}
                          >
                            Encryption key
                          </Label>
                          <div className="flex items-center gap-1">
                            <Input
                              id="studio-encryption-key"
                              aria-label="Encryption key"
                              type={showEncryptionKey ? 'text' : 'password'}
                              autoComplete="new-password"
                              data-lpignore="true"
                              data-1p-ignore
                              spellCheck={false}
                              placeholder="base64 key"
                              value={encryptionKey}
                              onChange={(e) => setEncryptionKey(e.target.value)}
                              className="h-8 min-w-0 flex-1 rounded-sm font-mono text-[13px]"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground h-8 w-8 rounded-sm"
                              onClick={() =>
                                setShowEncryptionKey((prev) => !prev)
                              }
                              title={
                                showEncryptionKey ? 'Hide key' : 'Show key'
                              }
                            >
                              {showEncryptionKey ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </Button>
                            {encryptionKey && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground h-8 w-8 rounded-sm"
                                onClick={() => setEncryptionKey('')}
                                title="Clear key"
                              >
                                <Eraser className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h2 className={HEADING}>Maintain</h2>
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <Label htmlFor="studio-trim-seq" className={LABEL}>
                          Trim through
                        </Label>
                        <DocsLink
                          href={STUDIO_DOCS.retention}
                          label="Trim docs"
                        />
                      </div>
                      <p className={LABEL}>
                        Discards every record up to and including this sequence
                        number.
                      </p>
                      <div className="flex items-center gap-1">
                        <Input
                          id="studio-trim-seq"
                          aria-label="Trim through sequence number"
                          placeholder="Sequence number"
                          value={trimSeqNum}
                          onChange={(e) => setTrimSeqNum(e.target.value)}
                          className="h-8 min-w-0 flex-1 rounded-sm font-mono text-[13px]"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            CONTROL,
                            'text-destructive h-8 rounded-sm px-2'
                          )}
                          onClick={() => void runTrim()}
                          disabled={runningCommand}
                        >
                          Trim
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <Label htmlFor="studio-new-fence" className={LABEL}>
                          New fencing token
                        </Label>
                        <DocsLink
                          href={STUDIO_DOCS.concurrency}
                          label="Fence docs"
                        />
                      </div>
                      <p className={LABEL}>
                        Once set, requests that send a fencing token must match
                        it.
                      </p>
                      <div className="flex items-center gap-1">
                        <Input
                          id="studio-new-fence"
                          aria-label="New fencing token"
                          placeholder="New token"
                          value={nextFenceToken}
                          onChange={(e) => setNextFenceToken(e.target.value)}
                          className="h-8 min-w-0 flex-1 rounded-sm font-mono text-[13px]"
                        />
                        <Button
                          size="sm"
                          className={cn(CONTROL, 'h-8 rounded-sm px-2')}
                          onClick={() => void runFence()}
                          disabled={runningCommand}
                        >
                          Fence
                        </Button>
                      </div>
                    </div>
                    {lastCommandAck && (
                      <PositionRows rows={[['tail', lastCommandAck.tail]]} />
                    )}
                  </div>
                </div>
              </aside>
            </div>

            <Dialog
              open={trimConfirmSeqNum !== null}
              onOpenChange={(open) => {
                if (!open && !runningCommand) {
                  setTrimConfirmSeqNum(null);
                }
              }}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className={HEADING}>
                    Confirm trim command
                  </DialogTitle>
                  <DialogDescription>
                    This action is irreversible. Trim{' '}
                    <span className="text-foreground font-mono">
                      {selectedStream}
                    </span>{' '}
                    through sequence{' '}
                    <span className="text-foreground font-mono">
                      #{trimConfirmSeqNum ?? 'n/a'}
                    </span>
                    .
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    className="rounded-sm"
                    onClick={() => setTrimConfirmSeqNum(null)}
                    disabled={runningCommand}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    className="rounded-sm"
                    onClick={() => void confirmTrim()}
                    disabled={runningCommand}
                  >
                    {runningCommand ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Trimming...
                      </>
                    ) : (
                      'Trim stream'
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </section>
    </TooltipProvider>
  );
}
