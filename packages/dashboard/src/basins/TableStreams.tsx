'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { useState } from 'react';
import CreateEditStreamDialog from './CreateEditStream';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import {
  Copy,
  Ellipsis,
  KeyRound,
  Settings2,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { toast } from '../ui/use-toast';
import { getStreamConfig } from './api';
import DeleteStreamDialog from './DeleteStream';
import { S2Error } from '@s2-dev/streamstore';
import { StreamConfig, StreamInfo } from '@s2-dev/streamstore';
import { Checkbox } from '../ui/checkbox';
import { useTableSelection } from '../hooks/use-table-selection';
import { useDashboardHost } from './dashboard-host';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import { formatUTCDateTime } from '../lib/date-time';

interface TableStreamsProps {
  data: StreamInfo[];
  onSelectedStreamsChange: (selectedStreams: string[]) => void;
}

const TableStreams = ({ data, onSelectedStreamsChange }: TableStreamsProps) => {
  const { getClient, route, Link } = useDashboardHost();
  const basinId = route.basinId ?? '';
  const [deleteDialog, setDeleteDialog] = useState<null | string[]>(null);
  const [configDialog, setConfigDialog] = useState<{
    id: string;
    config: StreamConfig;
  } | null>(null);
  const [similarDialog, setSimilarDialog] = useState<StreamConfig | null>(null);

  const fetchConfig = async (
    streamName: string
  ): Promise<StreamConfig | null> => {
    try {
      const s2 = await getClient();
      if (s2 === null) {
        toast({
          title: 'Error fetching token',
          description: 'Please log in again or switch to local no-auth mode.',
          variant: 'destructive',
        });
        return null;
      }
      return await getStreamConfig(basinId, streamName, s2);
    } catch (err: unknown) {
      toast({
        title: 'Error fetching stream configuration',
        description: err instanceof S2Error ? err.message : undefined,
        variant: 'destructive',
      });
      return null;
    }
  };

  const {
    selectedItems: selectedStreams,
    handleItemSelect: handleStreamSelect,
    handleSelectAll,
    getHeaderCheckboxState,
  } = useTableSelection(
    data
      .filter((stream) => !stream.deletedAt)
      .map((stream) => ({ id: stream.name })),
    onSelectedStreamsChange || (() => {})
  );

  return (
    <>
      <TooltipProvider>
        <Table
          key={(data[0]?.name || 'empty') + data.length}
          className="table-fixed"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-14 pl-0">
                <Checkbox
                  checked={getHeaderCheckboxState()}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all streams"
                  disabled={data.length === 0}
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-24">State</TableHead>
              <TableHead className="w-56">Created At (UTC)</TableHead>
              <TableHead className="w-14 pr-0"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((stream) => (
              <TableRow key={stream.name} className="h-[57px]">
                <TableCell className="w-14 pt-3 pl-0">
                  <Checkbox
                    checked={selectedStreams.has(stream.name)}
                    onCheckedChange={(checked) => {
                      handleStreamSelect(stream.name, !!checked);
                    }}
                    aria-label={`Select stream ${stream.name}`}
                    disabled={!!stream.deletedAt}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <Link
                      href={`/dashboard/basins/${encodeURIComponent(basinId)}/studio?stream=${encodeURIComponent(stream.name)}`}
                      className="min-w-0 flex-1 truncate hover:underline"
                      title={stream.name}
                    >
                      {stream.name}
                    </Link>
                    {stream.cipher && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            aria-label={`Encrypted stream. Cipher: ${stream.cipher}`}
                            className="border-border/60 bg-muted/30 text-muted-foreground focus-visible:ring-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          <code className="font-mono">{stream.cipher}</code>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {!stream.deletedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0 p-0"
                        asChild
                      >
                        <Link
                          href={`/dashboard/basins/${encodeURIComponent(basinId)}/studio?stream=${encodeURIComponent(stream.name)}`}
                          title="Open in Studio"
                        >
                          <SquareTerminal className="h-3 w-3" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded-full px-2 py-1 text-xs capitalize ${
                      stream.deletedAt
                        ? 'dark:bg-muted opacity-40'
                        : 'border font-semibold'
                    }`}
                  >
                    {stream.deletedAt ? 'Deleting' : 'Active'}
                  </span>
                </TableCell>
                <TableCell>{formatUTCDateTime(stream.createdAt)}</TableCell>
                <TableCell className="w-10 pr-0">
                  {!stream.deletedAt && (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="w-10" size="icon">
                          <Ellipsis />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/dashboard/basins/${encodeURIComponent(basinId)}/studio?stream=${encodeURIComponent(stream.name)}`}
                            className="flex items-center gap-2"
                          >
                            <SquareTerminal className="h-4 w-4" />
                            Open in Studio
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            const config = await fetchConfig(stream.name);
                            if (config === null) return;
                            setConfigDialog({ id: stream.name, config });
                          }}
                        >
                          <Settings2 className="h-4 w-4" />
                          Edit configuration
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            const config = await fetchConfig(stream.name);
                            if (config === null) return;
                            setSimilarDialog(config);
                          }}
                        >
                          <Copy className="h-4 w-4" />
                          Create similar stream
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive dark:text-red-400 dark:focus:text-red-400"
                          onClick={() => {
                            setDeleteDialog([stream.name]);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete stream
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TooltipProvider>
      {similarDialog && basinId && (
        <CreateEditStreamDialog
          basinId={basinId}
          data={null}
          defaultConfig={similarDialog}
          onClose={() => {
            setSimilarDialog(null);
          }}
        />
      )}
      {configDialog && typeof basinId === 'string' && (
        <CreateEditStreamDialog
          basinId={basinId}
          data={configDialog}
          onClose={() => {
            setConfigDialog(null);
          }}
        />
      )}
      {deleteDialog && (
        <DeleteStreamDialog
          ids={deleteDialog}
          onClose={() => {
            setDeleteDialog(null);
          }}
        />
      )}
    </>
  );
};

export default TableStreams;
