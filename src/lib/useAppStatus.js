import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import { supabase } from '../api/supabase.js';

// The database version this build of the app expects (see schema_version() in
// supabase/migrations). Bump it together with every new migration.
export const REQUIRED_SCHEMA = '20261128000000';

/** Unread notifications for the signed-in user, kept live through Realtime. */
export function useUnreadCount(user) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['unread-count', user?.id],
    queryFn: () => apiRequest('/unread-count'),
    enabled: Boolean(user?.id),
    refetchInterval: 120_000, // fallback when Realtime is not enabled
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!user?.id || !supabase) return undefined;
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
      queryClient.invalidateQueries({ queryKey: ['module', 'notifications'] });
    };
    const channel = supabase.channel(`notifications-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, queryClient]);

  return Number(query.data) || 0;
}

/**
 * Compares the live database with what this build needs. Returns null when
 * everything is fine, otherwise a short explanation.
 */
export function useSchemaCheck(user) {
  const query = useQuery({
    queryKey: ['schema-version'],
    queryFn: () => apiRequest('/schema-version'),
    enabled: Boolean(user?.id),
    staleTime: Infinity,
    retry: false,
  });
  if (!user?.id || query.isLoading) return null;
  // A network hiccup is not an outdated database: only a missing function is.
  if (query.isError && !/schema_version|could not find the function/i.test(query.error?.message || '')) return null;
  const version = query.isError ? '' : String(query.data || '');
  if (version && version >= REQUIRED_SCHEMA) return null;
  return {
    current: version || 'older than 20261128000000',
    required: REQUIRED_SCHEMA,
  };
}
