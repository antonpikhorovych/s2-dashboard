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
import { BasinConfig, EncryptionAlgorithm } from '@s2-dev/streamstore';
import type { S2 } from '@s2-dev/streamstore';
import { toast } from '../ui/use-toast';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { useQueryClient } from 'react-query';
import { createBasin, updateBasinConfig, isTierRelatedError } from './api';
import { S2Error } from '@s2-dev/streamstore';
import StreamConfigInputs, {
  defaultConfig as defaultStreamConfig,
} from './StreamConfigInputs';
import { Info } from 'lucide-react';
import { createDashboardClient, useDashboardHost } from './dashboard-host';
import { locationLabel, useDefaultLocation, useLocations } from './locations';

const DEFAULT_LOCATION_VALUE = '__default__';

type CreateEditBasinDialogProps =
  | {
      data: { id: string; config: BasinConfig; location?: string };
      onClose: () => void;
      onSuccess?: () => void;
      redirectToBasin?: boolean;
    }
  | {
      data: null;
      /* Start from another basin's configuration ("Copy basin configuration"). */
      initialValues?: BasinInitialValues;
      onClose: () => void;
      onSuccess?: () => void;
      redirectToBasin?: boolean;
    };

export interface BasinInitialValues {
  source: string;
  config: BasinConfig;
  location?: string;
}

const ENCRYPTION_ALGORITHMS = [
  'aegis-256',
  'aes-256-gcm',
] as const satisfies readonly EncryptionAlgorithm[];

