'use client';
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from 'react-query';
import { motion } from 'motion/react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { ListBasinsResponse } from '@s2-dev/streamstore';
import Loading from '../components/Loading';
import CreateEditBasin from './CreateEditBasin';
import { fetchBasinsData } from './api';
import EmptyList from '../components/EmptyList';
import TableBasins from './TableBasins';
import { useIsMobile } from '../hooks/use-mobile';
import { toast } from '../ui/use-toast';
import { Input } from '../ui/input';
import DeleteBasinDialog from './DeleteBasin';
import { useDashboardHost } from './dashboard-host';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { DefaultLocationControl } from './locations';

const BASINS_PER_PAGE = 25;

export default function Basins(): JSX.Element {
  const { scopeKey } = useDashboardHost();
  return <BasinsList key={JSON.stringify(scopeKey)} />;
}

function BasinsList(): JSX.Element {
  const { getClient, scopeKey, slots, route } = useDashboardHost();
  const PrivateConnectivity = slots?.PrivateConnectivity;
  const isMobile = useIsMobile(1280, true);
  const [searchTerm, setSearchTerm] = useState('');
  const [createEditBasinFormOpen, setCreateEditBasinFormOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedBasins, setSelectedBasins] = useState<string[]>([]);

  const [prefix, setPrefix] = useState('');
  const { data, isLoading, isFetching, hasNextPage, fetchNextPage, error } =
    useInfiniteQuery(
      ['basins', scopeKey, prefix],
      async ({ pageParam = '' }): Promise<ListBasinsResponse> => {
        const s2 = await getClient();
        if (s2 === null) throw new Error('No auth token found');
        return fetchBasinsData(s2, {
          prefix: prefix || undefined,
          startAfter: pageParam,
          limit: BASINS_PER_PAGE,
        });
      },
      {
        getNextPageParam: (page) =>
          page.hasMore ? page.basins.at(-1)?.name : undefined,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
      }
    );
  const localBasins = data?.pages.flatMap((page) => page.basins) ?? [];

  useEffect(() => {
    if (error) {
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Unknown error occurred',
        variant: 'destructive',
      });
    }
  }, [error]);

  useEffect(() => {
    const timer = setTimeout(() => setPrefix(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  if (isMobile && route.basinId) {
    return <></>;
  }

  // Wait for connection strings on the first paint too, so the tab decision is
  // settled before render and the Private Connectivity tab doesn't pop in after
  // the basin list. react-query clears isLoading on error, so this can't hang.
  if (isLoading && localBasins.length === 0 && !prefix.length) {
    return <Loading />;
  }

  const hasActiveSearch = prefix.length > 0;

  const basinsList = (
    <div className="space-y-2">
      {(localBasins.length !== 0 || hasActiveSearch || isLoading) && (
        <Input
          placeholder="Filter by prefix..."
          onChange={(e): void => setSearchTerm(e.target.value)}
          value={searchTerm}
          type="search"
        />
      )}
      {localBasins.length > 0 || hasActiveSearch || isLoading ? (
        <>
          <TableBasins
            data={localBasins}
            onSelectedBasinsChange={setSelectedBasins}
          />
          {hasNextPage && (
            <Button
              variant="outline"
              onClick={() => void fetchNextPage()}
              disabled={isFetching}
              className="w-full"
            >
              {isFetching ? 'Loading...' : 'Load More'}
            </Button>
          )}
        </>
      ) : (
        <EmptyList
          title="You haven't configured any basins yet"
          description="Once you configure a basin, you'll be able to set up streams."
          cta={{
            label: 'Create Basin',
            onClick: (): void => setCreateEditBasinFormOpen(true),
          }}
        />
      )}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`w-full max-w-4xl flex-1 space-y-2 pt-0 xl:pt-4 ${route.basinId ? 'hidden xl:block' : ''}`}
    >
      <motion.div layout className="flex justify-between">
        <motion.h1
          layout="position"
          className="mt-[2px] mb-2 text-2xl tracking-tight"
        >
          Basins
        </motion.h1>
        <div className="flex items-center gap-3">
          <DefaultLocationControl />
          {selectedBasins.length > 0 && (
            <Button
              onClick={(): void => {
                setDeleteDialogOpen(true);
              }}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="mr-1 h-4 w-4" />
              Delete{' '}
              {selectedBasins.length > 1 ? `(${selectedBasins.length})` : ''}
            </Button>
          )}
          {/* Kept visible during an active search: a search matching nothing
              still renders the table, not the empty-state CTA, so gating on the
              row count alone would leave no way to create a basin. */}
          {(localBasins.length > 0 || hasActiveSearch) && (
            <Button
              onClick={(): void => setCreateEditBasinFormOpen(true)}
              size="sm"
              variant={route.basinId ? 'outline' : 'default'}
            >
              <Plus />
              Create Basin
            </Button>
          )}
        </div>
      </motion.div>
      {PrivateConnectivity ? (
        <Tabs defaultValue="basins">
          <TabsList className="mb-2 w-full">
            <TabsTrigger value="basins" className="w-full">
              Basins
            </TabsTrigger>
            <TabsTrigger value="private-connectivity" className="w-full">
              Private Connectivity
            </TabsTrigger>
          </TabsList>
          <TabsContent value="basins">{basinsList}</TabsContent>
          <TabsContent value="private-connectivity">
            <PrivateConnectivity />
          </TabsContent>
        </Tabs>
      ) : (
        basinsList
      )}
      {createEditBasinFormOpen && (
        <CreateEditBasin
          data={null}
          onClose={(): void => {
            setCreateEditBasinFormOpen(false);
          }}
        />
      )}
      {deleteDialogOpen && selectedBasins.length > 0 && (
        <DeleteBasinDialog
          ids={selectedBasins}
          onClose={() => {
            setDeleteDialogOpen(false);
            setSelectedBasins([]);
          }}
        />
      )}
    </motion.div>
  );
}
