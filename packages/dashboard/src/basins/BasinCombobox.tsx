'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { toast } from '../ui/use-toast';
import { fetchBasinsData } from './api';
import { useDashboardHost } from './dashboard-host';
import type { BasinInfo } from '@s2-dev/streamstore';

const PAGE_SIZE = 25;

interface BasinComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function BasinCombobox({
  value,
  onValueChange,
  disabled,
  className,
}: BasinComboboxProps) {
  const { getClient, scopeKey } = useDashboardHost();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [basins, setBasins] = useState<BasinInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRequestIdRef = useRef(0);

  // Only the most recent request may touch state. A "load more" for one search
  // term can still be in flight when the term changes; without this guard its
  // late response appends the old term's basins onto the new term's results.
  const fetchPage = useCallback(
    async (prefix: string, after: string, replace: boolean) => {
      const requestId = ++latestRequestIdRef.current;
      setIsLoading(true);
      setError(null);
      try {
        const s2 = await getClient();
        if (s2 === null) throw new Error('No auth token found');
        if (latestRequestIdRef.current !== requestId) return;
        const res = await fetchBasinsData(s2, {
          prefix: prefix || undefined,
          startAfter: after || undefined,
          limit: PAGE_SIZE,
        });
        if (latestRequestIdRef.current !== requestId) return;
        setBasins((prev) => (replace ? res.basins : [...prev, ...res.basins]));
        setHasMore(res.hasMore);
      } catch (error) {
        if (latestRequestIdRef.current !== requestId) return;
        const message =
          error instanceof Error ? error.message : 'Unknown error occurred';
        if (replace) {
          setBasins([]);
          setHasMore(false);
        }
        setError(message);
        toast({
          title: 'Error loading basins',
          description: message,
          variant: 'destructive',
        });
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [getClient]
  );

  useEffect(() => {
    if (open) {
      setSearch('');
      setBasins([]);
      setHasMore(false);
      void fetchPage('', '', true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, fetchPage, scopeKey]);

  useEffect(() => {
    if (!open) return;
    // Retire in-flight requests the moment the term changes, not when the
    // debounced fetch finally fires. Bumping this only inside fetchPage would
    // leave the whole debounce window open, during which a "load more" for the
    // previous term can still resolve and append its basins to the new list.
    latestRequestIdRef.current++;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchPage(search, '', true);
    }, 300);
    return () => {
      latestRequestIdRef.current++;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, open, fetchPage, scopeKey]);

  const loadMore = () => {
    const lastItem = basins.at(-1)?.name ?? '';
    void fetchPage(search, lastItem, false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          className={cn(
            'border-border/50 h-8 w-[160px] justify-between text-sm sm:w-[220px]',
            className
          )}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || 'Select a basin'}
          </span>
          <ChevronDown className="ml-1 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <div className="border-border/50 border-b px-2 py-1.5">
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by prefix…"
            className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[280px] overflow-y-auto">
          {error && (
            <p role="alert" className="text-destructive px-3 py-2 text-xs">
              {error}
            </p>
          )}
          {isLoading && basins.length === 0 ? (
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          ) : basins.length === 0 && !error ? (
            <p className="text-muted-foreground px-3 py-4 text-center text-xs">
              No basins found
            </p>
          ) : (
            <>
              {basins.map((basin) => (
                <button
                  key={basin.name}
                  className={cn(
                    'hover:bg-muted flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] transition-colors',
                    value === basin.name && 'bg-muted'
                  )}
                  onClick={() => {
                    onValueChange(basin.name);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'h-3 w-3 shrink-0',
                      value === basin.name ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">{basin.name}</span>
                </button>
              ))}
              {hasMore && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full rounded-none text-xs"
                  onClick={loadMore}
                  disabled={isLoading}
                >
                  {isLoading ? 'Loading…' : 'Load More'}
                </Button>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
