'use client';
import { Fragment, useState } from 'react';
import { Button } from '../ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ChevronRight, Copy, Ellipsis, Settings2, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { getBasinConfig } from './api';
import { toast } from '../ui/use-toast';
import clsx from 'clsx';

import CreateEditBasinDialog, {
  type BasinInitialValues,
} from './CreateEditBasin';
import DeleteBasinDialog from './DeleteBasin';
import type { BasinConfig, BasinInfo } from '@s2-dev/streamstore';
import { S2Error } from '@s2-dev/streamstore';
import { Checkbox } from '../ui/checkbox';
import { useTableSelection } from '../hooks/use-table-selection';
import { useDashboardHost } from './dashboard-host';
import { isDashboardSection } from '../lib/dashboard-routes';

interface TableBasinsProps {
  data: BasinInfo[];
  onSelectedBasinsChange?: (selectedBasins: string[]) => void;
}

const getBasinStateLabel = (basin: BasinInfo): 'active' | 'deleting' => {
  // SDK v0.24 models basin deletion with deletedAt and no longer exposes basin.state.
  return basin.deletedAt ? 'deleting' : 'active';
};

const TableBasins = ({ data, onSelectedBasinsChange }: TableBasinsProps) => {
  const [configDialog, setConfigDialog] = useState<{
    id: string;
    config: BasinConfig;
    location?: string;
  } | null>(null);
  const [similarDialog, setSimilarDialog] = useState<BasinInitialValues | null>(
    null
  );
  const [deleteDialog, setDeleteDialog] = useState<null | string[]>(null);
  const { getClient, route, Link, capabilities } = useDashboardHost();

  const fetchConfig = async (
    basinName: string
  ): Promise<BasinConfig | null> => {
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
      return await getBasinConfig(s2, basinName);
    } catch (err: unknown) {
      toast({
        title: 'Error fetching basin configuration',
        description: err instanceof S2Error ? err.message : undefined,
        variant: 'destructive',
      });
      return null;
    }
  };
  const { pathname } = route;
  const section = isDashboardSection(pathname, 'basins') ? 'basins' : 'metrics';

  const {
    selectedItems: selectedBasins,
    handleItemSelect: handleBasinSelect,
    handleSelectAll,
    getHeaderCheckboxState,
  } = useTableSelection(
    data
      .filter((basin) => !basin.deletedAt)
      .map((basin) => ({ id: basin.name })),
    onSelectedBasinsChange || (() => {})
  );

  return (
    <Fragment>
      <Table key={(data[0]?.name || 'empty') + data.length}>
        <TableHeader>
          <TableRow>
            {onSelectedBasinsChange && (
              <TableHead className="w-14 pl-0">
                <Checkbox
                  checked={getHeaderCheckboxState()}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all basins"
                  disabled={data.length === 0}
                />
              </TableHead>
            )}
            <TableHead className={onSelectedBasinsChange ? '' : 'pl-0'}>
              Name
            </TableHead>
            <TableHead>State</TableHead>
            {capabilities.locations && <TableHead>Location</TableHead>}
            <TableHead className="w-10 pr-0"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((basin) => {
            const stateLabel = getBasinStateLabel(basin);
            const isDeleting = stateLabel === 'deleting';

            return (
              <TableRow
                key={basin.name}
                // The selected basin's wash is drawn from `--foreground` rather than white, so it
                // reads in the light theme too.
                className={clsx(
                  route.basinId === basin.name &&
                    'via-foreground/[0.05] bg-linear-to-r from-transparent via-10% to-transparent'
                )}
                animate={{
                  opacity:
                    route.basinId === basin.name || !route.basinId ? 1 : 0.4,
                }}
                whileHover={{ opacity: 1 }}
              >
                {onSelectedBasinsChange && (
                  <TableCell className="w-14 pt-3 pl-0">
                    <Checkbox
                      checked={selectedBasins.has(basin.name)}
                      onCheckedChange={(checked) => {
                        handleBasinSelect(basin.name, !!checked);
                      }}
                      aria-label={`Select basin ${basin.name}`}
                      disabled={isDeleting}
                    />
                  </TableCell>
                )}
                <TableCell
                  className={clsx(
                    'h-[57px]',
                    onSelectedBasinsChange ? '' : 'pl-0'
                  )}
                >
                  <motion.span layout className="inline-block">
                    {!isDeleting ? (
                      <Link
                        href={
                          route.basinId === basin.name
                            ? `/dashboard/${section}`
                            : `/dashboard/${section}/${basin.name}`
                        }
                        className="group relative flex items-center"
                        scroll={false}
                      >
                        {basin.name}{' '}
                        {route.basinId !== basin.name && (
                          <ChevronRight
                            size={12}
                            className="pointer-events-none absolute -right-5 opacity-40 transition-[transform,opacity] duration-200 group-hover:translate-x-1 group-hover:opacity-100"
                          />
                        )}
                      </Link>
                    ) : (
                      basin.name
                    )}
                  </motion.span>
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded-full px-2 py-1 text-xs capitalize ${
                      isDeleting
                        ? 'dark:bg-muted opacity-40'
                        : 'border font-semibold'
                    }`}
                  >
                    {stateLabel}
                  </span>
                </TableCell>
                {capabilities.locations && (
                  <TableCell className="text-nowrap">
                    {basin.location ?? 'unspecified'}
                  </TableCell>
                )}
                <TableCell className="pr-0 pl-2">
                  {!isDeleting && (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="w-10" size="icon">
                          <Ellipsis />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={async () => {
                            const config = await fetchConfig(basin.name);
                            if (config === null) return;
                            setConfigDialog({
                              id: basin.name,
                              config,
                              location: basin.location ?? undefined,
                            });
                          }}
                        >
                          <Settings2 className="h-4 w-4" />
                          Edit configuration
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            const config = await fetchConfig(basin.name);
                            if (config === null) return;
                            setSimilarDialog({
                              source: basin.name,
                              config,
                              location: basin.location ?? undefined,
                            });
                          }}
                        >
                          <Copy className="h-4 w-4" />
                          Create similar basin
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive dark:text-red-400 dark:focus:text-red-400"
                          onClick={() => {
                            setDeleteDialog([basin.name]);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete basin
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {configDialog && (
        <CreateEditBasinDialog
          data={configDialog}
          onClose={() => {
            setConfigDialog(null);
          }}
        />
      )}
      {similarDialog && (
        <CreateEditBasinDialog
          data={null}
          initialValues={similarDialog}
          onClose={() => {
            setSimilarDialog(null);
          }}
        />
      )}
      {deleteDialog && (
        <DeleteBasinDialog
          ids={deleteDialog}
          onClose={() => {
            setDeleteDialog(null);
          }}
        />
      )}
    </Fragment>
  );
};

export default TableBasins;
