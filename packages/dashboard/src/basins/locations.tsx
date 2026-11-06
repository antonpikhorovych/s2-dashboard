'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import type { LocationInfo } from '@s2-dev/streamstore';
import { S2Error } from '@s2-dev/streamstore';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from '../ui/use-toast';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import { getDefaultLocation, listLocations, setDefaultLocation } from './api';
import { useDashboardHost } from './dashboard-host';

const LOCATIONS_DOCS = 'https://s2.dev/docs/concepts/basins#location';

// Locations change rarely and each lookup is an account control op, so both
// queries are shared across the Basins page and the create dialog and kept
// for a while; the default is re-read only after it is changed here.
const LOCATION_QUERY_OPTIONS = {
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
} as const;

export function locationLabel(location: LocationInfo): string {
  return location.isPrivate ? `${location.name} (account-only)` : location.name;
}

export function useLocations(enabled = true) {
  const { getClient, scopeKey, capabilities } = useDashboardHost();
  return useQuery(
    ['locations', scopeKey],
    async () => {
      const s2 = await getClient();
      if (s2 === null) throw new Error('No auth token');
      return await listLocations(s2);
    },
    { ...LOCATION_QUERY_OPTIONS, enabled: enabled && capabilities.locations }
  );
}

export function useDefaultLocation(enabled = true) {
  const { getClient, scopeKey, capabilities } = useDashboardHost();
  return useQuery(
    ['default-location', scopeKey],
    async () => {
      const s2 = await getClient();
      if (s2 === null) throw new Error('No auth token');
      return await getDefaultLocation(s2);
    },
    { ...LOCATION_QUERY_OPTIONS, enabled: enabled && capabilities.locations }
  );
}

/* Compact "default location for new basins" picker for the Basins header. */
export function DefaultLocationControl(): JSX.Element | null {
  const { getClient, scopeKey, capabilities } = useDashboardHost();
  const queryClient = useQueryClient();
  const { data: defaultLocation, isError } = useDefaultLocation();
  const { data: locations } = useLocations();
  const [isSaving, setIsSaving] = useState(false);

  if (!capabilities.locations || isError) return null;

  const options = locations ?? (defaultLocation ? [defaultLocation] : []);

  const handleChange = async (name: string) => {
    if (name === defaultLocation?.name) return;
    setIsSaving(true);
    try {
      const s2 = await getClient();
      if (s2 === null) throw new Error('No auth token');
      const updated = await setDefaultLocation(s2, name);
      queryClient.setQueryData(['default-location', scopeKey], updated);
      toast({
        title: 'Default location updated',
        description: `New basins will be created in ${updated.name}.`,
      });
    } catch (err: unknown) {
      toast({
        title: 'Error updating default location',
        description: err instanceof S2Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <span className="hidden sm:inline">
        Default{' '}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hover:text-foreground cursor-help underline decoration-dotted underline-offset-4">
                location
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                Used for new basins that don&apos;t pick a location. Existing
                basins keep theirs.
              </p>
              <a
                href={LOCATIONS_DOCS}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block underline underline-offset-2"
              >
                Read more about locations
              </a>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        :
      </span>
      <Select
        value={defaultLocation?.name ?? ''}
        onValueChange={(value) => void handleChange(value)}
        disabled={defaultLocation === undefined || isSaving}
      >
        <SelectTrigger
          aria-label="Default location"
          className="h-7 w-auto gap-1 px-2 text-sm"
        >
          {defaultLocation === undefined ? (
            <span className="text-muted-foreground">Loading…</span>
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent>
          {options.map((loc) => (
            <SelectItem key={loc.name} value={loc.name}>
              {locationLabel(loc)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
