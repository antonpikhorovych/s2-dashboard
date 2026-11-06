'use client';
import { FormEvent, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { StreamConfig } from '@s2-dev/streamstore';
import type { S2 } from '@s2-dev/streamstore';
import { toast } from '../ui/use-toast';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { useQueryClient } from 'react-query';
import { createStream, updateStreamConfig, isTierRelatedError } from './api';
import { S2Error } from '@s2-dev/streamstore';
import StreamConfigInputs from './StreamConfigInputs';
import { createDashboardClient, useDashboardHost } from './dashboard-host';

type CreateEditStreamDialogProps =
  | {
      basinId: string;
      data: { id: string; config: StreamConfig };
      defaultConfig?: never;
      copiedFrom?: never;
      onClose: () => void;
      onSuccess?: () => void;
    }
  | {
      basinId: string;
      data: null;
      defaultConfig?: StreamConfig | null;
      /* Name of the stream whose config seeds the form ("Copy stream configuration"). */
      copiedFrom?: string;
      onClose: () => void;
      onSuccess?: () => void;
    };

const CreateEditStreamDialog = ({
  basinId,
  data,
  defaultConfig,
  copiedFrom,
  onClose,
  onSuccess,
}: CreateEditStreamDialogProps) => {
  const queryClient = useQueryClient();
  const { getClient, endpoints, recoverFromTierError } = useDashboardHost();

  const [streamId, setStreamId] = useState(data?.id || '');
  const [config, setConfig] = useState<StreamConfig>(
    data?.config || defaultConfig || {}
  );
  const [isAwaiting, setIsAwaiting] = useState(false);

  const submitWithClient = async (s2: S2) => {
    if (data) {
      await updateStreamConfig(basinId, streamId, config, s2);
    } else {
      await createStream(basinId, { stream: streamId, config }, s2);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsAwaiting(true);

    const s2 = await getClient();

    if (s2 === null) {
      toast({
        title: 'Error creating stream',
        description: 'No auth token found',
        variant: 'destructive',
      });
      setIsAwaiting(false);
      return;
    }

    try {
      try {
        await submitWithClient(s2);
      } catch (err: unknown) {
        if (
          recoverFromTierError &&
          err instanceof S2Error &&
          isTierRelatedError(err.message)
        ) {
          const refreshedToken = await recoverFromTierError();
          if (refreshedToken !== null) {
            await submitWithClient(
              createDashboardClient(refreshedToken, endpoints)
            );
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      toast({
        title: `Stream ${data ? 'updated' : 'created'} successfully`,
        description: `Stream ${streamId} ${data ? 'updated' : 'created'} successfully`,
        variant: 'default',
      });
      queryClient.invalidateQueries('streams');
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      if (err instanceof S2Error) {
        toast({
          title: `Error ${data ? 'updating' : 'creating'} stream`,
          description: err.message,
          variant: 'destructive',
        });
      } else {
        toast({
          title: `Error ${data ? 'updating' : 'creating'} stream`,
          variant: 'destructive',
        });
      }
    } finally {
      setIsAwaiting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(openState) => !openState && onClose()}>
      <DialogContent className="mx-auto flex max-h-[90vh] w-[90vw] max-w-lg flex-col">
        <DialogHeader className="mb-2 flex-shrink-0">
          <DialogTitle>
            {data ? `${data.id}` : 'Create a new stream'}
          </DialogTitle>
          <DialogDescription>
            {data
              ? 'Configuration for this stream.'
              : copiedFrom
                ? `Starts from the configuration of ${copiedFrom}.`
                : 'Name the stream and optionally override its configuration.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="[&::-webkit-scrollbar-thumb]:dark:bg-muted-foreground/40 hover:[&::-webkit-scrollbar-thumb]:dark:bg-muted-foreground/60 flex-1 space-y-5 overflow-y-auto pr-3 pl-1 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
            <div className="space-y-2">
              <Label htmlFor="streamId">Stream Name</Label>
              <Input
                id="streamId"
                type="text"
                required
                value={streamId}
                onChange={(e) => setStreamId(e.target.value)}
                placeholder="Enter stream name"
                autoComplete="off"
                maxLength={512}
                disabled={Boolean(data)}
              />
            </div>
            <StreamConfigInputs config={config} setConfig={setConfig} />
            <Button type="submit" disabled={isAwaiting} className="w-full">
              {isAwaiting
                ? data
                  ? 'Updating...'
                  : 'Creating...'
                : `${data ? 'Update' : 'Create'} Stream`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateEditStreamDialog;
