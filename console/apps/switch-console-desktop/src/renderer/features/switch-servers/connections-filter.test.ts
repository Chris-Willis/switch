import { describe, expect, it } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { connectionMonogram, filterConnections } from './connections-filter';

function entry(name: string, category: string): ConnectionCatalogEntry {
  return {
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    category,
    description: `${name} access.`,
    enabled: false,
    auth_type: 'oauth',
    status: 'coming_soon',
  };
}

const catalog = [
  entry('GitHub', 'Source control'),
  entry('GitLab', 'Source control'),
  entry('Jira', 'Project management'),
  entry('Datadog', 'Observability'),
];

describe('filtering the connections grid', () => {
  it('shows every connection for an empty or blank query', () => {
    expect(filterConnections(catalog, '')).toEqual(catalog);
    expect(filterConnections(catalog, '   ')).toEqual(catalog);
  });

  it('matches the name case-insensitively', () => {
    expect(filterConnections(catalog, 'git').map((c) => c.name)).toEqual(['GitHub', 'GitLab']);
    expect(filterConnections(catalog, ' JIRA ').map((c) => c.name)).toEqual(['Jira']);
  });

  it('matches the category', () => {
    expect(filterConnections(catalog, 'observ').map((c) => c.name)).toEqual(['Datadog']);
    expect(filterConnections(catalog, 'source').map((c) => c.name)).toEqual(['GitHub', 'GitLab']);
  });

  it('shows nothing when no name or category matches', () => {
    expect(filterConnections(catalog, 'salesforce')).toEqual([]);
  });
});

describe('the connection monogram', () => {
  it('uses the initials of the first two words', () => {
    expect(connectionMonogram('GitHub')).toBe('G');
    expect(connectionMonogram('Google Workspace')).toBe('GW');
    expect(connectionMonogram('Microsoft 365')).toBe('M3');
    expect(connectionMonogram('New Relic')).toBe('NR');
  });
});
