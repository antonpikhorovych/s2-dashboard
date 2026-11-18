'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
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
  Eye,
  EyeOff,
  ExternalLink,
  Eraser,
  KeyRound,
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
        'text-muted-foreground decoration-muted-foreground/40 hover:text-foreground inline-flex items-center gap-1 text-[11px] underline decoration-dotted underline-offset-2 transition-colors',
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

function formatCompactPosition(position?: StreamPosition): string {
  if (!position) {
    return 'n/a';
  }
  return `#${position.seqNum}`;
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
  const [activeTab, setActiveTab] = useState('read');

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
  const [appendFencingToken, setAppendFencingToken] = useState('');
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
  const readIdRef = useRef(0);

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

  const buildReadInput = useCallback((): ReadInput | null => {
    const trimmed = readFromValue.trim();
    let readFrom: ReadFrom;

    if (readStartMode === 'tailOffset') {
      const parsed = Number.parseInt(trimmed || '10', 10);
      if (Number.isNaN(parsed)) {
        toast({
          title: 'Invalid tail offset',
          description: 'Tail offset must be an integer.',
          variant: 'destructive',
        });
        return null;
      }
      readFrom = { tailOffset: Math.abs(parsed) };
    } else if (readStartMode === 'seqNum') {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        toast({
          title: 'Invalid sequence number',
          description: 'Sequence number must be a non-negative integer.',
          variant: 'destructive',
        });
        return null;
      }
      readFrom = { seqNum: parsed };
    } else {
      const parsed = parseUTCTimestamp(trimmed);
      if (!parsed) {
        toast({
          title: 'Invalid timestamp',
          description:
            'Use an ISO date/time value (UTC unless an offset is given).',
          variant: 'destructive',
        });
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
    setAppendFencingToken('');
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

    // A newer read owns the record view; an older one must not add to it.
    const readId = ++readIdRef.current;
    const stale = () => signal.aborted || readIdRef.current !== readId;

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
      if (stale()) return;
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
      // A read only reports the tail when it gets near it, so ask for it
      // to tell a read that stopped at a limit from one that reached the end.
      let tail = response.tail;
      if (!tail) {
        try {
          tail = (await checkStreamTail(s2, basinId, selectedStream)).tail;
        } catch {
          // The hint below is skipped when the tail is unknown.
        }
        if (stale()) return;
      }
      if (tail) {
        setTailInfo(tail);
      }
      // With command records hidden, the last record shown can trail the
      // read's real progress, so the hint only states what is known.
      const last = response.records.at(-1);
      const nextSeqNum = last ? Number(last.seqNum) + 1 : undefined;
      if (tail && nextSeqNum !== undefined && nextSeqNum < tail.seqNum) {
        recordViewRef.current?.addStatus(
          'info',
          `Last record shown is before the tail (seq ${tail.seqNum}).`,
          {
            label: `Continue from seq ${nextSeqNum}`,
            onClick: () => {
              setReadStartMode('seqNum');
              setReadFromValue(String(nextSeqNum));
            },
          }
        );
      }
    } catch (error) {
      if (stale()) return;
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

    readIdRef.current += 1;
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

  const parseAppendRecords = (): StudioAppendRecordInput[] => {
    const text = appendPayload.trim();
    if (!text) {
      throw new Error('Append payload cannot be empty');
    }

    if (appendMode === 'single') {
      return [{ body: appendPayload }];
    }

    if (appendMode === 'lines') {
      const lines = appendPayload
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.map((line) => ({ body: line }));
    }

    const parsed = JSON.parse(appendPayload) as unknown;
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
  };

  const buildAppendInput = (): StudioAppendInput => {
    const matchSeqNum = parseMatchSeqNum(appendMatchSeqNum);
    return {
      records: parseAppendRecords(),
      matchSeqNum,
      fencingToken: appendFencingToken.trim() || undefined,
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
        appendFencingToken.trim() || undefined,
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
        appendFencingToken.trim() || undefined,
        encryptionKey.trim() || undefined
      );
      if (signal.aborted) return;
      setLastCommandAck(ack);
      toast({
        title: 'Fence command submitted',
        description: `Fencing token set to "${nextFenceToken.trim()}".`,
      });
      setAppendFencingToken(nextFenceToken.trim());
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

  if (!basinId) {
    return null;
  }

  return (
    <section className="flex w-full flex-1 flex-col gap-2 pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <BasinCombobox
          value={basinId}
          onValueChange={(value) => {
            navigate(`/dashboard/basins/${encodeURIComponent(value)}/studio`);
          }}
        />

        <StreamCombobox
          basinId={basinId}
          value={selectedStream}
          onValueChange={(value) => {
            setSelectedStream(value);
            updateStreamInUrl(value);
          }}
        />

        {selectedStream && (
          <div className="text-muted-foreground order-3 flex w-full min-w-0 items-center gap-x-2 text-xs sm:order-none sm:flex-1">
            <button
              className="group/uri hover:bg-muted flex min-w-0 shrink items-center gap-1 rounded px-1 py-0.5 transition-colors"
              onClick={async () => {
                const uri = `s2://${basinId}/${selectedStream}`;
                try {
                  await navigator.clipboard.writeText(uri);
                  setUriCopied(true);
                  setTimeout(() => setUriCopied(false), 1500);
                } catch {
                  // ignore
                }
              }}
              title={`Copy s2://${basinId}/${selectedStream}`}
            >
              <span className="hidden truncate font-mono sm:inline">
                s2://{basinId}/{selectedStream}
              </span>
              {uriCopied ? (
                <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/uri:opacity-100" />
              )}
            </button>
            <span className="text-muted-foreground/30 shrink-0">&middot;</span>
            <span
              className={cn(
                'shrink-0',
                selectedStreamInfo?.deletedAt
                  ? 'text-destructive'
                  : 'text-emerald-600 dark:text-emerald-400'
              )}
            >
              {selectedStreamInfo?.deletedAt ? 'deleting' : 'active'}
            </span>
            <span className="text-muted-foreground/30 shrink-0 lg:inline">
              &middot;
            </span>
            <span className="shrink-0 font-mono lg:hidden">
              tail {formatCompactPosition(tailInfo)}
            </span>
            <span className="hidden min-w-0 truncate font-mono lg:inline">
              tail {formatPosition(tailInfo)}
            </span>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 sm:ml-auto"
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

        <DocsLink
          href={STUDIO_DOCS.studio}
          label="Studio docs"
          className="sm:ml-1"
        />
      </div>

      {selectedStream && selectedStreamInfo?.cipher && (
        <div className="border-border/40 bg-muted/20 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <KeyRound className="h-3 w-3" />
                  <span className="decoration-muted-foreground/40 underline decoration-dotted underline-offset-2">
                    Encryption key
                  </span>
                  <span className="rounded border px-1.5 py-0 font-mono text-[10px]">
                    {selectedStreamInfo.cipher}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px] text-xs">
                Base64-encoded key material sent as the{' '}
                <code className="font-mono">s2-encryption-key</code> header on
                append and read requests. Key stays in this browser session
                only.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              type={showEncryptionKey ? 'text' : 'password'}
              className="border-border/50 h-7 flex-1 font-mono text-xs"
              value={encryptionKey}
              onChange={(e) => setEncryptionKey(e.target.value)}
              placeholder="base64 key"
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
              spellCheck={false}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground h-7 w-7"
              onClick={() => setShowEncryptionKey((prev) => !prev)}
              title={showEncryptionKey ? 'Hide key' : 'Show key'}
            >
              {showEncryptionKey ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
            {encryptionKey && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground h-7 w-7"
                onClick={() => setEncryptionKey('')}
                title="Clear key"
              >
                <Eraser className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      {isLoadingStreams ? (
        <div className="flex h-32 items-center justify-center">
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
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full">
              <TabsTrigger className="w-full" value="read">
                Read
              </TabsTrigger>
              <TabsTrigger className="w-full" value="append">
                Append
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="read"
              forceMount
              className={cn('mt-2', activeTab !== 'read' && 'hidden')}
            >
              <div className="grid gap-3 xl:h-[calc(100vh-200px)] xl:grid-cols-[260px_1fr]">
                <div className="border-border/50 flex flex-col overflow-y-auto rounded-lg border">
                  <div className="space-y-2.5 p-3">
                    <div className="flex items-center justify-between pb-0.5">
                      <span className="text-muted-foreground/60 text-[11px] font-medium tracking-wider uppercase">
                        Read settings
                      </span>
                      <DocsLink href={STUDIO_DOCS.reads} label="Read docs" />
                    </div>
                    <TooltipProvider>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              Start from
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[220px] text-xs">
                            Choose how to anchor the read position: relative
                            from tail, absolute sequence number, or a specific
                            timestamp.
                          </TooltipContent>
                        </Tooltip>
                        <Select
                          value={readStartMode}
                          onValueChange={(v) =>
                            setReadStartMode(v as ReadStartMode)
                          }
                        >
                          <SelectTrigger className="border-border/50 h-8">
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
                      </div>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              {readStartMode === 'tailOffset'
                                ? 'Tail offset'
                                : readStartMode === 'seqNum'
                                  ? 'Sequence number'
                                  : 'Timestamp (UTC)'}
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[220px] text-xs">
                            {readStartMode === 'tailOffset'
                              ? 'Number of records back from the stream tail to start reading (e.g. 10 = last 10 records).'
                              : readStartMode === 'seqNum'
                                ? 'Absolute sequence number of the first record to read. Must be a non-negative integer.'
                                : 'Start reading from the first record at or after this UTC timestamp.'}
                          </TooltipContent>
                        </Tooltip>
                        {readStartMode === 'timestamp' ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                className={cn(
                                  'border-border/50 h-8 w-full justify-between px-3 text-left font-normal',
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
                                  className="text-muted-foreground text-[11px]"
                                >
                                  Time (UTC)
                                </Label>
                                <Input
                                  id="read-timestamp-time"
                                  type="time"
                                  className="border-border/50 h-8"
                                  value={timestampTimeValue}
                                  onChange={(e) =>
                                    handleTimestampTimeChange(e.target.value)
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-xs"
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
                            className="border-border/50 h-8"
                            type="text"
                            value={readFromValue}
                            onChange={(e) => setReadFromValue(e.target.value)}
                            placeholder={
                              readStartMode === 'tailOffset' ? '10' : '0'
                            }
                          />
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                                Limit (count)
                              </Label>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[200px] text-xs">
                              Max records to return per batch (up to 1000).
                              Leave empty for no cap.
                            </TooltipContent>
                          </Tooltip>
                          <Input
                            className="border-border/50 h-8"
                            value={readLimitCount}
                            onChange={(e) => setReadLimitCount(e.target.value)}
                            placeholder="optional"
                          />
                        </div>
                        <div className="space-y-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                                Wait (s)
                              </Label>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[200px] text-xs">
                              Seconds to wait for new records when streaming
                              reaches the tail. Set to 0 to stop immediately at
                              tail.
                            </TooltipContent>
                          </Tooltip>
                          <Input
                            className="border-border/50 h-8"
                            value={readWaitSecs}
                            onChange={(e) => setReadWaitSecs(e.target.value)}
                            placeholder="optional"
                          />
                        </div>
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
                                className="decoration-muted-foreground/40 w-fit cursor-pointer text-xs underline decoration-dotted underline-offset-2"
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
                                className="decoration-muted-foreground/40 w-fit cursor-pointer text-xs underline decoration-dotted underline-offset-2"
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
                    </TooltipProvider>
                  </div>
                  <div className="border-border/30 border-t p-3">
                    <TooltipProvider>
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-border/50 h-8 flex-1"
                                onClick={() => void readOnce()}
                                disabled={isStreaming}
                              >
                                Read Once
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[200px] text-xs">
                              Fetch a single batch of records with the current
                              settings.
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="text-muted-foreground h-8 w-8"
                                onClick={() => void copyCurl(false)}
                              >
                                {readCurlCopied ? (
                                  <Check className="h-3 w-3" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                              Copy curl command
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <div className="flex gap-2">
                          {!isStreaming ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  className="h-8 flex-1"
                                  onClick={() => void startStreaming()}
                                >
                                  <Play className="mr-1 h-3 w-3" />
                                  Stream
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-[220px] text-xs">
                                Open a continuous read session that tails new
                                records as they arrive. Uses Wait (s) to hold
                                the connection open at the tail.
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-8 flex-1"
                              onClick={() => void stopStreaming()}
                            >
                              <Square className="mr-1 h-3 w-3" />
                              Stop
                            </Button>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="text-muted-foreground h-8 w-8"
                                onClick={() => void copyCurl(true)}
                              >
                                {streamCurlCopied ? (
                                  <Check className="h-3 w-3" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                              Copy curl command
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </TooltipProvider>
                    <div className="text-muted-foreground/60 mt-2 flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                      <span>{recordsReceived} records</span>
                      <span>&middot;</span>
                      <span>{recordsPerSecond}/s</span>
                    </div>
                  </div>
                </div>
                <div className="border-border/50 flex min-h-[400px] flex-col overflow-hidden rounded-lg border xl:min-h-0">
                  <div className="border-border/30 flex shrink-0 items-center gap-2 border-b px-3 py-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground ml-auto h-6 gap-1 px-2 text-xs"
                      onClick={() => recordViewRef.current?.clear()}
                    >
                      <Eraser className="h-3 w-3" />
                      Clear
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <RecordView ref={recordViewRef} />
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent
              value="append"
              forceMount
              className={cn('mt-2', activeTab !== 'append' && 'hidden')}
            >
              <div className="grid gap-3 xl:h-[calc(100vh-200px)] xl:grid-cols-[260px_1fr]">
                <div className="border-border/50 flex flex-col overflow-y-auto rounded-lg border">
                  <div className="space-y-2.5 p-3">
                    <div className="flex items-center justify-between pb-0.5">
                      <span className="text-muted-foreground/60 text-[11px] font-medium tracking-wider uppercase">
                        Append settings
                      </span>
                      <DocsLink
                        href={STUDIO_DOCS.appends}
                        label="Append docs"
                      />
                    </div>
                    <TooltipProvider>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              Input mode
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[220px] text-xs">
                            How to interpret the payload: one record, one record
                            per newline, or a JSON array of{' '}
                            <code className="font-mono">
                              {'{body, headers?, timestamp?}'}
                            </code>{' '}
                            objects. Timestamps are epoch milliseconds or ISO
                            dates.
                          </TooltipContent>
                        </Tooltip>
                        <Select
                          value={appendMode}
                          onValueChange={(v) =>
                            setAppendMode(v as AppendInputMode)
                          }
                        >
                          <SelectTrigger className="border-border/50 h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="single">Single body</SelectItem>
                            <SelectItem value="lines">One per line</SelectItem>
                            <SelectItem value="json-array">
                              JSON array
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              Match Sequence Number
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[240px] text-xs">
                            Conditional append: only succeeds if the stream tail
                            matches this sequence number. Use for optimistic
                            concurrency.
                          </TooltipContent>
                        </Tooltip>
                        <Input
                          className="border-border/50 h-8"
                          aria-label="Match sequence number"
                          value={appendMatchSeqNum}
                          onChange={(e) => setAppendMatchSeqNum(e.target.value)}
                          placeholder="optional"
                        />
                      </div>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              Fencing token
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[220px] text-xs">
                            Required if the stream has an active fence. Must
                            match exactly (max 36 bytes UTF-8). Set a fence via
                            the Commands section below.
                          </TooltipContent>
                        </Tooltip>
                        <Input
                          className="border-border/50 h-8"
                          value={appendFencingToken}
                          onChange={(e) =>
                            setAppendFencingToken(e.target.value)
                          }
                          placeholder="optional"
                        />
                      </div>
                    </TooltipProvider>
                  </div>
                  <div className="border-border/30 border-t p-3">
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        className="h-8 flex-1"
                        onClick={() => void handleAppend()}
                        disabled={appending}
                      >
                        {appending ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Append
                      </Button>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="text-muted-foreground h-8 w-8"
                              onClick={() => void copyAppendCurl()}
                            >
                              {appendCurlCopied ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            Copy curl command
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    {lastAppendAck && (
                      <div className="bg-muted/50 text-muted-foreground/70 mt-2 space-y-0.5 rounded px-2 py-1.5 font-mono text-[10px] tabular-nums">
                        <div className="flex justify-between">
                          <span>start</span>
                          <span>{formatPosition(lastAppendAck.start)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>end</span>
                          <span>{formatPosition(lastAppendAck.end)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>tail</span>
                          <span>{formatPosition(lastAppendAck.tail)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="border-border/30 space-y-2 border-t p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-muted-foreground/50 text-[11px] font-medium tracking-wider uppercase">
                        Commands
                      </h3>
                      <div className="flex items-center gap-2">
                        <DocsLink
                          href={STUDIO_DOCS.retention}
                          label="Trim docs"
                        />
                        <span className="text-muted-foreground/40">
                          &middot;
                        </span>
                        <DocsLink
                          href={STUDIO_DOCS.concurrency}
                          label="Fence docs"
                        />
                      </div>
                    </div>
                    <TooltipProvider>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              Trim through seq #
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[220px] text-xs">
                            Permanently discard all records up to and including
                            this sequence number. Irreversible — use to reclaim
                            storage.
                          </TooltipContent>
                        </Tooltip>
                        <div className="flex gap-1.5">
                          <Input
                            className="border-border/50 h-7 flex-1 text-xs"
                            value={trimSeqNum}
                            onChange={(e) => setTrimSeqNum(e.target.value)}
                            placeholder="e.g. 1000"
                          />
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 w-16 px-2.5 text-xs"
                            onClick={() => void runTrim()}
                            disabled={runningCommand}
                          >
                            Trim
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-muted-foreground decoration-muted-foreground/40 w-fit cursor-default text-[11px] underline decoration-dotted underline-offset-2">
                              Fencing token
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[240px] text-xs">
                            Set a new exclusive write token (max 36 bytes). Once
                            set, all appends must supply this token. Use to
                            ensure only one writer can modify the stream at a
                            time.
                          </TooltipContent>
                        </Tooltip>
                        <div className="flex gap-1.5">
                          <Input
                            className="border-border/50 h-7 flex-1 text-xs"
                            value={nextFenceToken}
                            onChange={(e) => setNextFenceToken(e.target.value)}
                            placeholder="new token"
                          />
                          <Button
                            size="sm"
                            className="h-7 w-16 px-2.5 text-xs"
                            onClick={() => void runFence()}
                            disabled={runningCommand}
                          >
                            Fence
                          </Button>
                        </div>
                      </div>
                    </TooltipProvider>
                    {lastCommandAck && (
                      <div className="bg-muted/50 text-muted-foreground/70 rounded px-2 py-1.5 font-mono text-[10px] tabular-nums">
                        <div className="flex justify-between">
                          <span>tail</span>
                          <span>{formatPosition(lastCommandAck.tail)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="border-border/30 flex min-h-[300px] flex-col overflow-hidden rounded-lg border xl:min-h-0">
                  <div className="border-border/30 flex shrink-0 items-center justify-between border-b px-3 py-1">
                    <span className="text-muted-foreground text-[11px]">
                      Payload
                      <span className="text-muted-foreground/30 ml-1.5">
                        max 1000 records, 1 MiB/batch
                      </span>
                      <a
                        href={STUDIO_DOCS.limits}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-muted-foreground decoration-muted-foreground/40 hover:text-foreground ml-1.5 underline decoration-dotted underline-offset-2 transition-colors"
                      >
                        limits
                      </a>
                    </span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="text-muted-foreground hover:bg-muted hover:text-foreground flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors">
                            <Paperclip className="h-3 w-3" />
                            <span>Load file</span>
                            <input
                              type="file"
                              className="hidden"
                              accept=".txt,.json,.jsonl,.ndjson"
                              onChange={(e) => void onAppendFileSelected(e)}
                            />
                          </label>
                        </TooltipTrigger>
                        <TooltipContent
                          side="left"
                          className="max-w-[220px] text-xs"
                        >
                          Load a file into the payload editor. Input mode is
                          auto-detected from the extension: .json → JSON array,
                          .jsonl/.ndjson → one per line, .txt → single body.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <textarea
                    className="bg-muted/40 text-foreground placeholder:text-muted-foreground min-h-0 flex-1 resize-none border-0 p-3 font-mono text-sm focus:ring-0 focus:outline-none"
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
                </div>
              </div>
            </TabsContent>
          </Tabs>
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
                <DialogTitle className="text-lg">
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
                  onClick={() => setTrimConfirmSeqNum(null)}
                  disabled={runningCommand}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
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
  );
}