const CreateEditBasinDialog = (props: CreateEditBasinDialogProps) => {
  const { data, onClose, onSuccess, redirectToBasin = true } = props;
  const initialValues = data ? undefined : props.initialValues;
  const {
    getClient,
    scopeKey,
    capabilities,
    endpoints,
    recoverFromTierError,
    navigate,
  } = useDashboardHost();
  const queryClient = useQueryClient();

  const [basinId, setBasinId] = useState(data?.id || '');
  const [nameTouched, setNameTouched] = useState(false);
  const [config, setConfig] = useState<BasinConfig>(
    data?.config ||
      initialValues?.config || {
        createStreamOnAppend: false,
        createStreamOnRead: false,
        defaultStreamConfig: defaultStreamConfig,
      }
  );
  const [locationSelection, setLocationSelection] = useState<string>(
    initialValues?.location ?? DEFAULT_LOCATION_VALUE
  );
  const [isAwaiting, setIsAwaiting] = useState(false);

  const isCreating = !data;
  const {
    data: locationsResponse,
    isLoading: isLoadingLocations,
    isError: isLocationsError,
  } = useLocations(isCreating);
  const { data: defaultLocation } = useDefaultLocation(isCreating);
  const knownLocations = locationsResponse ?? [];

  // Reset the location selection during render when the org changes,
  // avoiding setState-in-effect (same pattern as Streams.tsx).
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (scopeKey !== prevScopeKey) {
    setPrevScopeKey(scopeKey);
    setLocationSelection(DEFAULT_LOCATION_VALUE);
  }

  const canSubmit = !isAwaiting && (!isCreating || !isLoadingLocations);

  const resolveLocation = (): string | undefined => {
    if (locationSelection === DEFAULT_LOCATION_VALUE) return undefined;
    return locationSelection;
  };

  const submitWithClient = async (s2: S2) => {
    await (data
      ? updateBasinConfig(s2, basinId, config)
      : createBasin(s2, basinId, config, resolveLocation()));
  };

  const nameError = isCreating ? basinNameError(basinId) : null;
  const showNameError = nameTouched && nameError !== null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setNameTouched(true);
    if (nameError !== null) {
      return;
    }
    setIsAwaiting(true);
    const s2 = await getClient();
    if (s2 === null) {
      toast({
        title: 'Error creating basin',
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
        title: `Basin ${data ? 'updated' : 'created'} successfully`,
        description: `Basin ${basinId} ${data ? 'updated' : 'created'} successfully`,
        variant: 'default',
      });
      queryClient.invalidateQueries('basins');
      queryClient.invalidateQueries(['basin-config', scopeKey, basinId]);
      if (redirectToBasin) {
        navigate(`/dashboard/basins/${basinId}`);
      }
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      if (err instanceof S2Error) {
        toast({
          title: `Error ${data ? 'updating' : 'creating'} basin`,
          description: err.message,
          variant: 'destructive',
        });
      } else {
        toast({
          title: `Error ${data ? 'updating' : 'creating'} basin`,
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
            {data ? `${data.id}` : 'Create a new basin'}
          </DialogTitle>
          <DialogDescription>
            {data
              ? 'Configuration for this basin.'
              : initialValues
                ? `Starts from the configuration of ${initialValues.source}.`
                : 'Name the basin and configure its settings.'}
          </DialogDescription>
        </DialogHeader>
        <TooltipProvider>
          <form
            onSubmit={handleSubmit}
            noValidate
            className="flex flex-1 flex-col overflow-hidden"
          >
            <div className="[&::-webkit-scrollbar-thumb]:dark:bg-muted-foreground/40 hover:[&::-webkit-scrollbar-thumb]:dark:bg-muted-foreground/60 flex-1 space-y-5 overflow-y-auto pr-3 pl-1 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
              <div className="space-y-2">
                <Label htmlFor="basinId">Basin Name</Label>
                <Input
                  id="basinId"
                  type="text"
                  value={basinId}
                  onChange={(e) => {
                    setBasinId(e.target.value);
                    setNameTouched(true);
                  }}
                  placeholder="Enter basin name"
                  autoComplete="off"
                  aria-invalid={showNameError}
                  disabled={Boolean(data)}
                />
                {showNameError && (
                  <p className="text-destructive text-xs dark:text-red-400">
                    {nameError}
                  </p>
                )}
              </div>
              {isCreating && capabilities.locations && (
                <div className="space-y-2">
                  <Label htmlFor="location">Location</Label>
                  <Select
                    value={locationSelection}
                    onValueChange={(value) => setLocationSelection(value)}
                    disabled={isLoadingLocations}
                  >
                    <SelectTrigger id="location">
                      {isLoadingLocations ? (
                        <span className="text-muted-foreground">
                          Loading locations…
                        </span>
                      ) : (
                        <SelectValue />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_LOCATION_VALUE}>
                        Account default
                        {defaultLocation ? ` (${defaultLocation.name})` : ''}
                      </SelectItem>
                      {knownLocations.map((loc) => (
                        <SelectItem key={loc.name} value={loc.name}>
                          {locationLabel(loc)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isLocationsError ? (
                    <p className="text-destructive text-xs dark:text-red-400">
                      Couldn&apos;t load locations — basin will be created in
                      your account default.
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Choose the location closest to your clients for the lowest
                      latency. This is immutable per basin.
                    </p>
                  )}
                </div>
              )}
              {!isCreating && capabilities.locations && data.location && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="location">Location</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="text-muted-foreground h-4 w-4" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          A basin&apos;s location is fixed at creation. To use a
                          different location, create a new basin there.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    id="location"
                    type="text"
                    value={data.location}
                    readOnly
                    disabled
                  />
                </div>
              )}
              <fieldset className="rounded-lg border p-4">
                <legend className="text-xs">
                  Create Streams Automatically
                </legend>
                <div className="flex flex-row gap-6">
                  <div className="flex items-center space-x-3">
                    <Switch
                      id="createStreamOnAppend"
                      checked={config?.createStreamOnAppend}
                      onCheckedChange={(checked) => {
                        setConfig((prev) => ({
                          ...prev,
                          createStreamOnAppend: checked,
                        }));
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Label htmlFor="createStreamOnAppend" className="text-sm">
                        on append
                      </Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="text-muted-foreground h-4 w-4" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>
                            Create stream on append if it doesn&apos;t exist,
                            using the default stream configuration.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <Switch
                      id="createStreamOnRead"
                      checked={config?.createStreamOnRead}
                      onCheckedChange={(checked) => {
                        setConfig((prev) => ({
                          ...prev,
                          createStreamOnRead: checked,
                        }));
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Label htmlFor="createStreamOnRead" className="text-sm">
                        on read
                      </Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="text-muted-foreground h-4 w-4" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>
                            Create stream on read if it doesn&apos;t exist,
                            using the default stream configuration.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              </fieldset>
              <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4">
                <div className="flex items-center gap-2">
                  <Label>Stream Cipher</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="text-muted-foreground h-4 w-4" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>
                        Encryption algorithm applied to newly created streams in
                        this basin. Existing streams are not affected.
                      </p>
                      <p className="mt-1">
                        <strong>
                          Encrypted streams require a client-supplied encryption
                          key
                        </strong>{' '}
                        on append and read requests.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select
                  value={config.streamCipher ?? 'none'}
                  onValueChange={(value) => {
                    setConfig((prev) => ({
                      ...prev,
                      streamCipher:
                        value === 'none'
                          ? null
                          : (value as EncryptionAlgorithm),
                    }));
                  }}
                >
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {ENCRYPTION_ALGORITHMS.map((algo) => (
                      <SelectItem key={algo} value={algo}>
                        {algo}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <fieldset className="flex flex-col gap-5 rounded-lg border p-4">
                <legend className="self-start text-xs">
                  Default Stream Configuration
                </legend>
                <StreamConfigInputs
                  config={config.defaultStreamConfig}
                  setConfig={(update) => {
                    setConfig((prev) => ({
                      ...prev,
                      defaultStreamConfig: update(prev.defaultStreamConfig),
                    }));
                  }}
                />
              </fieldset>
              <Button type="submit" disabled={!canSubmit} className="w-full">
                {isAwaiting
                  ? data
                    ? 'Updating...'
                    : 'Creating...'
                  : `${data ? 'Update' : 'Create'} Basin`}
              </Button>
            </div>
          </form>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
};

const BASIN_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function basinNameError(name: string): string | null {
  if (name.length === 0) {
    return 'Basin name is required.';
  }
  if (name.length < 8 || name.length > 48) {
    return 'Basin name must be 8 to 48 characters.';
  }
  if (!BASIN_NAME_PATTERN.test(name)) {
    return 'Basin name may only contain lowercase letters, numbers, and hyphens, and must start and end with a letter or number.';
  }
  return null;
}

export default CreateEditBasinDialog;
