import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

export function filterConnections(
  connections: ConnectionCatalogEntry[],
  query: string
): ConnectionCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return connections;
  return connections.filter(
    (connection) =>
      connection.name.toLocaleLowerCase().includes(needle) ||
      connection.category.toLocaleLowerCase().includes(needle)
  );
}

export function connectionMonogram(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase())
    .join('');
}
