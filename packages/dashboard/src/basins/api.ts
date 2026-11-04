import { AppendInput, AppendRecord, S2 } from '@s2-dev/streamstore';
import type {
  AppendAck,
  BasinConfig,
  ReconfigureBasinInput,
  CreateStreamInput,
  CreateStreamResponse,
  EncryptionKeyInput,
  ListBasinsInput,
  ListLocationsResponse,
  ListStreamsInput,
  LocationInfo,
  StreamConfig,
  ListBasinsResponse,
  ListStreamsResponse,
  ReadBatch,
  ReadInput,
  ReadSession,
  ReadStop,
  ReconfigureStreamInput,
  S2RequestOptions,
  TailResponse,
} from '@s2-dev/streamstore';

export function isTierRelatedError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('retention is currently limited') ||
    normalized.includes('frozen account')
  );
}

// BASINS

export async function fetchBasinsData(
  s2: S2,
  request?: ListBasinsInput
): Promise<ListBasinsResponse> {
  return await s2.basins.list({
    limit: request?.limit,
    prefix: request?.prefix,
    startAfter: request?.startAfter,
  });
}

export async function createBasin(
  s2: S2,
  basinId: string,
  config: BasinConfig,
  location?: string
) {
  await s2.basins.create({
    basin: basinId,
    config: config,
    ...(location !== undefined ? { location } : {}),
  });
}

export async function listLocations(s2: S2): Promise<ListLocationsResponse> {
  return await s2.locations.list();
}

export async function getDefaultLocation(s2: S2): Promise<LocationInfo> {
  return await s2.locations.getDefault();
}

export async function setDefaultLocation(
  s2: S2,
  location: string
): Promise<LocationInfo> {
  return await s2.locations.setDefault({ location });
}

export async function getBasinConfig(
  s2: S2,
  basinId: string
): Promise<BasinConfig> {
  return await s2.basins.getConfig({
    basin: basinId,
  });
}

export async function updateBasinConfig(
  s2: S2,
  basinId: string,
  config: Omit<ReconfigureBasinInput, 'basin'>
) {
  await s2.basins.reconfigure({
    basin: basinId,
    ...config,
  });
}

export async function deleteBasin(s2: S2, basinId: string) {
  await s2.basins.delete({ basin: basinId });
}

// STREAMS

export async function fetchStreamsData(
  s2: S2,
  request: { basinId: string } & ListStreamsInput
): Promise<ListStreamsResponse> {
  const basin = s2.basin(request.basinId);
  return await basin.streams.list({
    prefix: request.prefix,
    startAfter: request.startAfter,
    limit: request.limit,
  });
}

export async function createStream(
  basinId: string,
  request: CreateStreamInput,
  s2: S2
): Promise<CreateStreamResponse> {
  const basin = s2.basin(basinId);
  return await basin.streams.create(request);
}

export async function deleteStream(
  basinId: string,
  streamId: string,
  s2: S2
): Promise<void> {
  const basin = s2.basin(basinId);
  await basin.streams.delete({ stream: streamId });
}

export async function updateStreamConfig(
  basinId: string,
  streamId: string,
  config: Omit<ReconfigureStreamInput, 'stream'>,
  s2: S2
): Promise<StreamConfig> {
  const basin = s2.basin(basinId);
  return await basin.streams.reconfigure({
    stream: streamId,
    ...config,
  });
}

export async function getStreamConfig(
  basinId: string,
  streamId: string,
  s2: S2
): Promise<StreamConfig> {
  const basin = s2.basin(basinId);
  return await basin.streams.getConfig({ stream: streamId });
}

export interface StudioAppendRecordInput {
  body: string;
  headers?: ReadonlyArray<readonly [string, string]>;
  timestamp?: number | Date;
}

export interface StudioAppendInput {
  records: StudioAppendRecordInput[];
  matchSeqNum?: number;
  fencingToken?: string;
}

export async function appendToStream(
  s2: S2,
  basinId: string,
  streamId: string,
  input: StudioAppendInput,
  encryptionKey?: EncryptionKeyInput
): Promise<AppendAck> {
  const stream = s2.basin(basinId).stream(streamId, { encryptionKey });

  const records = input.records.map((record) =>
    AppendRecord.string({
      body: record.body,
      headers: record.headers,
      timestamp: record.timestamp,
    })
  );

  return await stream.append(
    AppendInput.create(records, {
      matchSeqNum: input.matchSeqNum,
      fencingToken: input.fencingToken,
    })
  );
}

export async function checkStreamTail(
  s2: S2,
  basinId: string,
  streamId: string
): Promise<TailResponse> {
  const stream = s2.basin(basinId).stream(streamId);
  return await stream.checkTail();
}

export async function trimStream(
  s2: S2,
  basinId: string,
  streamId: string,
  trimToSeqNum: number,
  fencingToken?: string,
  encryptionKey?: EncryptionKeyInput
): Promise<AppendAck> {
  const stream = s2.basin(basinId).stream(streamId, { encryptionKey });

  return await stream.append(
    AppendInput.create([AppendRecord.trim(trimToSeqNum)], {
      fencingToken,
    })
  );
}

export async function fenceStream(
  s2: S2,
  basinId: string,
  streamId: string,
  nextFencingToken: string,
  currentFencingToken?: string,
  encryptionKey?: EncryptionKeyInput
): Promise<AppendAck> {
  const stream = s2.basin(basinId).stream(streamId, { encryptionKey });

  return await stream.append(
    AppendInput.create([AppendRecord.fence(nextFencingToken)], {
      fencingToken: currentFencingToken,
    })
  );
}

export async function readStreamBatch(
  s2: S2,
  basinId: string,
  streamId: string,
  input?: ReadInput,
  encryptionKey?: EncryptionKeyInput
): Promise<ReadBatch<'string'>> {
  const stream = s2.basin(basinId).stream(streamId, { encryptionKey });
  return await stream.read(input, { as: 'string' });
}

export async function openReadSession(
  s2: S2,
  basinId: string,
  streamId: string,
  input?: ReadInput,
  stop?: ReadStop,
  requestOptions?: S2RequestOptions,
  encryptionKey?: EncryptionKeyInput
): Promise<ReadSession<'string'>> {
  const stream = s2.basin(basinId).stream(streamId, { encryptionKey });
  return await stream.readSession(
    {
      ...input,
      stop: stop ?? input?.stop,
    },
    {
      ...requestOptions,
      as: 'string',
    }
  );
}
